# Aegis Security Findings Register (T25 audit)

> **Source.** A multi-agent security audit (T25) over four fence dimensions — row-scope on
> human/API routes, the agent tool-calling path, memory isolation, and ABAC attribute enforcement —
> with **every finding adversarially verified** by an independent agent that tried to refute it
> against the actual code (and the live DB). Companion: [`security-model.md`](security-model.md) (how
> the fences work + the 30 verified *guarantees*).
>
> **Headline.** The **tenant fence is intact** (no cross-tenant finding survived verification — see
> §"Refuted"). Every confirmed finding is **within-tenant**: cross-user / cross-team / money-cap /
> memory. **16 findings confirmed** (`confirmed` = attack reproduces; `partially-true` = real defect,
> narrower than first stated). One root cause — the **missing PIP** (`principal.attributes` never
> populated at login) — drives the whole attribute-dependent class.
>
> **Status legend.** 🔴 open · 🟡 open (latent/lower-risk) · ✅ fixed. All are 🔴/🟡 as of T25.

---

## Answer to the founding question

> *"If a user tries to fetch an expense report for a different team, does it throw?"*

- **Expense *report* single-resource routes: yes, denied** (fail-closed to owner-only via
  `loadReportResource` → `checkRowScope`). ✅ enforced.
- **Invoice routes, pay-run routes, `GET /expenses/:id` (single item), and the expense *list*: NO
  reliable team fence** — SCOPE-01/02/03 + ROWSCOPE-03. 🔴 This is exactly the bug class you probed.
- **`own_and_team` itself is inert** (SCOPE-04): it silently degrades because `teamIds` is never in
  the token — so a manager can't see their legitimate team's records (over-restrictive), and on the
  expense list the role-name heuristic can over-expose.

So the honest answer is **"only on the expense-report routes, and even there the *team* half doesn't
actually work yet."** The fix is the PIP (ABAC Phase 2) + per-service scope wiring.

---

## Confirmed findings

### 🔴 HIGH

#### SCOPE-01 — Invoice routes have no row-scope fence
Any user with `invoice.view` reads **every** invoice in the tenant (single `GET /invoices/:id` and
the list). `authorize(InvoiceView)` is called with no resource loader, so `pep.ts:275`
(`if (resource || policies.length)`) is false and the entire `checkRowScope`/PDP layer is skipped;
the service does a tenant-only (RLS) read with no owner predicate.
*Evidence:* `apps/invoice/src/controllers/invoice.controller.ts:42,73`; `invoice.service.ts:397-414`;
`invoice.repository.ts:31-55`; `pep.ts:273-290`.
*Fix:* add a resource loader (`ownerId`=created_by, `teamId`=team_id) to the `:id` routes + a
scope-derived submitter filter to `list` (mirror expense's `rowScopeSubmitterFilter`) — or make
invoices explicitly tenant-visible behind a distinct all-records permission.

#### SCOPE-02 — Pay-run routes have no row-scope fence
Any user with `payroll.run.approve` reads every pay run in the tenant (single GET + list). Same
mechanism as SCOPE-01 (no resource loader → PDP/scope skipped; list applies only client-chosen
filters). *Evidence:* `apps/payroll/src/controllers/pay-run.controller.ts:32-47,145-153`;
`pay-run.service.ts:137-150`; `pay-run.repository.ts:28-57`.
*Fix:* attach a resource loader to the `:id` routes; derive the list filter from the principal's
scope/role. (Note: pay-runs are somewhat tenant-level objects; confirm the product intent — but
today the scope claim is simply never consulted.)

#### SCOPE-03 — `GET /expenses/:id` (single item) skips the scope check
Inconsistent with the sibling report routes: a contributor (`own_only`) can read another user's
expense line (amount, merchant, receipt) by id, because this route has no resource loader while the
report routes do. *Evidence:* `apps/expense/src/controllers/expense.controller.ts:27-35`;
`expense.service.ts:163-169`; contrast `expense-report.controller.ts:267`.
*Fix:* add a resource loader that surfaces the item's `created_by` (+ its report's submitter/team)
so `checkRowScope` runs.

