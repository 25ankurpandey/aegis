# Aegis — Agent Onboarding & Full Context

> **The exhaustive master context is [`CONTEXT.md`](CONTEXT.md).** This ONBOARDING is a shorter narrative
> twin; `CONTEXT.md` + [`docs/brain/`](docs/brain/README.md) hold the complete picture.

> **Read this first.** If you are a new agent (or person) picking up this project, this file gives you
> everything: what we're building, why, all the research we've done, the conclusions we've drawn, the
> current state of the code, and what to do next — without anyone needing to re-explain a word.
>
> **This is the narrative onboarding. The structured "second brain" lives in
> [`docs/brain/`](docs/brain/README.md)** — go there for the memory map, the append-only
> [`AUDIT_LOG.md`](docs/brain/AUDIT_LOG.md) of every session, standing
> [`instructions/`](docs/brain/instructions/README.md), the [`designs/`](docs/brain/designs/README.md)
> index, [`discussions/`](docs/brain/discussions/README.md) (decisions + open questions), and the
> [`architectures/`](docs/brain/architectures/README.md) atlas. **Targeted docs first; audit log as
> fallback.**
>
> **Last updated:** 2026-07-10 (T32) · **Owner:** Ankur Pandey (ankur.pandey@siterecon.ai), building this and
> a parallel AI-native project (Wayfinder). Built largely solo + AI agents (autonomous multi-pass).
> **For current build state + test counts, see [`docs/brain/STATE.md`](docs/brain/STATE.md)** (this
> narrative covers the vision; STATE is the always-current status).

---

## 0. The 60-second version

**Aegis is becoming a governance-native, agentic-first, modular, multi-industry business platform** —
"the agentic operating system for regulated business work." A company runs its operations (finance
controls, approvals, workflow, connectors, reporting, and industry modules) by **talking or typing to
one governed agent**, turns on **only the modules it needs and pays only for those**, and the platform
**runs, heals, and explains itself** with minimal-to-no human staff (no sales/support/CS, minimal ops).

It starts from a **real, already-built substrate**: Aegis today is a ~46k-LOC enterprise access-control +
microservices platform (Postgres RLS tenant isolation, Casbin RBAC/ABAC, tamper-evident audit ledger,
approvals engine, workflow engine, Kafka events, connectors). We are now layering an **AI-native core**
on top of — and *into the root of* — every module.

**The one principle everything hangs on:**
> **The agent reasons; the governed core acts.** The LLM plans, converses, retrieves, and *proposes*,
> but every state change executes through the same deterministic, PEP-guarded, RLS-scoped, audited path a
> human API call hits. The agent is a new **principal** and a new **interface**, never a bypass. This is
> what makes "do anything by talking" safe enough for money and PII.

---

## 1. Who / what / why

- **Who:** SiteRecon (a multi-tenant SaaS company; the owner works there). Aegis began as an
  enterprise access-control platform and is being evolved into a product.
- **Why this shape:** the hardest, least-replicable things in B2B SaaS — **enforced tenant isolation,
  runtime fine-grained authorization, and tamper-evident audit** — are *already built* in Aegis and are
  exactly what makes it safe for an AI agent to take real actions (move money, run payroll, push to ERP).
  Incumbents bolt governance on after the fact; Aegis has it as the substrate.
- **Parallel project (reference):** the owner is separately building **Wayfinder**, an AI-native AR
  navigation system, plus an **autonomous-agent development harness**. We mine it for "AI-first from the
  ground up" and autonomous dev/ops patterns (see §6).

---

## 2. How the vision evolved (the whole conversation, in order)

This is the thread of what was asked and concluded, so you have the full arc:

1. **"Analyze what we built; how do we monetize it?"** → Concluded: the moat is the *platform substrate*
   (authz + isolation + audit + approvals), not the business apps (expense/payroll/etc., which are
   commodity vs Ramp/Bill/Gusto). Lead with the substrate.
2. **"Make it modular/extensible — tenants add & pay per module, across industries."** → Designed a
   modular, pay-per-module platform: a **module manifest**, an **Entitlement Service** over Chargebee, a
   kernel-vs-modules split, isolation/data-model/versioning strategy, marketplace phasing. Concluded
   ~70% of the entitlement substrate already exists (`tenant_features` + swappable reader + runtime
   Casbin grants). → [`docs/strategy/modular-platform-plan.md`](docs/strategy/modular-platform-plan.md)
3. **"Is this a CRM?"** → No. It's a **platform/application-OS** (Odoo/Salesforce/Frappe category); a CRM
   would be one *module* on it. Don't drift into building one app and calling it the platform.
