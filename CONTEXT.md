# Aegis — Master Context (read this first; miss nothing)

> **Purpose of this file.** This is the single, exhaustive source of context for the Aegis project.
> Hand this repo to any new agent or person and this document — plus the docs it links — lets them
> understand *everything*: what we are building, why, the entire idea and vision, how it has evolved
> through every conversation, the architecture, every decision, the current state of the code, and what
> to do next. **Nothing essential is omitted.** If you read only one file, read this one.
>
> **This is the VISION + PRODUCT master.** The pre-existing [`SPEC.md`](SPEC.md) / [`DESIGN.md`](DESIGN.md)
> / [`HANDOFF.md`](HANDOFF.md) / [`AGENTS.md`](AGENTS.md) / [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)
> describe the *originally-built access-control platform* and remain authoritative **for that existing
> code**. This file (and `docs/strategy/` + `docs/brain/`) describe what Aegis is *becoming*. Where the
> product vision is concerned, this file wins; where the current shipped code is concerned, `SPEC.md` wins.
>
> **Last updated:** 2026-07-02 · **Owner:** Ankur Pandey (25ankurpandey@gmail.com / ankur.pandey@siterecon.ai).
> Built largely solo + AI agents (autonomous multi-pass). Also building a parallel AI-native project, **Wayfinder**.

---

## 0. How to navigate (the doc map)

Read in this order; go deep only where you need to.

1. **This file (`CONTEXT.md`)** — the whole picture.
2. **[`docs/brain/`](docs/brain/README.md)** — the "second brain": a memory map + an append-only
   [`AUDIT_LOG.md`](docs/brain/AUDIT_LOG.md) of *every working session* (T1–T14, verbatim asks →
   outcomes), standing [`instructions/`](docs/brain/instructions/README.md), a
   [`designs/`](docs/brain/designs/README.md) index, [`discussions/`](docs/brain/discussions/README.md)
   (decisions D1–D20 + open questions O1–O8), and an [`architectures/`](docs/brain/architectures/README.md)
   atlas. **Rule: check the targeted brain docs first; fall back to the audit log only if they don't answer.**
3. **[`docs/strategy/`](docs/strategy/)** — the deep design docs (each internet-researched and
   adversarially red-teamed). See §18 for the full index.
4. **[`ONBOARDING.md`](ONBOARDING.md)** — a shorter narrative onboarding (a lighter twin of this file).
5. **[`SPEC.md`](SPEC.md)** — authoritative spec of the *current built* access-control code.

**Every strategy doc has been red-teamed. The single most actionable output is
[`docs/strategy/red-team-consolidated.md`](docs/strategy/red-team-consolidated.md)** — it holds the
prioritized "fix-before-build" list, the "build FIRST" slice, and the "do NOT build until X" blockers.

---

## 1. What Aegis is (the one-paragraph and the one-page)

**One sentence:** Aegis is becoming a **governance-native, agentic-first, modular, multi-industry business
platform** — *"the agentic operating system for regulated business work"* — where a company runs its
operations (finance controls, approvals, workflow, connectors, reporting, and industry modules) by
**talking or typing to one governed agent**, turns on **only the modules it needs and pays only for
those**, and the platform **runs, heals, and explains itself** with minimal-to-no human staff.

**One page.** Aegis started as a real, built **enterprise access-control platform** (~46k LOC, an Nx/
TypeScript monorepo: a gateway + 7 business services + 10 shared `@aegis/*` libs) whose moat is the hard,
least-replicable substrate every B2B SaaS needs and few get right: **database-enforced tenant isolation**
(PostgreSQL Row-Level Security), **runtime fine-grained authorization** (Casbin RBAC+ABAC, PEP/PDP/PAP,
mutable with no redeploy), a **tamper-evident hash-chained audit ledger**, a **multi-level approval
engine** (maker-checker / segregation of duties), a **rules-as-data workflow engine**, **Kafka eventing
with a transactional outbox**, a **pluggable connector framework**, and a **per-tenant entitlement /
feature-flag** layer. We are evolving it, deliberately, into: (a) a **modular pay-per-module** platform;
(b) an **agentic-first** product where the agent is the interface and there are no human sales/support/CS
teams and minimal human ops; (c) **AI-native from the root** — agentic capability is a structural
property of every module, not a bolt-on; (d) **self-sustaining** — new functionality auto-integrates into
the AI flows with zero manual setup; (e) **autonomously operated** (NoOps/AIOps); all built so it is safe
enough to let an AI take real actions over money and PII, because governance is the substrate, never a
bypass. Longer-horizon explorations: an **AR management ecosystem** (manage all your companies by talking
to a headset), and two sellable products spun from the same tech — **agentify existing companies** and an
**AI-policing** enforcement layer for other companies' agents.

---

## 2. The core principle (everything hangs on this)

> **The agent reasons; the governed core acts.**