#### ROWSCOPE-03 / (expense list) — list scope derived from ROLE NAMES, not `principal.scope`
An own-scoped Manager/Approver sees **all** reports because the expense list branches on role names
rather than the signed scope claim. (Confirmed in the earlier verify batch; same root as SCOPE-04's
list over-exposure.) *Fix:* drive the list filter from `principal.scope` + team membership, not role
name.

#### AGENT-02 — The "agent cannot self-confirm at level ≥ 2" guarantee is dead code
The §3.4 escalation to a human `second_approver` fires only when `ctx.isAgent` is true — but **no
production path ever sets `isAgent`** (`agent-orchestrator.ts:234-236`, `ai-act.controller.ts:56`,
`mcp-tool-server.ts:235` all omit it; only a unit test sets it). So a level-2 (`typed_confirm`) or
level-3 (`step_up`) agent write on a **reversible** blast is gated only by a ceremony the agent's own
client can satisfy — `{confirmed:true}`, or the `typedConfirmationPhrase` that the propose response
literally handed it back — with **no human**. (Material money/irreversible writes are still caught by
the verifier; the hole is non-material bulk/reversible writes.)
*Evidence:* `danger-policy.ts:197-202`; `supervised-write.ts:102-129`; `mcp-tool-server.ts:247-248`.
*Fix:* set `isAgent: true` on every agent-initiated gate context; treat human ceremony evidence as
valid only when it comes from the human ceremony surface (a signed/step-up-bound token), not from the
same agent request that proposed the action.

#### AGENT-03 — Built-in memory tools execute writes with NO authorization concept
`memory_remember`/`memory_forget` run **in-process** (never over a guarded route), so no permission
is ever checked — their descriptor carries `permissions: []`, and the only gate is the danger gate
(which classifies them tier-2 → allow+log). The store is RLS-scoped to **tenant only** (no
`user_id`), so any user in a tenant can `memory_forget{subject}` and soft-invalidate **every** user's
memory with that subject, or overwrite a supersession subject others rely on — poisoning what the
agent recalls for everyone. Verified live: the exact `invalidateBySubject` UPDATE as a second user
invalidated **both** users' rows. *Evidence:* `agent-orchestrator.ts:148-163,176,264-282`;
`app-brain.repository.ts:76,221-234`; live DB (no `user_id` column).
*Fix:* add an `owner_user_id` column + per-user scoping to `app_brain_memory` (or explicitly document
tenant-shared memory as intended and gate `forgetBySubject` to the owner); give built-in write tools
an explicit capability check before `execute()` — "no route" must not mean "no authorization."

#### ABAC-01 — Approval amount cap is silently inert on the money path
`amountCapPolicies` reads `principal.attributes.approvalLimit`, which is **never populated** (no
issuer writes `attributes`; the `AttributeReadPort` PIP exists but has **zero callers**). So the
loader returns `[]`, the PDP has no deny to apply, and **an approver with the RBAC approve permission
can approve any amount.** Verified against `auth.service.ts:54-61`, `pep.ts:54-61`,
`policy-loader.ts:65-77`, and the live DB (no limit column, 0 policy rows).
*Fix:* ship the PIP so `authenticate()` populates `approvalLimit` via `getAttributeReadPort()` — or
move the cap to a server-side per-tenant config the PDP reads. (This is ABAC Phase 2.)

#### AGENT-01 — Propose→confirm does not bind the confirmer to the proposer *(partially-true)*
The `/_ai/act/:id/confirm` handler reads only the pending id + `evidence` and never checks
`req.principal` against the proposer; `PendingAction` has no proposer field. So **any authenticated
caller who obtains a pending id can trigger someone else's staged write** — it executes with the
*proposer's* stored token. *Narrowed by verification:* it does **not** cross tenants (the stored
token re-checks token↔tenant) and does **not** defeat true `second_approver` SoD or material writes
(the verifier still refuses those); the real exploit is early-triggering another user's **non-material
reversible** confirm/typed_confirm/step_up write. *Evidence:* `ai-act.controller.ts:62-70`;
`supervised-action-broker.ts:40-47,171-191`; `supervised-write.ts:278`.
*Fix:* store `userId`+`tenantId` on the pending action; require the confirmer to match (or, for SoD,
to be a *different* user in the same tenant), and never execute with the proposer's token for a
different confirmer without an explicit delegation check.