4. **"Make it agentic-first (do everything by talking/typing, no sales/support/CS) and design for very
   high scale."** → Designed the agentic architecture + per-functionality scale (100/10k/100k tenants).
   Key: agent-as-interface + auto-generated tool registry + self-knowledge RAG + voice + generative UI +
   risk-tiered HITL; and the scale playbook (Casbin→OpenFGA, RLS discipline, LLM gateway + budgets,
   pgvector, etc.). → [`docs/strategy/agentic-platform-design.md`](docs/strategy/agentic-platform-design.md)
5. **"Research the internet broadly for adoptable OSS/SDKs; make it fully autonomous to run (no ops
   humans); enterprise best practices; document everything."** → Added Autonomous Operations (NoOps/
   AIOps), Enterprise Readiness/Compliance, and a verified **Adoption Catalog** (folded into the same
   doc, §F/G/H).
6. **"Which YC RFS category do we fit?"** → Adversarial analysis: fits a *cluster* of ~7 YC Summer-2026
   ideas at 2–3/5; **lead with SaaS Challengers**; honest red-team verdict = **not fundable as framed
   without a customer**. → [`docs/strategy/yc-rfs-fit.md`](docs/strategy/yc-rfs-fit.md)
7. **"Make the whole platform AI-first from the root — AI in the core of every module (RBAC, ABAC,
   payroll, expense, workflow, …) and every future one."** → the **AI-Native Module Contract**,
   grounded in Wayfinder. → [`docs/strategy/ai-native-core.md`](docs/strategy/ai-native-core.md)
   *(designed AND shipped since T14 — the tool-registry generator + governed loop are live; see §4)*.

---

## 3. The strategy docs (where the detail lives)

Read these in order for depth. They are cross-referenced and authoritative for the *product/vision*
(the pre-existing `SPEC.md`/`DESIGN.md` remain authoritative for the *current access-control codebase*).

| Doc | What it covers |
|---|---|
| [`docs/strategy/modular-platform-plan.md`](docs/strategy/modular-platform-plan.md) | The modular, pay-per-module platform: module manifest, Entitlement Service (Chargebee), kernel vs modules, isolation/data-extensibility, entitlement state machine (grant **and** revoke), module data lifecycle, RLS-assurance gate, existing-tenant migration, module catalog, roadmap, build-vs-buy. |
| [`docs/strategy/agentic-platform-design.md`](docs/strategy/agentic-platform-design.md) | Agentic-first + high-scale + autonomous-ops + enterprise/compliance. Sections A–K: vision, end-to-end architecture, interaction layer, agent authz/safety, per-functionality scale tiers, **F. Autonomous Ops (NoOps/AIOps)**, **G. Enterprise Readiness/Compliance**, **H. Adoption Catalog (OSS/SDKs w/ license traps)**, pricing, roadmap, risks. |
| [`docs/strategy/yc-rfs-fit.md`](docs/strategy/yc-rfs-fit.md) | YC Summer-2026 RFS fit analysis + positioning + honest red-team verdict. |
| [`docs/strategy/ai-native-core.md`](docs/strategy/ai-native-core.md) | *(in progress)* The AI-Native Module Contract — how AI is baked into the root of every module + the module scaffold + autonomous dev/ops loop + `@aegis/ai-core`. |

---

## 4. Current reality of the code (be honest about this)

**What EXISTS and works** (Nx build + tsc + Jest green; see `IMPLEMENTATION_PLAN.md`, `HANDOFF.md`):
- 9 apps: `gateway` + 7 services (user-management/identity+RBAC/ABAC/PAP, expense, invoice, payroll,
  workflow, notification, reporting) + `cli` (migrations/seeders).
- 10 libs: `access-control` (Casbin PEP/PDP/PAP + watcher), `db` (RLS + `withTenantTransaction` + Umzug),
  `events` (Kafka bus + transactional outbox + DLQ), `audit` (hash-chained), `activity`, `approvals`
  (maker-checker/SoD/quorum), `connectors` (registry/factory), `service-core` (DI bootstrap,
  RequestContext, feature-flags), `shared` (enums/types/constants), `testing`.
- One-command Docker run, Terraform IaC, live Swagger, browser log dashboard, seeded 2-tenant RLS demo.

