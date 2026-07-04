# Architecture Atlas — the load-bearing structures, in one place

> The durable architectural truths an implementing agent needs. Points to the full designs in
> [`../../strategy/`](../../strategy/) for depth. If code and this doc disagree, the code wins for the
> *current substrate* ([`../../../SPEC.md`](../../../SPEC.md)); this doc + the strategy docs win for the
> *target vision*.

## The one principle
**The agent reasons; the governed core acts.** LLM plans / converses / retrieves / *proposes*; every
state change runs through `authenticate → authorize(PEP/Casbin) → withTenantTransaction (RLS) → audit` —
the same path a human API call hits. The agent is a new **principal** + **interface**, never a bypass.

## The two planes
- **Reasoning plane (probabilistic, at the EDGE):** orchestrator + specialist subagents, intent, plans,
  retrieval, proposals, generative UI, self-knowledge answers. Never authoritative.
- **Governed core (deterministic):** the existing services + libs. The only thing that mutates state.
  Enforces authz, tenancy, tiers, thresholds, referent re-validation, principal derivation.

## The four gates (every action passes all four)
1. **Authorization** — PEP: role × ABAC attributes × module entitlement. The tool list handed to the
   model is filtered by this *before the model sees it* → the agent can't attempt what the user can't do.
2. **Danger** — orthogonal to authz ("allowed, but risky"): deterministic score (verb + count + amount +
   resource-class + regulatory impact) + behavioral-anomaly signal → graduated response (inline confirm →
   typed confirmation → step-up MFA/passkey → cooling-off + undo → mandatory second approver → alert
   owner/security → soft-block). Fires even with full permission.
3. **Autonomy** — may the AI act unattended? Reversible + deterministically-verifiable = act-then-log;
   irreversible / money / cross-tenant / novel = propose-only (human via `@aegis/approvals`).
4. **Verifiability** — trust the result only if deterministically re-checkable OR independently verified
   by a second agent (proposer ≠ verifier; agent SoD) OR sampled + human-audited. Everything on the
   hash-chained ledger with a show-your-work trace.
Effective gate = **AuthZ ∧ Danger ∧ Autonomy ∧ Verifiability**. (Full composition + worked example:
[`agentic-operations.md`](../../strategy/agentic-operations.md).)

## The AI-Native Module Contract (minimal viable — D7)
Every module inherits, by construction:
- **Tools** — auto-generated from the governed routes (route-walk + Joi→JSON-Schema + `Permission`),
  authz-bound, entitlement-filtered. *(net-new generator: `pep-assertion.ts` extracts only method+path
  today; `joi-to-json` not yet a dependency — this is the keystone build.)*
- **Risk tier** per tool (defaulted from HTTP verb; money/irreversible ⇒ Tier 4 mandatory approval).
- **Eval gate** required only for Tier ≥ 2 (write) tools before autonomous action.
- Context, intents, triggers, generative-UI, knowledge, module rails = **opt-in**.
- CI gate `validateAiManifest()` enforces governance-on-declared-tools (not completeness-of-nine).
Full spec: [`ai-native-core.md`](../../strategy/ai-native-core.md) §0.5 + §8 (authoritative over §2).

## Self-sustainability / auto-growth (D15)
New route/module → tool auto-generated → capability manifest regenerated → brain + self-knowledge RAG
updated → CI drift gate (Wayfinder `CapabilityManifest.Validate()` pattern) fails the build if a
capability lacks description/tier. **No manual AI wiring for new functionality — ever.**

## The substrate (already built — `SPEC.md` authoritative)
Postgres RLS (`withTenantTransaction`, non-owner role) · Casbin RBAC/ABAC PEP/PDP/PAP (runtime-mutable
via `applyPolicyGrant` + cross-pod watcher) · hash-chained audit ledger (permissions-at-time-of-action) ·
`@aegis/approvals` (maker-checker/SoD/quorum) · rules-as-data workflow engine (`runRule(dryRun)` propose
mode) · Kafka events + transactional outbox · connector framework · per-tenant entitlement/feature-flags.

## The AI substrate (target — `@aegis/ai-core`)
Orchestrator · tool registry (generated) · context assembler · capability manifest · LLM gateway
(LiteLLM, per-tenant budgets) · eval harness (Langfuse + Promptfoo) · memory/RAG (pgvector, per-tenant,
RLS-scoped) · guardrails · tool-loop runner. Shared lib, analog to how access-control/db/events are
shared today. Design: [`ai-native-core.md`](../../strategy/ai-native-core.md) §6.

## Scale posture (targets)
Authz: Casbin → +OpenFGA at 100k. Data: RLS single-node → replicas → Citus shard-by-tenant. Connections:
PgBouncer transaction pooling (`SET LOCAL` only). Events: partition by tenant + repartition/balanced
batch. LLM: gateway + prompt caching + model cascade + per-tenant token budgets + circuit breakers. RAG:
pgvector partitioned by tenant → Pinecone namespace-per-tenant for whales. Detail:
[`agentic-platform-design.md`](../../strategy/agentic-platform-design.md) §E.

## Stack (spine + polyglot seams)
TS/Node Nx monorepo is the spine. Non-TS workers (if any — see
[`stack-sufficiency.md`](../../strategy/stack-sufficiency.md) when ready) plug in via language-agnostic
seams (HTTP / Kafka / MCP / gRPC) and NEVER touch the DB directly — they go through RLS-scoped APIs with
service tokens so tenancy/authz still hold.

## Ops (NoOps target)
GitOps (Argo CD selfHeal, Git = only write path to prod) · Kyverno admission (mutate injects
probes/limits/telemetry; verifies signatures) · KEDA scale-to-zero on Kafka lag · Argo Rollouts SLO-gated
auto-rollback · AI SRE agent (propose-then-act within bounds) · CloudNativePG (failover/PITR). Detail:
[`agentic-platform-design.md`](../../strategy/agentic-platform-design.md) §F.
