import { ApprovalShape } from '@aegis/shared-types';
import { ApproverType, ApproverSource } from '@aegis/shared-enums';

/**
 * The resolver contract: turn a policy + record context into an ordered set of approver slots that
 * the engine materialises into `record_approvers` rows. The foundation ships
 * {@link DefaultApproverResolver} (reads static `policy.config.levels`); the full
 * {@link PolicyApproverResolver} implements per-tenant policy resolution with amount thresholds
 * (W3-03), manager / manager-chain sources (W3-05), approver-group expansion + quorum (W3-04), and
 * mixed sequential/parallel levels (W3-08).
 */
export interface ApproverResolver {
  resolve(ctx: ApprovalShape.ResolveContext): Promise<ApprovalShape.ResolvedSlot[]>;
}

/**
 * Collaborator the resolver uses to walk the tenant reporting graph (W3-05). The
 * {@link HierarchyRepository} satisfies this; the resolver depends on the narrow port so it stays
 * testable without a DB.
 */
export interface HierarchyPort {
  managerOf(userId: string, t: unknown): Promise<string | null>;
  managerChain(userId: string, depth: number, t: unknown): Promise<string[]>;
}

/**
 * Collaborator the resolver uses to expand an approver group to its candidate user ids (W3-04). The
 * {@link ApproverGroupRepository} satisfies this.
 */
export interface GroupPort {
  expandUserMembers(groupId: string, t: unknown): Promise<string[]>;
}

/**
 * Default resolver: materialise the ordered approver slots declared in `policy.config.levels`.
 *
 * - A policy with a single level yields a one-gate chain (the donor's simplest case).
 * - A policy with several levels yields a multi-level chain ordered by `(level, sequence)`.
 * - When `policy.config.excludeRequester` is set, the requester is dropped from the chain
 *   (the SoD hook — an approver must not approve their own record). If that empties the chain the
 *   record is treated as having no required approvers (the engine completes it immediately).
 *
 * Levels are normalised so the engine always sees contiguous 1-based levels with a deterministic
 * per-level `sequence` — even if the policy author left gaps. This resolver only understands STATIC
 * (user/role/group-by-id) slots; the {@link PolicyApproverResolver} adds threshold/manager/group
 * expansion on top.
 */
export class DefaultApproverResolver implements ApproverResolver {
  async resolve(ctx: ApprovalShape.ResolveContext): Promise<ApprovalShape.ResolvedSlot[]> {
    const specs = (ctx.policy.config?.levels ?? []).slice();
    const excludeRequester = ctx.policy.config?.excludeRequester === true;

    // Filter out the requester (SoD) when configured, but only for user-typed slots.
    const kept = specs.filter(
      (s) =>
        !(
          excludeRequester &&
          slotApproverType(s) === ApproverType.User &&
          s.approver_id === ctx.requestedBy
        ),
    );

    // Order by declared (level, sequence) then renumber to contiguous 1-based levels so the engine's
    // sequential advance never stalls on a gap a policy author left.
    kept.sort((a, b) => a.level - b.level || (a.sequence ?? a.level) - (b.sequence ?? b.level));

    const slots: ApprovalShape.ResolvedSlot[] = [];
    let currentDeclaredLevel: number | null = null;
    let normalizedLevel = 0;
    let sequenceInLevel = 0;
    for (const s of kept) {
      if (s.level !== currentDeclaredLevel) {
        currentDeclaredLevel = s.level;
        normalizedLevel += 1;
        sequenceInLevel = 0;
      }
      sequenceInLevel += 1;
      slots.push({
        level: normalizedLevel,
        approver_type: slotApproverType(s),
        approver_id: s.approver_id ?? '',
        sequence: s.sequence ?? sequenceInLevel,
      });
    }
    return slots;
  }
}