#### AGENT-04 — Money cap unenforced for agent writes *(partially-true)*
Claim 1 (the `approvalLimit` cap is inert on the agent path) is **confirmed** — same root as ABAC-01.
Claim 2 (a mis-named money arg → "low danger → auto-execute") is **refuted**: any write has
verbClass create/update/delete → destructiveness ≥ 1 → level ≥ 1 → ceremony ≥ `confirm` (never
`allow`), so it never auto-executes; the worst impact of the `amount`/`amountMinor` arg-name
dependency (`derive-danger-facts.ts:89`) is a *lower friction tier*, and only if the route also omits
its `riskTier` (which the registry validator flags).
*Fix:* PIP for the cap; derive the money field from the tool manifest, not a hardcoded arg-name.

### 🟡 MEDIUM

#### AGENT-05 — Confirm/execute trusts the stored danger decision (TOCTOU)
`confirm` hands the **stored** decision to `executeSupervisedWrite`, which re-derives facts only to
pick the verification blast — it never re-runs `evaluateActionGate` against a fresh pre-flight
`COUNT(*)`. The code's own doc-comments (`danger-gate.ts:22-27`, `derive-danger-facts.ts:14-18`) say
the gate **must** be re-run at execute time because a count/rows drift voids the challenge. So a write
proposed as 1-row (light ceremony) can execute after the underlying set grows to thousands.
*Fix:* re-derive against the live tenant transaction + re-run the gate at confirm; void the challenge
if the recomputed decision is stricter.

#### AGENT-06 — Pending-action store key is global (no tenant/user namespace)
Redis key is `${prefix}:pending:${id}` with no tenant/user segment, and the default expense wiring
shares **one** in-memory `Map` across all tenants; `get()` can't scope to the caller's tenant even if
confirm wanted to. Combined with AGENT-01, a leaked/guessed id is a cross-tenant *trigger* handle
(ids are `randomUUID` today, so leak-only, not guessable). *Fix:* namespace keys by
`tenant:(user):id` and require the caller's tenant on `get()`.

#### MEM-02 — Cross-user supersession blast radius
`memory_remember` accepts a caller-chosen supersession `subject` scoped to the tenant, not the user —
user B can silently overwrite/erase user A's fact. (Same root as AGENT-03.) *Fix:* scope supersede /
`forgetBySubject` to `(tenant, owner_user_id)` once the owner column exists.

#### MEM-03 — No user provenance on memory writes (audit gap)
No `created_by`/`updated_by` recorded on any memory write — impossible to attribute who stored /
updated / forgot a fact, inconsistent with the platform's hash-chained audit elsewhere. *Fix:* record
`RequestContext.userId()` on every remember/supersede/forget.

#### SCOPE-04 — `own_and_team` collapses to owner-only *(partially-true)*
Both sides of the team check are dead: login never sets `attributes.teamIds` **and** resource loaders
never set `ResourceRef.teamId`. Today this is **fail-closed** (a teammate's row is *denied* — no data
exposure), but the intended team-visibility feature is broken, and it's a latent two-sided mis-auth
risk if one side is wired without the other. *Fix:* PIP populates `teamIds`; every loader sets
`teamId`; add a test asserting current owner-only behavior.

#### SCOPE-05 — Missing scope claim fails OPEN *(partially-true)*
`checkRowScope` returns `{ok:true}` when `scope == null`. Not exploitable today (the DB column is
`NOT NULL DEFAULT 'own_only'` with a CHECK, and the single IdP always emits it), but it's a
fail-*open* fragility with no RLS backstop — the opposite of the surrounding posture. *Fix:* treat
missing scope as `own_only` (fail-closed) and require the claim at `authenticate()`.

