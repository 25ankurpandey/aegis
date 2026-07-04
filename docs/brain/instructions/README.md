# Standing Instructions — the project constitution

> Directives from the founder (Ankur) that apply to ALL work on this project, standing until revoked.
> Check here FIRST before deciding how to work. Each has the audit-log entry that established it.

## Product principles (what we are building)

1. **Agentic-first.** The agent IS the interface: users do and learn everything by typing or talking.
   Chat/voice/generative-UI primary; classic screens augment, never gate. *(T4)*
2. **No human sales, support, or CS teams; minimal-to-no human ops.** Fully self-serve onboarding,
   buying, support; autonomous operations. Honest bound: "AI proposes, humans decide" for
   novel/irreversible/cross-tenant; a thin, bounded human escalation path exists (the Klarna lesson). *(T4, T5)*
3. **AI-first from the root.** Agentic capability is a structural property of EVERY module (current and
   future), not a bolt-on — via the minimal AI-Native Module Contract (Tools + Risk-tier mandatory;
   eval gate for autonomous writes; other facets opt-in). *(T7)*
4. **Self-sustaining / auto-growing.** New functionality/modules MUST auto-integrate into the AI flows
   with ZERO manual setup — tools auto-generate from governed routes; manifests/capability docs are
   generated, drift-gated in CI, never hand-maintained. *(T9)*
5. **Modular, pay-per-module, multi-industry.** Tenants enable only what they need and pay only for
   that. *(T2)*
6. **Governance is the substrate, never bypassed:** "the agent reasons; the governed core acts." Every
   state change passes authenticate → authorize(PEP) → RLS → audit — same path as a human call. The LLM
   never decides authz, never carries principal/tenant/permission. *(T4, T7)*
7. **Dangerous actions get confirmation/step-up even WITH permission** — the danger axis is orthogonal
   to authorization. *(T8)*
8. **Autonomous results must be verifiable:** deterministically re-checkable OR independently verified
   (second agent; proposer ≠ verifier) OR sampled + audited. Otherwise: propose-only. *(T8)*
9. **Don't shy from complex algorithms** (advanced RAG, entity resolution, anomaly detection) where they
   make the product smoother — but pick the right runtime for them (see stack-sufficiency doc). *(T9)*

## Working-method rules (how agents must work here)

10. **Research the internet FIRST** — GitHub repos, official docs, forums, articles — find reusable
    projects/inspiration before designing from scratch. Cite sources. *(T5, T9)*
11. **Ultracode mode:** substantive research/design runs as multi-agent workflows with adversarial
    verification and a red-team pass. Volatile claims (pricing, licenses, timelines) get verified. *(all)*
12. **NO implementation until the founder says so.** Output dense, implementation-ready, GAP-FREE docs
    that other agents can build from without asking questions. *(T9)*
13. **Document everything.** Every research/design/architecture output lands in `docs/strategy/`;
    every session appends to the brain's `AUDIT_LOG.md`; decisions go to `discussions/`; keep
    `ONBOARDING.md` + the brain's Current State fresh. *(T5, T9)*
14. **Brain navigation:** targeted docs first (instructions/designs/discussions/architectures), audit
    log only as fallback. Cite-or-abstain; never invent history. *(T9)*
15. **Honesty over flattery:** keep the real state visible (e.g. "agent layer designed, not shipped";
    "no customers yet"). Red-team verdicts are preserved verbatim, not softened. *(T6, T7)*
16. **License discipline** for the owned/self-host mandate: avoid BUSL/SSPL/AGPL traps (Terraform→
    OpenTofu/Pulumi; Citus/Lago AGPLv3; Inngest server SSPL; Restate BSL). *(T5)*
17. **Resume, don't redo:** long workflows interrupted by usage limits are resumed via
    `resumeFromRunId` (cached agents are free). *(T4, T9)*
