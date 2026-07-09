# Designs Index — every design doc, its status, and what it answers

> One row per design artifact. Statuses: **draft** → **researched+cited** (internet-first, sources
> inline) → **red-teamed** (adversarial critique folded in) → **final** (founder-accepted). ⏳ = an
> in-flight workflow is still producing/critiquing it. The strategy docs live in
> [`../../strategy/`](../../strategy/).
>
> **Implementation design docs (in THIS folder, describing shipped code):**
> - [`agent-memory.md`](agent-memory.md) — the agent-memory feature (the Wayfinder port): store
>   semantics (supersede/soft-invalidation/embedder-tag/minScore/profile-salient), the 3 memory tools,
>   tiered context, mem0 post-turn extraction, and the exact Wayfinder→Aegis mapping.
> - Security is documented in the strategy folder: [`../../strategy/security-model.md`](../../strategy/security-model.md)
>   + [`../../strategy/security-findings.md`](../../strategy/security-findings.md).

| Doc | Status | What it answers |
|---|---|---|
| [`modular-platform-plan.md`](../../strategy/modular-platform-plan.md) | red-teamed | The modular pay-per-module platform: module manifest, Entitlement Service (Chargebee), kernel-vs-modules, isolation & data extensibility, entitlement grant/revoke state machine, module data lifecycle, RLS-assurance gate, tenant migration, module catalog, build-vs-buy, roadmap. |
| [`agentic-platform-design.md`](../../strategy/agentic-platform-design.md) | red-teamed | Master agentic design §A–K: vision, end-to-end architecture, interaction layer (chat/voice/generative-UI), agent authz & safety, per-functionality scale tiers, autonomous ops (NoOps/AIOps), enterprise readiness & compliance, adoption catalog (OSS/licenses), pricing, roadmap, risks. |
| [`ai-native-core.md`](../../strategy/ai-native-core.md) | red-teamed (**§0.5/§8 supersede §2**) | AI-in-the-root-of-every-module: the AI-Native Module Contract (minimal viable: Tools + Risk-tier mandatory, eval gate for Tier≥2 writes, rest opt-in), per-capability application, module scaffold, `@aegis/ai-core` kernel, autonomous dev loop, migration. |
| [`yc-rfs-fit.md`](../../strategy/yc-rfs-fit.md) | red-teamed | YC Summer-2026 RFS category fit (lead: SaaS Challengers), unifying narrative, the wedge, partner objections, honest "not fundable without traction" verdict. |
| [`agentic-operations.md`](../../strategy/agentic-operations.md) | **red-teamed** (1.3k ln; **§0 + §6 corrections are binding**) | Autonomous AI agency + verifiability; agentic RBAC/ABAC + per-role flows; the danger/step-up layer (fires even with permission); ALL operational flows; §5 how the four gates compose. **Red-team verdict: strong B+, "C on trust-it-with-money-unattended" → ship read/propose-only for money/external/irreversible until the hardened Trust Rule (AND not OR; independent verifier; determinism≠correctness), the single-human-SMB fix, and GDPR-erasure-vs-ledger land in code (§0/§6).** |
| [`platform-omniscience.md`](../../strategy/platform-omniscience.md) | researched+cited → **red-teamed** (banner appended) | Omniscient debug/data agent: 3 planes (diagnostic read-only MCP fleet / remediation propose-PR+GitOps / governed NL→query+export); four gates per plane; **feasibility = yes, diagnostic ~90% assembly, fix stays propose-only**; auto-growth confirmed; CVE-2026-46519 credential lesson. |
| [`stack-sufficiency.md`](../../strategy/stack-sufficiency.md) | researched+cited → **red-teamed** (banner appended) | **TS/Node is enough for ~90%** (agent runtime, governed core, RAG, rerank, text-to-SQL, diff/patch); 4 algo families (entity-resolution, forecasting, online-anomaly, GraphRAG-index) = Python batch sidecars behind Kafka/HTTP (never touch DB/principal/authz); no Go/Rust service today (Rust via napi-rs only); never rewrite; migration triggers. |
| [`knowledge-brain.md`](../../strategy/knowledge-brain.md) | researched+cited → **red-teamed** (banner appended) | Dual brain: dev-process brain (this `docs/brain/` — validated as the design at t=0) + per-tenant app/platform brain (markdown-in-git → Postgres+pgvector, hybrid vector+BM25+RRF); externally validated by **GBrain** (Garry Tan/YC); "Blackboard.io RCLE" confirmed non-existent (means the blackboard pattern); anti-hallucination constitution + update protocol. |
| [`ecosystem-ar-protocol.md`](../../strategy/ecosystem-ar-protocol.md) | researched+cited → **red-teamed** (banner appended) | The **Aegis Ecosystem Protocol** = a *profile* over A2A (agent↔agent) + A2UI (UI-as-data) + AG-UI + MCP; Wayfinder as the AR management surface; four-gates↔A2A task-lifecycle mapping; the A2UI→Unity renderer is the main net-new piece (~5–6 wks); Quest step-up = phone-passkey WebAuthn concession; worked CEO-in-headset scenario. |
| [`agentify-and-policing.md`](../../strategy/agentify-and-policing.md) | researched+cited → **red-teamed** (banner appended) | Two products: **Aegis Warden** (AI-policing PEP gateway — lead first; enforcement+approvals+tamper-audit is an unoccupied niche vs observability-only rivals; EU AI Act Art.12 tailwind) + **Aegis Ignite** (agentify legacy systems). Market map (Zenity/Lasso/Prompt/CalypsoAI/AgentCore…), demand stats, pricing, ~80% already built, honest crowded-market risk. |

**Related non-design context docs:** [`../../../ONBOARDING.md`](../../../ONBOARDING.md) (narrative
onboarding) · [`../../../SPEC.md`](../../../SPEC.md) (authoritative spec of the *current built code*) ·
[`../../../IMPLEMENTATION_PLAN.md`](../../../IMPLEMENTATION_PLAN.md) (build tracker of the existing
substrate) · [`../../../HANDOFF.md`](../../../HANDOFF.md) (original access-control build handoff).

| [`red-team-consolidated.md`](../../strategy/red-team-consolidated.md) | **master (read before building)** | Cross-cutting synthesis of ALL nine strategy-doc red-teams: 6 recurring themes, a **16-item prioritized fix-before-build list** (severity × blast-radius, each tagged to docs), the **"build FIRST"** slice, and the **"do NOT build until X"** blocker table. This is the actionable engineering roadmap. |

> **All nine strategy docs have now been adversarially red-teamed** (the four "core" docs inline; the
> five T9 docs got correction banners + the consolidated synthesis above). **Meta-theme across every
> review:** RLS/tenant isolation is real for the live DB but is quietly re-established *weaker* on every
> derived plane (object-store extracts, the agent/audit ledger, hub aggregation, ANN retrieval,
> cross-tenant operators). Direction is right; safety-critical specs are not done. **Start from the
> `red-team-consolidated.md` "build FIRST" slice; honor its "do NOT build until X" table.**
