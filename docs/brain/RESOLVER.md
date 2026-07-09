# RESOLVER — "if you need X, go here" (read this to avoid guessing)

> The routing table for the whole project. Find your need in the left column and go straight to the
> source. **Anti-hallucination rule:** answer from the targeted source (and cite it) or say you don't
> know and go check the code / the audit log. Never invent project history, decisions, or state.

| If you need… | Go to |
|---|---|
| **The whole picture / full context** (vision, ideas, architecture, decisions, current state) | [`/CONTEXT.md`](../../CONTEXT.md) — the master |
| **Where we are RIGHT NOW / what's next** | [`STATE.md`](STATE.md) (canonical current state) |
| **The standing morning-briefing** (narrative of everything imagined / built / left / pipeline) | [`PROGRESS.md`](PROGRESS.md) |
| **What happened in a past session, or an exact past ask** | [`AUDIT_LOG.md`](AUDIT_LOG.md) (T1–T25, append-only) — the fallback source |
| **Is our security/authorization/isolation model sound? how do the fences work? how does AI inherit them?** | [`/docs/strategy/security-model.md`](../strategy/security-model.md) |
| **The security audit findings + remediation plan** (RBAC/ABAC/scope/RLS/agent/memory gaps) | [`/docs/strategy/security-findings.md`](../strategy/security-findings.md) |
| **Making route policies data-driven** (generic DB-backed ABAC policy loader + the PIP) | [`/docs/strategy/abac-generalization.md`](../strategy/abac-generalization.md) |
| **How agent memory works** (the Wayfinder port: tools, tiers, supersede, mem0 extraction) | [`designs/agent-memory.md`](designs/agent-memory.md) |
| **Standing rules / how the founder wants work done** | [`instructions/README.md`](instructions/README.md) |
| **A decision + its rationale, or the open questions** | [`discussions/README.md`](discussions/README.md) (D1–D20, O1–O8) |
| **The architecture at a glance** (principle, four gates, contracts, stack, scale) | [`architectures/README.md`](architectures/README.md) |
| **An index of every design doc + its status** | [`designs/README.md`](designs/README.md) |
| **What to build FIRST / do-NOT-build-until** | [`/docs/strategy/red-team-consolidated.md`](../strategy/red-team-consolidated.md) |
| The modular pay-per-module design | [`/docs/strategy/modular-platform-plan.md`](../strategy/modular-platform-plan.md) |
| The agentic-first + high-scale + NoOps + compliance design | [`/docs/strategy/agentic-platform-design.md`](../strategy/agentic-platform-design.md) |
| AI-in-the-root-of-every-module (the module contract) | [`/docs/strategy/ai-native-core.md`](../strategy/ai-native-core.md) (§0.5/§8 authoritative) |
| Autonomous capabilities · per-role RBAC/ABAC flows · the danger layer · operational flows | [`/docs/strategy/agentic-operations.md`](../strategy/agentic-operations.md) (§0/§6 = red-team corrections) |
| The omniscient debug/data agent | [`/docs/strategy/platform-omniscience.md`](../strategy/platform-omniscience.md) |
| Is TS/Node enough? polyglot + algorithms | [`/docs/strategy/stack-sufficiency.md`](../strategy/stack-sufficiency.md) |
| The two brains (dev + app) design | [`/docs/strategy/knowledge-brain.md`](../strategy/knowledge-brain.md) |
| The AR management ecosystem protocol | [`/docs/strategy/ecosystem-ar-protocol.md`](../strategy/ecosystem-ar-protocol.md) |
| The agentify / AI-policing products | [`/docs/strategy/agentify-and-policing.md`](../strategy/agentify-and-policing.md) |
| YC positioning + the honest fundability verdict | [`/docs/strategy/yc-rfs-fit.md`](../strategy/yc-rfs-fit.md) |
| **The CURRENT SHIPPED CODE** — spec / how to run+test / build tracker | [`/SPEC.md`](../../SPEC.md) · [`/HANDOFF.md`](../../HANDOFF.md) · [`/IMPLEMENTATION_PLAN.md`](../../IMPLEMENTATION_PLAN.md) |
| **The agentic keystone code** (tool-registry generator) | `libs/ai-core/` + `libs/service-core/src/bootstrap/route-metadata.ts` |
| A per-service deep-dive (built code) | `docs/services/<service>.md` |
| Reference repos to lift patterns/code from | [`/CONTEXT.md`](../../CONTEXT.md) §15 |
| "How do I do X in the codebase?" | grep the code first; then `SPEC.md` / the per-service docs; the agent tool registry (`libs/ai-core`) is the machine-readable capability map |

**Update protocol (every agent):** append a session entry to `AUDIT_LOG.md`; record decisions in
`discussions/`; refresh `STATE.md`; keep `/CONTEXT.md` consistent when the vision moves. Targeted docs
first; audit log only as fallback.