#### MEM-04 — Conversation isolation relies on an unvalidated `sessionId` *(partially-true)*
History is keyed `tenant:session` with no user binding; safe in today's in-process flows, but any
future HTTP surface that trusts a client-supplied `sessionId` would leak another same-tenant user's
transcript. *Fix:* fold `userId` into the session key, or validate session ownership on every access.

#### ABAC-02 — `manager_of` operator is permanently false
Any persisted/future policy using `manager_of` silently never matches (same PIP dependency —
`managerOf` is never populated; note a source **does** exist: `approval_hierarchy.manager_id`).
Once `AEGIS_ABAC_DB_POLICIES=on`, a tenant can author a `manager_of` policy that passes the mapper's
operator whitelist and loads, but always evaluates false — a **deny** never fires (fails open on the
money path). *Fix:* PIP populates `managerOf` from `approval_hierarchy`; **until then, reject
`manager_of` (and any principal-attribute condition) at PAP write time** so tenants can't author a
silently-inert money-path rule.

### 🟡 LOW

#### ABAC-04 — PDP deny reason leaked to the client verbatim
The PDP deny reason flows through `ErrUtils.forbidden(decision.reason)` and the error middleware
returns it unredacted for 4xx. The amount-cap policy id embeds the limit
(`amount-cap:expense.report.approve:5000`), so once the PIP populates `approvalLimit`, an over-cap
approval returns `403 "denied by policy amount-cap:…:5000"` — disclosing the approver's personal cap;
DB-backed denials similarly leak the policy UUID. *Fix:* return a generic `"denied by policy"` to the
client and log the detailed reason/policy id server-side, keyed by `correlationId` (mirror the 5xx
redaction the middleware already does). **Address this alongside shipping the PIP** — the leak only
becomes reachable once the cap actually fires.

### Audit completeness
All auditor + verifier agents across the T25 run completed. The finding set was **reproduced
consistently across independent re-runs** (labels vary between runs — `SCOPE-*`/`ROWSCOPE-*`, etc. —
but the substance is identical), which is a robustness signal: these are stable, real defects, not
run-to-run noise. MEM-01 (cross-user recall) is corroborated by AGENT-03 + MEM-02/03; one provenance
sub-claim was `refuted` in one run and `confirmed` in another (a labeling artifact) — treat provenance
(MEM-03) as a real low-stakes audit gap regardless.

---

## Refuted (guards exist — reassuring)

- **AGENT-2 (cross-tenant confirm):** a pending action **cannot** be confirmed/executed across
  tenants — the stored token is re-authenticated and `token.tenant_id` must equal the request tenant
  (`pep.ts:44-52`). The confirmer gap (AGENT-01) is real, but it does not breach tenant isolation.
- (Several sub-claims narrowed rather than refuted — captured inline as *partially-true* above.)

---

## Remediation plan (prioritized — most map to one root cause)

| Priority | Fixes | Effort | Mechanism |
|---|---|---|---|
| **P0** | ABAC-01, AGENT-04(cap), SCOPE-04, ABAC-02, MEM-01 root | Medium | **Ship the PIP (ABAC Phase 2)** — populate `principal.attributes` (`teamIds`/`approvalLimit`/`managerOf`) at `authenticate()` via the existing `AttributeReadPort`. One change closes the whole attribute-dependent class. |
| **P0** | SCOPE-01, SCOPE-02, SCOPE-03, ROWSCOPE-03 | Medium | Add resource loaders + scope-derived list filters to invoice, pay-run, single-expense, and the expense list. Consider a **lint/registry check** that flags any mutating/reading route on an owned resource that lacks a scope mechanism. |
| **P1** | AGENT-01, AGENT-06 | Small | Bind pending actions to `(tenantId, userId)`; namespace the store key; confirmer-must-match (or different-user for SoD). |
| **P1** | AGENT-02 | Small | Set `isAgent: true` on every agent gate context; require human ceremony evidence to originate from the human surface. |
| **P1** | AGENT-03, MEM-02, MEM-03 | Medium | `owner_user_id` column + per-user scoping on `app_brain_memory`; capability check on built-in write tools; record provenance. **Decide the product question:** tenant-shared "team brain" vs. per-user private memory (likely both, as a `kind`/scope flag). |
| **P2** | AGENT-05 | Medium | Re-run the danger gate against a live `COUNT(*)` at confirm/execute. |
| **P2** | SCOPE-05, MEM-04 | Small | Fail-closed on absent scope; server-authoritative session ownership. |