**What EXISTS now (shipped since T14 — this section was written at T13 and is superseded; canonical =
[`docs/brain/STATE.md`](docs/brain/STATE.md)):**
- **The governed agentic layer is REAL and green** (read-only / propose / human-supervised): the
  **tool-registry generator** (every guarded route → an authz-bound agent tool, zero wiring), the
  **agent orchestrator** + **multi-LLM gateway** (Anthropic/OpenAI-compatible, priority/fallback), the
  **danger/HITL layer** (deterministic ceremonies, enforced in the loop), the **independent verifier /
  hardened Trust Rule**, the **supervised-write broker** + `/_ai/act` → `/_ai/act/:id/confirm` flow, an
  **MCP stdio server** (Claude-Desktop-driveable), **conversation + agent memory** (the Wayfinder port,
  per-user scoped), a **pgvector app-brain**, the **RECONCILIATION** capability (deterministic checks →
  verified propose-only findings), and the **generative-UI renderer + interactive host** (visible AND
  clickable in a browser, wired to the governed routes). Security audit: **all 16 of 16 findings
  remediated + regression-gated**. ~870 tests across 9 projects, strict typechecks clean.
- The **module manifest / Entitlement Service** now exists too (`tenant_modules` + Chargebee → entitlement
  loop; live tool-surface gating behind `AEGIS_ENTITLEMENT_FILTER=on`).

**What still does NOT exist (the real gaps):**
- **Fully-autonomous (no-human) money/irreversible writes** — OFF by design (D19-gated); supervised writes
  require human ceremony evidence.
- **Live real-LLM demo** and **semantic embedding recall** — code is ready; both are founder-gated on keys
  (`AEGIS_LLM_*` / an embedding-provider key). **Voice** and a rich **client/native UI** are net-new.