/**
 * The full per-tenant policy resolver (W3-02..W3-08). For each configured level it:
 *  - W3-03 evaluates the level's amount-threshold gate against the record's `amountMinor` + currency
 *    and DROPS the level when it does not apply (a missing amount fails any lower-bound gate);
 *  - resolves the level's approver SOURCE into one or more concrete user/role slots:
 *     - `user` / `role`         → the single declared principal;
 *     - `group`  (W3-04)        → every user member of the group (ANY can clear, or `min_approvals`);
 *     - `manager` (W3-05)       → the requester's reporting manager (one edge up);
 *     - `manager_chain` (W3-05) → the requester's managers up to `depth`, one per slot;
 *  - applies the SoD `excludeRequester` hook (drops the requester from any resolved slot);
 *  - normalises surviving levels to contiguous 1-based levels.
 *
 * Mode + quorum (W3-08) are per-level concerns the ENGINE reads from the policy config; this resolver
 * is responsible only for producing the right SLOTS. Empty levels (a threshold that excluded them, or
 * a group/manager that resolved to nobody, or SoD removing the only candidate) are dropped.
 */
export class PolicyApproverResolver implements ApproverResolver {
  constructor(
    private readonly hierarchy: HierarchyPort,
    private readonly groups: GroupPort,
    /** The ambient RLS transaction the engine is running inside (threaded through to the ports). */
    private readonly tx: unknown,
  ) {}