**Net:** the two P0 rows (the PIP + the per-service scope wiring) close **9 of the 16** findings and
answer the founding question directly. The ABAC Phase 0/1 foundation (mapper + ports + DB loader)
landed in T24/T25; the PIP is Phase 2 and is the highest-leverage next slice.

---

## Recommendations for the two open decisions (documented, not yet implemented)

Two fixes hinge on a product/architecture choice with no obvious default. Per the founder's
direction these are **documented with a recommendation, pending sign-off before any code**. Data
sources were checked against the live DB (T25).

### Decision 1 — where the approval amount-cap lives (unblocks ABAC-01 / AGENT-04)
There is **no** `approval_limit` column anywhere today (confirmed live), so the cap has no source.
Options and the trade-offs:

| Option | Granularity | New schema | Admin surface | Notes |
|---|---|---|---|---|
| **A. Column on `user_roles`** (`approval_limit_minor`) | Per role-assignment, per tenant, per user | 1 nullable column | Reuses the existing role-assignment surface (where `scope` already lives) | Most granular; the PIP reads it straight into `principal.attributes.approvalLimit` |
| B. Per-tenant config (role→limit map) | Per role (all holders share) | 1 small config/table | Needs a small config surface | Centralized, fewer rows; can't give two managers different caps |
| C. Persisted ABAC policy only | Per-tenant threshold on `resource.amount` | none (uses Phase-1 loader) | The PAP policy API | No *per-person* cap; a $5k and a $50k approver can't be distinguished |

**Recommendation: A (`approval_limit_minor` on `user_roles`)** — it's where `scope` already lives, it
is the most faithful to "this *person* in this *role* may approve up to X," and it drops straight into
the PIP with no new evaluation path. Pair it with C for tenant-wide ceiling policies (they compose:
deny-overrides means the stricter of the two wins). Avoid B unless the founder specifically wants a
single cap per role. **Also gate the info-leak (ABAC-04) in the same change** so the cap value isn't
echoed to clients.

### Decision 2 — the memory scoping model (unblocks AGENT-03 / MEM-02 / MEM-03 / MEM-01)
Today `app_brain_memory` is one shared **tenant** brain: any user in a tenant can recall, supersede,
or `forgetBySubject` another user's memories, with no owner column and no provenance.

| Option | Isolation | Work | Fits |
|---|---|---|---|
| **A. Both, via a scope flag** (`owner_user_id` + `scope ∈ {private, team}`, default `private`) | Per-user by default; opt-in tenant-shared | Medium (column + RLS/predicate + tool arg + `kind`/scope plumbing) | A personal assistant *and* shared org knowledge |
| B. Per-user private only | Strict per-user within tenant | Small–medium | Pure personal assistant; no team brain |
| C. Tenant-shared (keep) + provenance + owner-gated destructive ops | Org-wide readable by design | Small | "Team brain" where cross-user read is intended |

**Recommendation: A (both, scope-flagged, default private)** — it's the only option that doesn't
foreclose a direction: memories are private unless explicitly written as `team`, which matches how the
agent-memory tools are meant to be used (a user's own working memory vs. deliberately shared team
facts). It cleanly closes MEM-01/02/03 and AGENT-03 (per-user RLS predicate + owner-gated
`forgetBySubject` + `created_by`/`updated_by` provenance). B is a safe fallback if a team brain isn't
wanted yet; C is the minimum if cross-user reads are explicitly desired. Whichever is chosen, **give
the built-in memory write tools an explicit capability check** (AGENT-03) — "no guarded route" must
not mean "no authorization."

> **Nothing above is built yet.** These are recommendations for founder sign-off; the row-scope
> wiring (P0) and the PIP's `teamIds`/`managerOf` halves (which *do* have live data sources —
> `team_members`, `approval_hierarchy`) can proceed independently of these two decisions when the
> founder gives the go-ahead to implement.