The LLM plans, converses, retrieves, and **proposes** — but **every state change executes through the
same deterministic path a human API call hits**: `authenticate → authorize (PEP/Casbin) → RLS
transaction → audit`. The agent is a new **principal** and a new **interface**, *never a bypass*. The LLM
stays strictly **at the edge**: it never decides authorization, never computes a risk/danger tier, never
resolves an ambiguous referent ("approve *this*") into an irreversible action without the core
re-validating it, and never carries `tenant_id` / principal / permission (all re-derived server-side).
This is the *only* reason "do anything by talking" is safe over money and PII — and it is why Aegis's
existing governance substrate is the unlock, not a chatbot.

### The four gates (every action passes all four)
| Gate | Question | Mechanism |
|---|---|---|
| **Authorization** | Are you allowed? | PEP: role × ABAC attributes × module entitlement. The tool list is filtered by this *before the model sees it*, so the agent can't attempt what you can't do. |
| **Danger** | Is this risky even if allowed? | A **second, orthogonal axis** — deterministic score (verb + count + amount + resource-class + regulatory impact) + a behavioral-anomaly signal → graduated response (confirm → typed-confirm → step-up MFA → cooling-off+undo → second approver → alert → soft-block). Fires **even with full permission**. |
| **Autonomy** | May the AI act unattended? | Reversible + deterministically-verifiable ⇒ act-then-log; irreversible / money / cross-tenant / novel ⇒ propose-only (human via `@aegis/approvals`). |
| **Verifiability** | Can we trust the result? | Trust only if deterministically re-checkable **OR** independently verified by a *different-model* second agent (proposer ≠ verifier; agent SoD) **OR** sampled + audited. Everything on the ledger with a "show-your-work" trace. |

---

## 3. The origin story — how the vision evolved (every ask, in order)

This is the whole arc so a new agent understands *why* each piece exists. Full verbatim detail is in
[`docs/brain/AUDIT_LOG.md`](docs/brain/AUDIT_LOG.md) (sessions T1–T14).

- **T1 — "Analyze what we built; how do we monetize it?"** → The moat is the *platform substrate*
  (isolation + authz + audit + approvals), not the business apps (expense/payroll/invoice are commodity
  vs Ramp/Bill/Gusto). Sell the substrate; apps become living demos.
- **T2 — "Make it modular; tenants add & pay only for what they need, multi-industry."** → Designed the
  modular pay-per-module platform: a **module manifest**, an **Entitlement Service** over Chargebee,
  kernel-vs-modules split. Found ~70% of the entitlement substrate already exists.
- **T3 — "Is this a CRM?"** → **No.** It's a *platform / aPaaS / composable business suite*
  (Odoo/Salesforce-Platform category). A CRM could be *one module* on it. Trap to avoid: building one app
  and calling it the platform.
- **T4 — "Design the whole thing agentic-first + high scale."** → The agent is the interface; users do
  everything by talking/typing; no human sales/support/CS; design every capability for 100 → 10k → 100k
  tenants.
- **T5 — "Continue; research the whole internet for adoptable OSS; make it fully autonomous to *run*
  (no ops humans); enterprise best practices; document everything."** → Added Autonomous Operations
  (NoOps/AIOps), Enterprise Readiness/Compliance, and a verified adoptable-OSS catalog.
- **T6 — "Which YC RFS category do we fit?"** → Adversarial analysis: fits a *cluster* of ~7 YC
  Summer-2026 ideas at 2–3/5; lead with **SaaS Challengers**; honest verdict: **not fundable as framed
  without a customer**.
- **T7 — "Handoff README + AI-first from scratch, AI in the core of every module."** → Wrote
  `ONBOARDING.md`; designed the **AI-Native Module Contract**; red-team narrowed it to a minimal viable
  contract (tools + risk-tier mandatory, rest opt-in; LLM at the edge).
- **T8 — "AI should do things on its own (audits, workflows, bug-fixes, data) with verifiable results;
  how is RBAC/ABAC enforced per role; add confirmation for dangerous commands even with permission;
  design all operational flows."** → The four-gates model; the danger layer; per-role flows; end-to-end
  operational flows.
- **T9 — "Omniscient debug/data agent; is our stack (TS/Node) enough; self-sustaining auto-growth;
  a second brain (dev + app) like Obsidian/Claude; check Blackboard/RCLE; an AR ecosystem protocol so a
  headset manages all my companies; 'agentify existing companies' + 'AI policing' as products; build the
  brain README infra; NO implementation yet, dense gap-free docs."** → Five deep research docs + this
  `docs/brain/` infrastructure.
- **T10–T13 — red-team everything.** Every strategy doc got an adversarial pass; the consolidated
  red-team produced the prioritized fix list + the safe build sequence. (The operations doc's verdict:
  *"strong B+ design, currently a C on trust-it-with-money-unattended."*)
- **T14 — "Start building as well as prototyping in parallel."** → Built the keystone (the tool-registry
  generator) and prototyped it green against the `expense` service. **Build phase has begun.**

---

## 4. The vision — what we are evolving into (all the layers)

Aegis is, deliberately, several things at once — one substrate showing up in many forms:

1. **A governance-native platform** — isolation, authorization, audit, and approvals are the substrate;
   everything else is built on top and inherits them for free.
2. **A modular, pay-per-module, multi-industry suite** — tenants enable only what they need (finance
   controls, approvals, workflow, connectors, reporting, and industry-specific modules) and pay per
   module; a first-party catalog first, a partner/marketplace later.