- No customers, no revenue (per the YC red-team — this is the #1 gap to close).

**The single highest-leverage existing seam:** `libs/service-core/src/bootstrap/pep-assertion.ts`
already walks the live Express route stack; joined to per-route Joi validators + the `Permission` on each
`authorize()`, it can **auto-generate a self-describing, authz-bound tool registry** — the foundation of
the whole agentic layer.

---

## 5. Reference repos — what to lift from where

The owner has sibling repos (SiteRecon/OpenEnvoy + Wayfinder) with production code to lift rather than
rebuild. Verified in research:

| Repo | Path | Lift for |
|---|---|---|
| **oe_core** (OpenEnvoy) | `~/Documents/GitHub/oe_core` | Nx modular-monorepo structure; deep approval-policy engine; invoice/PO matching + GL coding (finance crown jewel); app-switcher catalog UI; **a LangChain NL→structured-query agent** (RAG-over-schema + validation + tenant-isolation prompt). *Cautionary:* 709 cross-cutting migrations + disabled boundary lint — what to avoid. |
| **oe-connect-platform** | `~/Documents/GitHub/oe-connect-platform` | Connector adapter factory; encrypted credential store; **durable step state machine** (saga/idempotency) — the long-running-agent spine. |
| **plutus** (current) + **mint** (deprecated) | `~/Documents/GitHub/plutus`, `~/Documents/GitHub/mint` | **Dual-ledger metering** (authoritative local → async idempotent fail-open mirror to Chargebee); `customer.id = workspace_id`. *Harden first (Java 8, zero test coverage on financial code).* |
| **emporio** | `~/Documents/GitHub/emporio` | **LangGraph 7-stage voice→structured-note pipeline** + Whisper word-level transcription; durable Pub/Sub worker framework; CloudEvents envelope. |
| **Wayfinder VR** | `~/Documents/Wayfinder` | AI-native-from-core reference: MCP tool-calling, voice (Whisper/Piper/Wit), LLM tool-calling context, perception stack, AI-opened UI. |
| **wayfinder-autonomy** | `~/Desktop/wayfinder-autonomy` | Autonomous dev/ops: 3 scheduled agents (bug-hunt/test/build-continuation), journaling/resume, `auto/*` branches, feedback loops, `AI_NATIVE_ANALYSIS.md`. |
| **Wayfinder Android** | `~/Documents/Github/Wayfinder` | Kotlin routing brain + test/build harness. |

---

## 6. The AI-first-from-the-root directive (current focus)

The owner's directive: **AI must be a structural property of every module — RBAC, ABAC, payroll, expense,
invoice, workflow, audit, approvals, notifications, reporting, connectors, and every future module — not a
layer bolted on top.** Grounded in how **Wayfinder** does it (MCP/voice/LLM-tool-calling in the core;
autonomous 3-agent dev harness with feedback loops).

The design (in [`docs/strategy/ai-native-core.md`](docs/strategy/ai-native-core.md)) defines an
**AI-Native Module Contract** every module implements by construction: self-describing authz-bound
**tools**, agent-readable **context/resources**, natural-language **intents**, **events** for triggers +
self-improving loops, per-action **risk tier** (HITL via approvals), **eval/feedback hooks**,
**generative-UI** surfaces, **memory/knowledge** contribution, and module **guardrails** — expressed as a
mandatory `ai` block in the module manifest, backed by a shared **`@aegis/ai-core`** kernel (orchestrator,
tool registry, LLM gateway, eval harness, memory/RAG, guardrails).

**Non-negotiable constraint:** this must NOT violate "the agent reasons; the governed core acts." AI in
the core means *every module exposes itself to agents and improves via feedback* — it does **not** mean an
LLM sits in a hot authorization or money-moving decision path. Determinism stays in the governed core; AI
lives at the interface, proposal, retrieval, and eval layers. (The red-team pass explicitly stress-tests
this; see the doc's critique section.)

---

## 7. Key conclusions & decisions already made

- **Lead product framing:** governance-native platform; wedge = **agent-run AP/expense approvals with SoD
  + tamper-evident audit** for **field-services/construction SMBs** (SiteRecon's world), QuickBooks
  connector day one.
- **Authz at scale:** keep Casbin for coarse RBAC; add **OpenFGA** for resource/relationship authz.
- **Billing/entitlement:** reuse **Chargebee + plutus dual-ledger**; build a thin entitlement
  materialization service; **OpenMeter** (Kafka-native) for usage metering. Don't add Stripe
  Entitlements/Lago/Orb now.
- **Data/RAG:** **pgvector** partitioned by `tenant_id` (inherits RLS); Pinecone only for whale tenants.
- **Durable agent work:** **DBOS** (runs on existing Postgres) or Temporal/Inngest.
- **Autonomous ops:** GitOps (Argo CD) + Kyverno admission + KEDA scale-to-zero + AI SRE agent + SLO-gated
  auto-rollback; "AI proposes, humans decide" for novel/irreversible/cross-tenant.
- **License traps to respect** (owned/self-host mandate): Terraform is BUSL (use **OpenTofu/Pulumi**);
  Citus & Lago are AGPLv3; Inngest *server* is SSPL; Restate is BSL.
- **Default agent stack:** Claude Agent SDK · MCP TS SDK + openapi-mcp-generator · LiteLLM · Cerbos→OpenFGA
  · Chargebee+OpenMeter · DBOS · Vercel AI SDK + AG-UI · Langfuse + Promptfoo · pgvector · Argo CD + KEDA +
  CloudNativePG + PgBouncer.

## 8. Open decisions (need the owner)

1. **Ecosystem scope:** first-party suite + curated partners, or open third-party marketplace? (Sizes the
   SDK/sandbox/rev-share.)
2. **Primary goal now:** dogfood at SiteRecon (construction pack) vs sell externally (finance/AP) vs both.
3. **YC:** apply now (weak without traction) vs get one paying design-partner first (strongly advised).
4. **AI-native contract scope:** full contract for every module vs minimal-viable-contract first (the
   red-team will recommend a required-vs-optional split).
5. Kernel-free tier boundary; single-founder + domain co-founder gap; Chargebee-migration coupling.

## 9. What to do next (recommended)

The strategy is deep; the gap is **shipped agentic behavior + one real customer**. In priority order:
1. **Build the agent-runtime MVP on the governed core** (NOW-phase in the agentic doc): auto-generated
   tool registry from the route-stack walk; agent-as-principal (scoped JWT); orchestrator + 1–2
   specialists; LLM gateway + per-tenant budgets; risk-tiered HITL via `@aegis/approvals`; agent audit
   trace. Milestone: **run submit→approve→post of an expense entirely by chat**, executed through
   PEP/RLS/audit.
2. **Land one field-services design partner** running real AP/expense approvals; measure the
   human-in-the-loop exception ratio. This is what makes everything else credible (YC, fundraising).
3. **Implement the AI-Native Module Contract** on one existing module end-to-end (expense) as the
   reference, then retrofit others.

## 10. How to work in this repo

- **Ultracode is the working mode:** use multi-agent Workflows for substantive research/design; verify
  claims adversarially. The strategy docs above were produced this way (each has a red-team critique).
- Authoritative spec for the *current code*: [`SPEC.md`](SPEC.md); build tracker:
  [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md); build handoff: [`HANDOFF.md`](HANDOFF.md).
- Product/vision authority: the four `docs/strategy/*.md` docs.
- Prod DB access, Chargebee migration context, and Chrome/GSheet access are in the owner's
  Claude memory (`~/.claude/.../memory/`).

---

*This file is the single entry point for context. Keep it updated as the vision and code advance. If you
only read one thing, read §0, §4 (what's real vs designed), and §9 (what to do next).*