  async resolve(ctx: ApprovalShape.ResolveContext): Promise<ApprovalShape.ResolvedSlot[]> {
    const specs = (ctx.policy.config?.levels ?? []).slice();
    const excludeRequester = ctx.policy.config?.excludeRequester === true;

    // Group level specs by their declared level number, preserving declaration order within a level.
    specs.sort((a, b) => a.level - b.level || (a.sequence ?? a.level) - (b.sequence ?? b.level));

    // Resolve each declared level into its candidate (approver_type, approver_id) pairs, applying
    // the threshold gate first so excluded levels never reach the chain.
    const resolvedLevels: Array<{ declaredLevel: number; candidates: Candidate[] }> = [];
    const byLevel = new Map<number, ApprovalShape.PolicyLevelSpec[]>();
    for (const s of specs) {
      const arr = byLevel.get(s.level) ?? [];
      arr.push(s);
      byLevel.set(s.level, arr);
    }

    for (const [declaredLevel, levelSpecs] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
      const candidates: Candidate[] = [];
      const seen = new Set<string>();
      for (const spec of levelSpecs) {
        if (!thresholdApplies(spec, ctx)) continue; // W3-03
        for (const c of await this.expandSpec(spec, ctx)) {
          // SoD: never place the requester on the chain when configured.
          if (excludeRequester && c.approver_type === ApproverType.User && c.approver_id === ctx.requestedBy) {
            continue;
          }
          // De-dup within a level (same user surfaced by two specs / a manager already named).
          const key = `${c.approver_type}:${c.approver_id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push(c);
        }
      }
      if (candidates.length > 0) resolvedLevels.push({ declaredLevel, candidates });
    }

    // Normalise to contiguous 1-based levels with a deterministic per-level sequence.
    const slots: ApprovalShape.ResolvedSlot[] = [];
    let normalizedLevel = 0;
    for (const { candidates } of resolvedLevels) {
      normalizedLevel += 1;
      let seq = 0;
      for (const c of candidates) {
        seq += 1;
        slots.push({
          level: normalizedLevel,
          approver_type: c.approver_type,
          approver_id: c.approver_id,
          sequence: seq,
        });
      }
    }
    return slots;
  }

  /** Expand one level spec into its concrete candidate approver slots per its source. */
  private async expandSpec(
    spec: ApprovalShape.PolicyLevelSpec,
    ctx: ApprovalShape.ResolveContext,
  ): Promise<Candidate[]> {
    const source = slotSource(spec);
    switch (source) {
      case ApproverSource.User:
        return spec.approver_id ? [{ approver_type: ApproverType.User, approver_id: spec.approver_id }] : [];
      case ApproverSource.Role:
        return spec.approver_id ? [{ approver_type: ApproverType.Role, approver_id: spec.approver_id }] : [];
      case ApproverSource.Group: {
        if (!spec.approver_id) return [];
        const members = await this.groups.expandUserMembers(spec.approver_id, this.tx);
        return members.map((id) => ({ approver_type: ApproverType.User, approver_id: id }));
      }
      case ApproverSource.Manager: {
        const manager = await this.hierarchy.managerOf(ctx.requestedBy, this.tx);
        return manager ? [{ approver_type: ApproverType.User, approver_id: manager }] : [];
      }
      case ApproverSource.ManagerChain: {
        const chain = await this.hierarchy.managerChain(ctx.requestedBy, spec.depth ?? 1, this.tx);
        return chain.map((id) => ({ approver_type: ApproverType.User, approver_id: id }));
      }
      default:
        return [];
    }
  }
}

interface Candidate {
  approver_type: ApproverType;
  approver_id: string;
}

/** The effective approver TYPE of a static slot — explicit `approver_type`, else inferred from source. */
function slotApproverType(spec: ApprovalShape.PolicyLevelSpec): ApproverType {
  if (spec.approver_type) return spec.approver_type;
  switch (spec.source) {
    case ApproverSource.Role:
      return ApproverType.Role;
    case ApproverSource.Group:
      return ApproverType.Group;
    default:
      return ApproverType.User;
  }
}

/** The effective SOURCE of a level — explicit `source`, else inferred from the legacy `approver_type`. */
function slotSource(spec: ApprovalShape.PolicyLevelSpec): ApproverSource {
  if (spec.source) return spec.source;
  switch (spec.approver_type) {
    case ApproverType.Role:
      return ApproverSource.Role;
    case ApproverType.Group:
      return ApproverSource.Group;
    default:
      return ApproverSource.User;
  }
}

/**
 * W3-03 amount-threshold gate: is this level included for the record's amount + currency?
 * - No bounds → always applies.
 * - A `currency` bound that does not match the record's currency → excluded.
 * - `amountMinorMin` set with no record amount → excluded (conservatively skip a threshold level when
 *   the amount is unknown). `amountMinorMax` alone with no amount → applies (no lower gate).
 * - Otherwise included iff `amount >= min` (when set) AND `amount < max` (when set).
 */
export function thresholdApplies(
  spec: ApprovalShape.PolicyLevelSpec,
  ctx: ApprovalShape.ResolveContext,
): boolean {
  const hasMin = spec.amountMinorMin !== undefined;
  const hasMax = spec.amountMinorMax !== undefined;
  if (!hasMin && !hasMax && spec.currency === undefined) return true;

  if (spec.currency !== undefined && ctx.currency !== spec.currency) return false;

  const amount = ctx.amountMinor;
  if (amount === undefined) {
    // Unknown amount: a lower-bound (senior-tier) gate is conservatively excluded.
    return !hasMin;
  }
  // BUG-0007: compare in BigInt minor units so amounts beyond Number.MAX_SAFE_INTEGER (and
  // string-encoded BIGINT/NUMERIC values from the driver) route to the correct threshold level,
  // instead of being flattened by a lossy Number() coercion.
  const amt = toBigIntMinor(amount);
  if (hasMin && amt < toBigIntMinor(spec.amountMinorMin as ApprovalShape.MinorAmount)) return false;
  if (hasMax && amt >= toBigIntMinor(spec.amountMinorMax as ApprovalShape.MinorAmount)) return false;
  return true;
}

/**
 * Coerce a {@link ApprovalShape.MinorAmount} (bigint | string | number) to a `bigint` of minor units
 * for lossless threshold comparison (BUG-0007). A `number` is truncated to its integer part (minor
 * units are integers); a `string` is parsed tolerantly (whitespace, a leading sign, and an
 * accidental fractional tail are stripped — only the integer minor-unit portion is significant).
 */
function toBigIntMinor(value: ApprovalShape.MinorAmount): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0n;
    return BigInt(Math.trunc(value));
  }
  const trimmed = value.trim();
  // Keep an optional leading sign + the integer portion before any decimal point.
  const match = /^[+-]?\d+/.exec(trimmed);
  return match ? BigInt(match[0]) : 0n;
}