3. **Agentic-first** — the agent is the primary interface (chat + voice + generative UI); users *do* and
   *learn* everything by talking or typing; the app explains its own functionality; MCP where useful.
4. **No-humans operations** — no human sales/support/CS (self-serve onboarding, buying, and support via
   the agent) and minimal-to-no human ops (autonomous NoOps/AIOps). Honest bound: "AI proposes, humans
   decide" for the novel/irreversible/cross-tenant tail; a thin bounded human escalation always exists.
5. **AI-native from the root** — agentic capability is a structural property of *every* module (RBAC,
   ABAC, payroll, expense, workflow, audit, approvals, notifications, reporting, connectors) and every
   future module, via the AI-Native Module Contract — never bolted on.
6. **Self-sustaining / auto-growing** — new functionality/modules auto-integrate into the AI flows with
   **zero manual AI setup**: tools auto-generate from governed routes, capability manifests are generated
   and drift-gated in CI, the knowledge brain updates itself.
7. **Autonomously operated** — the platform runs, heals, scales, secures, and reports on itself.

Longer-horizon explorations (researched, not committed): an **AR management ecosystem** (manage all your
companies by talking to a Wayfinder headset that renders real-time generative UI), and two sellable
products — **agentify existing companies' legacy systems** and an **AI-policing enforcement layer** for
other companies' agents.

---

## 5. Every idea & thought behind the app (the founder's concepts, captured)

Each of these is a real directive from the founder, now a first-class concept (with where it's designed):

- **Sell the substrate, not the apps** (monetization) — [modular-platform-plan.md].
- **Pay-per-module, per-tenant, multi-industry** — tenants compose their own app — [modular-platform-plan.md].
- **The agent IS the interface** — do/know anything by typing or talking — [agentic-platform-design.md].
- **No sales/support/CS humans; minimal ops** — fully self-serve + autonomous — [agentic-platform-design.md §F].
- **AI baked into the root of every module** (structural, not bolted-on) — [ai-native-core.md].
- **Self-sustaining auto-growth** — new features auto-wire into the AI with zero manual setup — [ai-native-core.md] + proven by the tool-registry generator (§12).
- **AI does things on its own** — self-audits, runs workflows on any data, finds & fixes bugs, checks any
  data — **with correct, verifiable results** and minimal human intervention — [agentic-operations.md §1].
- **Verifiability is non-negotiable** — an autonomous result is trusted only if deterministically
  re-checkable OR independently verified (proposer ≠ verifier) OR sampled+audited — [agentic-operations.md].
- **Dangerous-command confirmation even with permission** — a second axis orthogonal to authz — [agentic-operations.md §3].
- **RBAC/ABAC enforced per role, agentically** — the agent is a principal; effective authority = role ×
  ABAC × entitlement ∩ the agent's delegated scope — [agentic-operations.md §2].
- **Omniscient platform agent** — connect across all codebases/DBs/cache/logs/queues, find & fix issues,
  serve any data/export request — [platform-omniscience.md].
- **A second brain (two of them)** — a *dev-process brain* (this `docs/brain/`) so any agent gets full
  context with zero re-explanation, and an *app/platform brain* so the runtime agents know exactly what
  to do / where / how (anti-hallucination) — [knowledge-brain.md].
- **The AR ecosystem** — manage all your companies by talking to a headset that generates UI in real
  time; AI-to-AI across the ecosystem — [ecosystem-ar-protocol.md].
- **Agentify existing companies + AI policing** — package the tech as products for others — [agentify-and-policing.md].
- **Don't shy from complex algorithms** (advanced RAG, entity resolution, anomaly detection) where they
  make the product smoother — [stack-sufficiency.md].
- **Is our stack enough?** — TS/Node is the spine; Python sidecars only for 4 algorithm families — [stack-sufficiency.md].
- **Research the internet first, document everything, red-team everything, no implementation until told** —
  the working method (§17).

---

## 6. Architecture (built substrate + AI substrate + module contract)

### 6.1 The two planes
- **Reasoning plane (probabilistic, at the EDGE):** orchestrator agent + per-module specialist
  subagents; intent, plans, retrieval, proposals, generative UI, self-knowledge answers. Never authoritative.
- **Governed core (deterministic):** the existing services + libs — the *only* thing that mutates state;
  enforces authz, tenancy, tiers, thresholds, referent re-validation, server-side principal derivation.

### 6.2 The built substrate (real today — `SPEC.md` authoritative)
Nx/TypeScript monorepo. Gateway + 7 services (user-management/identity+RBAC/ABAC/PAP, expense, invoice,
payroll, workflow, notification, reporting) + cli. 10 libs: **access-control** (Casbin PEP/PDP/PAP +
cross-pod watcher; `applyPolicyGrant` = runtime, no-deploy role/permission changes), **db** (Postgres RLS,
`withTenantTransaction`, non-owner role, Umzug migrations), **events** (Kafka bus + transactional outbox +
DLQ), **audit** (hash-chained, permissions-at-time-of-action), **activity**, **approvals**
(maker-checker/SoD/quorum/thresholds), **connectors** (adapter/registry/factory + mock ERPs),
**service-core** (DI bootstrap, RequestContext, config, feature-flags, the `validate` middleware, the
route-metadata stamps), **shared** (enums/types/constants), **testing**. Per-tenant `tenant_features` +
swappable feature-flag reader = the entitlement substrate.

### 6.3 The AI substrate (target — `@aegis/ai-core`)
The shared AI kernel every module plugs into (analog to how access-control/db/events are shared today):
orchestrator · **tool registry (auto-generated — built, see §12)** · context assembler · capability
manifest · LLM gateway (LiteLLM, per-tenant budgets) · eval harness (Langfuse + Promptfoo) · memory/RAG
(pgvector, per-tenant, RLS-scoped) · guardrails · durable tool-loop runner. Design: [ai-native-core.md §6].

### 6.4 The AI-Native Module Contract (minimal viable — the red-teamed version)
Every module inherits, **by construction**: **Tools** (auto-generated from governed routes: route-walk +
Joi→JSON-Schema + `Permission`, authz-bound, entitlement-filtered) and a **Risk tier** per tool
(money/irreversible ⇒ Tier 4 = mandatory human approval). **Eval gate** required only for Tier ≥ 2 (write)
tools. Context, intents, triggers, generative-UI, knowledge, module rails = **opt-in**. A CI gate
enforces governance-on-declared-tools (not a nine-facet checklist). Full spec: [ai-native-core.md §0.5/§8].

### 6.5 Scale posture (targets, 100 → 10k → 100k tenants)
AuthZ: Casbin coarse → **+OpenFGA** for resource/ReBAC at scale. Data: RLS single-node → replicas →
**Citus** shard-by-tenant (RLS is ~2–5% overhead *only* with leading-`tenant_id` index +
subquery-wrapped `current_setting()`). Connections: **PgBouncer** transaction pooling with `SET LOCAL`
only (the RLS footgun). Events: partition by tenant + repartition/balanced-batch. LLM: gateway + prompt
caching + model cascade + per-tenant token budgets + circuit breakers. RAG: pgvector partitioned →
Pinecone namespace-per-tenant for whales. Full: [agentic-platform-design.md §E].

---

## 7. Autonomous & verifiable AI capabilities
What the AI does on its own (self-audit, autonomous bug-hunt/fix on `auto/*` branches, cross-module
reconciliation, proactive workflow runs, anomaly/fraud detection, FinOps watch, self-healing ops,
"act on anything the user asks about their data"), each with a trigger, an autonomy tier, and a blast
radius — and the **verifiability layer** that makes results trustworthy. **Agent SoD:** the agent that
proposes is never the agent that verifies. Full design + the red-team hardening (determinism ≠
correctness; the Trust Rule must be an AND for material writes): [agentic-operations.md §1 + §0/§6].

## 8. Governance: RBAC/ABAC per role + the danger layer
Agent-as-principal with OBO delegation (RFC 8693); effective authority = user role × ABAC × entitlement ∩
agent scope; the tool list is filtered before the model sees it. End-to-end flows per role
(owner/admin/finance-manager/member/auditor/support/service-agent). The **danger layer** is a second axis
that fires even with permission (bulk delete, mass payment, PII export, disabling audit, role escalation…).
Full: [agentic-operations.md §2 + §3].

## 9. Operational flows (agentic-first)
Onboarding (tenant + user), module lifecycle (discover → buy/enable → configure → update → uninstall with
data lifecycle), payments/billing (self-serve, cost guardrails, dunning), everyday module usage, admin
operations, and agentic customer support — all agent-driven and governed, with a bounded human escalation
tail. Full: [agentic-operations.md §4].

## 10. Ancillary ambitions (researched; gated)
- **Omniscient platform agent** — 3 planes: diagnostic (read-only MCP fleet over DB replica/Redis/Kafka/
  logs/traces/GitHub/audit), remediation (propose-PR + GitOps behind the danger layer), governed
  data/export (RLS-scoped NL→query). Feasible; diagnostic is ~90% off-the-shelf. [platform-omniscience.md]
- **The AR ecosystem** — the **Aegis Ecosystem Protocol** = a *profile* over A2A + A2UI + AG-UI + MCP;
  Wayfinder as the AR surface; the net-new piece is an A2UI→Unity renderer. [ecosystem-ar-protocol.md]
- **Agentify + AI policing (products)** — lead with **Aegis Warden** (an AI-policing PEP gateway:
  enforcement + maker-checker + tamper-evident audit — an unoccupied niche vs observability-only rivals),
  then **Aegis Ignite** (agentify legacy systems). Both **GO/NO-GO gated** (D20). [agentify-and-policing.md]

## 11. Stack & self-sustainability
**TS/Node is the spine and is enough for ~90%** (agent runtime, governed core, RAG orchestration,
reranking, text-to-SQL, diff/patch). Four algorithm families (probabilistic entity-resolution,
statistical forecasting, online-anomaly learning, GraphRAG indexing) are Python **batch sidecars** behind
Kafka/HTTP seams that never touch the DB, a principal, or an authz decision. No Go/Rust *service* today
(Rust only via napi-rs). Never rewrite. **Self-sustainability** is structural: a new guarded route →
tool auto-generated → capability manifest regenerated → brain + RAG updated → CI drift-gate fails the
build if a capability lacks a description/tier. Full: [stack-sufficiency.md], [ai-native-core.md].

---

## 12. Current build state (what's REAL vs DESIGNED — be honest)

**REAL, shipping today** (branch `feat/agentic-platform`, pushed to origin = personal GitHub
`25ankurpandey/aegis`; all green at T28: **ai-core 181/181** + **db 95/95 (live
pgvector/RLS/Chargebee/policy-read-port/PIP-cap/memory-owner)** + **access-control 126/126** + all 5
business apps (expense/invoice/payroll/reporting/user-management) — ~820 tests across 9 projects; strict
typechecks clean. **Security audit: ALL 16 of 16 findings remediated + regression-gated** (see `docs/strategy/security-findings.md`).
Local infra up: aegis **pgvector** Postgres @ 55432 (migrated through
0036) + Redis @ 6380):**
- The **~46k-LOC access-control substrate** (see §6.2; `SPEC.md`/`IMPLEMENTATION_PLAN.md` authoritative).
- **Metadata stamping** — `libs/service-core/src/bootstrap/route-metadata.ts`; `authorize()`/`validate()`
  stamp the `Permission` + Joi schema onto the handler (fixes the "trapped in closures" gap).
- **`@aegis/ai-core`** — the agentic substrate lib, with a working, tested governed loop:
  - `generateToolRegistry(app)` — authz-bound, self-describing tools from the live router (proves
    self-sustainability: a new guarded route becomes a tool with zero wiring).
  - dependency-free **Joi→JSON-Schema** converter.
  - `filterToolsForPrincipal()` — the entitlement×permission pre-filter ("filter before the model sees it").
  - **tool-server** — `listToolsForPrincipal`, `invokeTool` (executes a tool by calling the SAME guarded
    route a human hits — never a bypass), `toMcpToolDefinition`.
  - **MCP transport** (`src/mcp/`) — `createAegisMcpToolServer()`: exposes the registry over Model Context
    Protocol (`@modelcontextprotocol/sdk` v1.29); `tools/call` routed through `invokeTool` (governed).
  - **orchestrator + LLM gateway** (`src/orchestrator/`) — `LlmClient` seam + `OpenAiCompatibleLlmClient`
    (LiteLLM/OpenAI/OpenRouter) + `runAgentTurn()` (offers only filtered tools; refuses any tool outside
    the offer). The first "talk to the app" loop. **The danger gate is now ENFORCED here**:
    `deriveDangerFacts(tool,args)` → `evaluateActionGate` runs *before* invoke; a write/dangerous action
    returns a **`needs_ceremony`** turn and is NEVER auto-executed (write-autonomy stays off by construction).
  - **danger/HITL layer** (`src/danger/`) — deterministic `classifyDanger` (orthogonal to authz; anomaly
    can only raise, never solely gate) + `decideCeremony` (graduated: confirm → typed-confirm → step-up →
    cooling-off → second-approver → block; tightens-only vs risk tier; single-human tenant degrades to
    out-of-band + review-queue, never self-approval) + an injectable `ApprovalGateway` seam.
  - **independent verifier / hardened Trust Rule** (`src/verification/`) — `assertTrustForAutonomousWrite`
    requires, for money/external/irreversible blast, BOTH a deterministic recompute (matches expected) AND
    a **different-model** dual-control verify; **sampled-alone is forbidden**; a verifier sharing the
    proposer's model fails the independence precondition (identity-SoD ≠ independence). The verifiability
    half of D19, as enforceable code.
  - **supervised-write path** (`src/execution/supervised-write.ts`) — **the D19 milestone**:
    `executeSupervisedWrite` runs a dangerous write ONLY after `ceremonySatisfied` (human approval / step-up
    / typed-confirm / cooling-off) AND (for money/external/irreversible) the independent verifier passes.
    Fail-closed; tests prove the unsafe path never reaches `invokeTool`. Composes AUTHORIZATION × DANGER ×
    VERIFIABILITY. MCP `tools/call` is danger-gated too.
  - **manifest tool descriptions** (`src/tool-registry/tool-manifest.ts`) — tools get an imperative
    description ("Create an expense") + optional `riskTier`/`tags` from a `ToolManifest` (begins the
    AI-Native Module Contract in code). `deriveDangerFacts` prefers a tool's explicit `riskTier`.
  - **supervised action broker** (`src/execution/supervised-action-broker.ts`) — the running two-step
    propose→confirm flow over `executeSupervisedWrite`: `propose` gates + persists a pending action
    (surfacing the ceremony), `confirm` executes only once ceremony + verifier pass.
  - **conversation/session memory** (`src/memory/`) — `ConversationStore` + `runConversation`, per-tenant+session isolation-in-the-key.
  - **generative UI, A2UI-shaped** (`src/ui/`) — `renderTurn` (incl. an approval card for `needs_ceremony`)
    + `toolInputForm` from a tool's schema; UI-as-data (no executable code — safe for untrusted rendering).
  - **registry drift-gate** (`src/tool-registry/registry-validation.ts`) — `validateToolRegistry`, the
    CapabilityManifest.Validate analog (a module can't ship a tool lacking description/authz/(for writes) tier).
  - **multi-LLM gateway** (`src/llm/`) — a provider registry that is **priority-ordered, selectable,
    runtime-switchable, with fallback** (`LlmGateway` + `buildLlmGateway`); `AnthropicLlmClient` +
    `OpenAiCompatibleLlmClient` (covers OpenAI/LiteLLM/OpenRouter/Groq). Env-config lights it up when keys land.
  - **Redis-backed durable stores** (`src/persistence/`) — conversation + pending-action stores survive
    restarts (TTL'd), tested against live Redis.
  - **first autonomous capability — PROPOSE-ONLY self-audit** (`src/autonomy/`) — `SelfAuditCapability`
    runs vetted deterministic checks and routes each finding through the SAME hardened Trust Rule that
    guards autonomous writes (deterministic V1 ∧, for material blasts, a different-model V2), emitting
    **proposals only** to an injected sink. Safety by construction: `SelfAuditDeps` has no executor to
    inject → no write path exists; an unverified material finding is `needs_human`; nothing auto-executes.
- **`@aegis/db` entitlement core** (`libs/db/src/entitlement/` + migration `0032_tenant_modules`) — the
  pay-per-module spine's core: `tenant_modules` with FORCE RLS + `EntitlementService`
  (`isModuleEnabled`/`listEnabledModuleIds`) + a tool-filter predicate; proven with a live-Postgres RLS test.
- **`@aegis/db` pgvector app-brain** (`libs/db/src/brain/` + migrations `0033` + `0034`) — the per-tenant
  self-knowledge / RAG store: `app_brain_memory` (`vector(384)`, HNSW `vector_cosine_ops` index,
  partial-unique `(tenant,kind,ref)` upsert, FORCE RLS) + a provider-agnostic `EmbeddingClient` seam
  (offline deterministic `HashingEmbeddingClient` default — a real provider is a drop-in) +
  `AppBrainRepository`/`AppBrainService`; **v2 (the Wayfinder port):** supersede-by-subject (atomic,
  RLS-scoped), soft-invalidation (`valid_to`; reads filter live rows; ref-upsert revives), embedder-space
  tagging, `minScore` recall, deterministic `profile()`/`salient()` tiers. Plus **`indexers.ts`** — the
  app-brain is ONLINE: `indexTools`/`indexAuditProposal` make the tool registry + audit findings recallable
  (live test: "create an expense" ranks the expense tool first). All proven live.
- **`@aegis/ai-core` agent memory** (`src/agent-memory/` — see `docs/brain/designs/agent-memory.md`) —
  the Wayfinder port above the store: `AgentMemoryStore` structural seam (AppBrainService satisfies it;
  libs stay decoupled), the 3 memory tools (`memory_remember`/`recall`/`forget`; decisions journal via
  kind `decision`) as **danger-gated BUILT-IN tools** (same `evaluateActionGate`; risky builtin ⇒
  `needs_ceremony`), tiered `[MEMORY]` context (Tier-0 profile ≤40 + Tier-1 salient ≤10; Tier-2 = recall
  tool only), and mem0-style post-turn extraction (ADD/UPDATE/DELETE/NOOP, confidence-gated, fail-soft —
  memory never crashes a turn). `runAgentTurn` gained `builtinTools` (registry wins collisions);
  `runConversation` gained `agentMemory`.
- **Chargebee → entitlement loop CLOSED** (`libs/db/src/entitlement/chargebee-webhook.ts` +
  user-management `POST /webhooks/chargebee` + expense `entitlementGate`) — webhook (Basic auth,
  hash-then-timingSafeEqual, fail-closed unconfigured, outside the tool registry) → pure event mapper
  (strict UUID tenant from `cf_tenant_id`, unmapped skipped never guessed, paid-through-grace on cancel,
  at-least-once-safe idempotent upserts) → `tenant_modules`; the entitlement predicate gates the LIVE tool
  surface (list + invoke share one predicate) behind `AEGIS_ENTITLEMENT_FILTER=on` (default OFF/fail-open
  until billing ingestion populates rows — the PEP stays the real security boundary).
- **ABAC Phase 0 + 1** (`libs/access-control/src/policy-{row-mapper,ports}.ts`, `libs/db/src/policy-read-port.ts`,
  `policy-loader.ts` `dbPolicies`/`combinePolicies` + PAP hardening + `scripts/abac/audit-policies.ts`) —
  per `docs/strategy/abac-generalization.md` §5. **Phase 0:** the PolicyRow→PolicyRule mapper
  (all-or-nothing load, `$attr` validation, scope + wildcard-allow bans), `PolicyReadPort`/`AttributeReadPort`
  registry, PAP write-time rejection of invalid policies. **Phase 1 (T25):** the shared-DB `PolicyReadPort`
  (RLS-scoped raw SELECT, FAIL-CLOSED) + `dbPolicies` wired on the expense approve routes behind
  `AEGIS_ABAC_DB_POLICIES=on` (default OFF); live 6/6 test. NO `authorize()` behavior change while off.
  **Next: Phase 2 = the PIP** (populate `principal.attributes` — the audit's P0; see below).
- **Security model + audit (T25)** — `docs/strategy/security-model.md` (the four fences —
  tenant-RLS/RBAC/ABAC/row-scope — the request lifecycle, and how the agent layer inherits every fence)
  and `docs/strategy/security-findings.md` (16 adversarially-verified within-tenant findings + a
  prioritized remediation plan). **Tenant isolation is a hard, live-verified guarantee.** The dominant
  gap is the **un-populated PIP** (`principal.attributes` never set at login) → `own_and_team`, the
  approval amount-cap, and `manager_of` are all silently inert; plus per-service row-scope coverage gaps
  (invoice/pay-run/single-expense) and agent-path/memory-scope hardening. Two fixes await founder
  sign-off (amount-cap source, memory scope) — recommendations documented in the findings doc.
- **`apps/expense`** — `GET /expense/v1/_ai/tools` (capability catalog) + `POST /_ai/act` + `/_ai/act/:id/confirm` (the supervised-write flow).
- **MCP stdio server** — `scripts/mcp/aegis-mcp-stdio.ts` (+ `AEGIS_MCP_README.md`): a Claude-Desktop-driveable
  MCP server over stdio (offline in-process app, or a live service via `AEGIS_SERVICE_BASE_URL`).
- **Runnable demo** — `scripts/demo/agent-loop-demo.ts` runs the whole loop offline and prints: create →
  **danger gate `needs_ceremony`** (write not auto-executed), read → 200, unpermitted-tool → not offered,
  low-danger read with a no-grant token → **403 (PEP, no bypass)**, off-topic → reply. Flips to a real
  gateway when `AEGIS_LLM_BASE_URL`/`AEGIS_LLM_API_KEY` are set.

**DESIGNED, NOT built (all infra- or decision-gated):** running the supervised-write flow + demo **live**
(the broker + `/_ai/act` endpoint + UI-as-data all exist and typecheck, but running end-to-end needs the
Docker stack + an LLM gateway key — blocked on the founder); the **module manifest + Entitlement Service**
(the pay-per-module spine — DB + Chargebee, touches O1); the app/runtime **second brain** (pgvector,
RLS-scoped) + self-knowledge RAG; the broad **autonomous capabilities**; the generative-UI **renderer**
(web/Unity) and **voice**; and the **omniscience / AR / products** tracks. **No customers, no revenue
yet.** **Fully-autonomous (no-human) money/irreversible writes remain OFF by design** — the supervised
path requires human ceremony evidence; everything shipped is the **D18 read-only / propose /
human-supervised** safe slice.

---

## 13. Decisions (D1–D20) and open questions (O1–O8)
The authoritative, maintained list is [`docs/brain/discussions/README.md`](docs/brain/discussions/README.md).
Highlights: **D5** the core principle; **D6** LLM strictly at the edge; **D7** minimal viable AI module
contract; **D8** Casbin + OpenFGA; **D10** the four gates; **D11** the verifiability rule; **D18** the safe
build sequence; **D19** write-autonomy on money is gated; **D20** products are GO/NO-GO gated. Open: **O1**
ecosystem scope; **O2** dogfood vs sell-first; **O4** when/who builds (now partially answered — the safe
first slice is defined and building has begun); **O5** YC timing; **O7** co-founder / domain-expert gap.

## 14. The safe build sequence (from the consolidated red-team)
**Build FIRST** (touches none of the unresolved planes): TS spine + the 4 Python sidecars as
dependencies; Postgres **read-replica** diagnostic reads (structured-tools-first, NL→SQL behind
confirm-before-export); `withTenantTransaction` single-tenant reads only; **dogfood maker-checker +
hash-audit on our own agents**; brain Phase-0 scaffolding; manifest-tier generated knowledge only.
**Do NOT build until fixed:** remediation autonomy / untrusted-content-to-tool exposure (until dual-LLM
injection isolation is eval-gated); money/external/irreversible write-autonomy (until the hardened Trust
Rule + single-human-tenant independence land); the AR/products tracks (per D20). Full:
[`docs/strategy/red-team-consolidated.md`](docs/strategy/red-team-consolidated.md).

**The meta-theme across every red-team (internalize this):** tenant isolation (RLS) is real for the live
DB but is quietly re-established *weaker* on every derived plane — object-store extracts, the agent/audit
ledger, hub aggregation, ANN/vector retrieval, cross-tenant operators. Guard the derived planes.

## 15. Reference repos (what to lift, and what to avoid)
- **oe_core** (`~/Documents/GitHub/oe_core`) — Nx modular-monorepo structure; deep approval-policy engine;
  invoice/PO matching + GL coding; app-switcher catalog UI; a **LangChain NL→structured-query agent**.
  *Cautionary:* 709 cross-cutting migrations + disabled boundary lint = what to avoid.
- **oe-connect-platform** (`~/Documents/GitHub/oe-connect-platform`) — connector adapter factory;
  encrypted credential store; a **durable step state machine** (the long-running-agent spine).
- **plutus** (current) + **mint** (deprecated) — **dual-ledger metering** (local authoritative → async
  idempotent fail-open mirror to Chargebee). *Harden before lifting (Java 8, no financial test coverage).*
- **emporio** — a **LangGraph voice→structured-note pipeline** + Whisper transcription + durable Pub/Sub
  workers + CloudEvents.
- **Wayfinder** (`~/Documents/Wayfinder` VR, `~/Documents/Github/Wayfinder` Android,
  `~/Desktop/wayfinder-autonomy`) — the parallel AI-native project: MCP-shaped tool catalog,
  `IVoiceToolProvider` per-module tool contribution, a drift-proof `CapabilityManifest` with a CI
  `Validate()` gate, "LLM plans / app is authority," and an autonomous 3-agent dev harness. The reference
  for AI-native-from-the-root and autonomous dev/ops.

## 16. Business & positioning reality (honest)
YC Summer-2026: Aegis fits a cluster of ~7 software RFS ideas at 2–3/5; **lead with SaaS Challengers**
(the AI-native ERP-controls replacement), with Software-for-Agents as the moat. **Honest verdict: not yet
fundable as framed** — no customer, no revenue, no co-founder, and the agent layer is designed-not-shipped.
The single highest-leverage move, worth more than any positioning: **land one field-services design partner
running real AP/expense approvals through the governed core, and lead with that traction.** Wedge:
agent-run AP + expense approvals with SoD + tamper-evident audit for field-services/construction SMBs
(SiteRecon's world). Real competitors for that wedge: Ramp, Bill.com, Brex, Airbase, Tipalti. Full:
[`docs/strategy/yc-rfs-fit.md`](docs/strategy/yc-rfs-fit.md).

## 17. How to work in this repo (the method)
- **Ultracode mode:** substantive research/design/implementation runs as multi-agent workflows with
  adversarial verification and a red-team pass; volatile claims (pricing/licenses/timelines) get verified.
- **Research the internet first**, cite sources, find reusable OSS before designing from scratch.
- **Build the safe-first slice; keep write-autonomy on money gated** until §14's blockers land in code.
- **Honesty over flattery** — keep the real state visible (designed-vs-shipped; no customers yet);
  red-team verdicts are preserved verbatim, never softened.
- **License discipline** (owned/self-host mandate): avoid BUSL/SSPL/AGPL traps (Terraform→OpenTofu/Pulumi;
  Citus/Lago AGPLv3; Inngest server SSPL; Restate BSL).
- **Brain protocol:** targeted docs first, audit log as fallback; cite-or-abstain; **every session appends
  to [`docs/brain/AUDIT_LOG.md`](docs/brain/AUDIT_LOG.md)**, decisions to `discussions/`, and refreshes
  the brain README "Current state." Keep this `CONTEXT.md` and `ONBOARDING.md` consistent as the vision moves.
- **Resume, don't redo:** long workflows interrupted by usage limits resume from cache (`resumeFromRunId`).

## 18. Full document index
**Root:** [`CONTEXT.md`](CONTEXT.md) (this) · [`ONBOARDING.md`](ONBOARDING.md) · [`SPEC.md`](SPEC.md)
(current-code spec, authoritative) · [`DESIGN.md`](DESIGN.md) · [`HANDOFF.md`](HANDOFF.md) ·
[`AGENTS.md`](AGENTS.md) · [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) · [`README.md`](README.md).
**Vision/design — [`docs/strategy/`](docs/strategy/):** `modular-platform-plan.md` ·
`agentic-platform-design.md` · `ai-native-core.md` · `yc-rfs-fit.md` · `agentic-operations.md` ·
`platform-omniscience.md` · `stack-sufficiency.md` · `knowledge-brain.md` · `ecosystem-ar-protocol.md` ·
`agentify-and-policing.md` · **`red-team-consolidated.md`** (the actionable master).
**Security & ABAC — [`docs/strategy/`](docs/strategy/):** **`security-model.md`** (the four fences +
how AI inherits them) · **`security-findings.md`** (the T25 audit: 16 findings + remediation) ·
**`abac-generalization.md`** (data-driven policy loader + the PIP plan).
**Brain — [`docs/brain/`](docs/brain/README.md):** `README.md` (memory map) · `STATE.md` (canonical
current state) · `PROGRESS.md` (standing briefing) · `AUDIT_LOG.md` (T1–T25) · `instructions/` ·
`designs/` (incl. `agent-memory.md`) · `discussions/` (D1–D20, O1–O8) · `architectures/`.
**Code:** the built substrate under `apps/` + `libs/`; the agentic keystone under `libs/ai-core/` +
`libs/service-core/src/bootstrap/route-metadata.ts`.

---

*If you are a new agent: you now have the whole picture. Start at §1–§2 and §12 (what's real), then
`docs/brain/README.md` for current state and `docs/strategy/red-team-consolidated.md` for what to build.
Nothing about this project should require re-explanation — if something is unclear or stale, fix the doc.*
