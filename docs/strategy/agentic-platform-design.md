# Aegis — Agentic-First, Modular, Multi-Industry Platform: Master Design

> Companion to [modular-platform-plan.md](./modular-platform-plan.md). That doc defines the modular,
> pay-per-module platform (module manifest, Entitlement Service, kernel-vs-modules). **This** doc adds
> the two defining constraints:
> 1. **Agentic-first** — the agent *is* the interface. Users do and learn *everything* by typing or
>    talking. No human sales, support, customer-success, or **ops** teams. The app explains its own
>    functionality. MCP where useful, not essential.
> 2. **High scale by design** — every capability is specified for behaviour at 100 → 10k → 100k tenants.
>
> Grounded in the Aegis codebase, four SiteRecon/OpenEnvoy repos, and verified market research.
> Sections on Autonomous Operations, Enterprise Readiness, and the Adoption Catalog are written from
> current research and will be sharpened by a supplementary research pass (flagged inline).

---

## 0. The one principle everything hangs on

**The agent reasons; the governed core acts.**

An agentic-first product that lets users "do anything by talking" is terrifying for payroll, invoices,
and PII — *unless* you draw a hard line: the LLM **plans, converses, retrieves, and proposes**, but
**every state change executes as a deterministic, PEP-guarded, RLS-scoped, audited module operation** —
the exact same guard a human API call hits today. The agent is a new **principal** and a new
**interface**, never a bypass of the governance substrate.

This is why Aegis is unusually well-positioned: the hard part of agentic safety (authorization,
tenant isolation, audit, approvals) is *already built and uniform across every service*. We are
adding a reasoning/conversation layer **on top of** a governance core, not bolting governance onto a
chatbot. The research calls this the **deterministic-skeleton + probabilistic-nodes** pattern, and it
is the single most important design rule in this document.

```
        ┌─────────── PROBABILISTIC (the agent) ───────────┐  ┌──── DETERMINISTIC (the core) ────┐
 user → │ understand intent · plan · retrieve · propose · │→ │ authenticate → authorize(PEP) →   │→ result
 (talk/ │ converse · render UI · explain · ask approval   │  │ RLS txn → module op → audit+events│
  type) └──────────────────────────────────────────────────┘  └───────────────────────────────────┘
                         no money/data moves here                    every state change is here
```

---

## A. Vision & positioning

**Aegis is the agentic operating system for regulated business work** — a modular, multi-industry
platform where a company runs its operations (finance controls, approvals, workflow, connectors,
reporting, and industry-specific modules) by **talking to one governed agent**, turns on only the
modules it needs, pays only for those, and where the platform **runs, heals, secures, and explains
itself** with minimal-to-no human staff on either side.

**Why us, not Sierra/Decagon/Agentforce/Glean:** those are agent layers over *someone else's* system
of record, or horizontal assistants with no enforced data plane. Aegis owns the **system of record +
the isolation + the authorization + the audit**, so its agent can safely *take consequential actions*
(move money, run payroll, push to ERP) — not just answer questions. The wedge sentence:

> **"Every other agent can tell you about your business. Aegis's agent can run it — safely — because
> isolation, authorization, and audit are the substrate, not an afterthought."**

**Major head start discovered in the research:** SiteRecon already has production agentic code to lift,
not greenfield:
- **emporio** — a **LangGraph 7-stage voice-session → structured-note pipeline**
  (`emporio/services/voice_note_generation/voice_session_ai_note_generation.py`) with Whisper
  word-level transcription (`android_voice_session.py`), template-schema validation, image attachment,
  locale handling — already wired to durable Pub/Sub workers (`core/listener/_custom_subscriber.py`).
- **oe_core** — a **LangChain NL→structured-query agent**
  (`libs/services/backend/src/gen-ai/LLM-service.ts`): RAG over schema definitions + few-shot
  examples + output validation + ID-mapping + role-aware post-processing + a hard tenant-isolation
  system prompt. This is *already* "compile user intent into validated, tenant-scoped actions."
- **oe-connect-platform** — a **durable step state machine** (`integrations_steps.py`) + Celery/SQS
  with visibility-timeout heartbeats — the long-running-task spine an agent orchestrator needs.
- **plutus** — a **metering ledger** (`CreditUsageDao.java`, `end_to_end_id` idempotency) — maps onto
  per-action token/credit metering for agent actions.

---

## B. Reference architecture — end to end

```
 ┌─ CLIENT ─────────────────────────────────────────────────────────────────────────────┐
 │  text chat · VOICE (WebRTC) · generative UI (declarative widgets) · existing screens   │
 └───────────────────────────────┬───────────────────────────────────────────────────────┘
                                  │  utterance / transcript (+ session id, tenant id)
                                  ▼
 ┌─ AGENT RUNTIME (new kernel service; durable) ─────────────────────────────────────────┐
 │  Orchestrator agent (tenant-scoped)                                                    │
 │   1. input guardrails (jailbreak/PII/off-topic tripwire — BEFORE tokens spent)         │
 │   2. retrieve TOOLS: tool registry filtered by (entitlement ∩ user permissions)        │
 │        └─ RAG-over-tools (too-many-tools): embed request → top-k tool schemas          │
 │   3. plan / route → specialist subagents (per-module) — context isolation              │
 │   4. for each action: classify RISK TIER → maybe HITL approval                         │
 │   5. output guardrails + generative-UI render                                          │
 │  runs on a DURABLE-EXECUTION engine (Temporal/Inngest): survives crashes, retries,     │
 │  pauses for approvals for hours/days without holding compute                           │
 └───────────────┬───────────────────────────────────────────────┬────────────────────────┘
                 │ every tool call = a normal guarded request      │ long/async work
                 ▼                                                 ▼
 ┌─ GATEWAY (apps/gateway) ──────────────────┐     ┌─ EVENT BUS + OUTBOX (libs/events) ────┐
 │  authenticate() → resolve route →          │     │  triggers (agent subscribes to topics) │
 │  ENTITLEMENT check (module bought?) →       │     │  async agent work via outbox           │
 │  propagate tenant + correlation headers     │     │  module.* / agent.* / entitlement.*    │
 └───────────────┬─────────────────────────────┘     └───────────────┬────────────────────────┘
                 ▼                                                     ▼
 ┌─ MODULE SERVICE (expense/payroll/…/3p) ───────────────────────────────────────────────┐
 │  authorize(Permission) [PEP, fail-closed] → withTenantTransaction [RLS] → op           │
 │  emits domain events → outbox     meters usage → per-module sub-ledger (plutus pattern)│
 └───────────────┬───────────────────────────────────────────────────┬────────────────────┘
                 ▼                                                     ▼
        ┌─ AUDIT LEDGER (libs/audit) ─┐                  ┌─ LLM GATEWAY (LiteLLM/Portkey) ─┐
        │ hash-chained, append-only,  │                  │ multi-provider routing/fallback │
        │ permissions-at-time-of-action│                 │ prompt cache · model cascade ·   │
        │ + prompt/tool-call trace ★  │                  │ per-tenant token budget + meter  │
        └──────────────────────────────┘                 └──────────────────────────────────┘
```

Everything below details the four new pillars: **Interaction (C)**, **Authz & Safety (D)**,
**High Scale (E)**, and **Autonomous Ops / Enterprise (F–H)**.

---

## C. Agentic interaction layer

### C.1 Orchestrator + specialist subagents
A **tenant-scoped orchestrator** receives the utterance and either answers directly or routes/delegates
to **per-module specialist subagents** (supervisor/router pattern). Start with **router + a few
specialists**; escalate to **orchestrator-worker** only for open-ended tasks. Use **context isolation
via subagents** (Claude Agent SDK pattern) — workers sift large data and return only distilled results,
keeping the lead agent's context clean (Anthropic's own evals: orchestrator-worker beat single-agent by
~90% on broad research). Build on **Claude Agent SDK** (gather-context → act → verify loop, subagents,
compaction) or **LangGraph** (explicit graph, deterministic skeleton with LLM only at specific nodes).
Lift oe_core's existing LangChain agent as the proven in-house pattern.

### C.2 How modules expose capabilities — self-describing, auto-generated tools
This is the killer reuse: **every Aegis route is already a single-purpose, Joi-validated, PEP-guarded
verb** — a ready-made tool. The highest-leverage seam is `libs/service-core/src/bootstrap/pep-assertion.ts`
`findUnguardedRoutes()`, which already **walks the live Express router stack** extracting method + path +
guard for every route. The same walk, joined to each route's **Joi validator** (→ JSON Schema via
`joi-to-json`, exactly the function-calling/MCP input format) and the **`Permission`** on each
`authorize()`, **auto-generates a tool registry with built-in authz metadata** — tools that are
self-describing *from running code*, not a hand-maintained list (today's `docs/api/openapi.yaml` is
hand-transcribed and must not be the source of truth).

- **Module manifest** (from the modular plan) gains an **agent surface**: per-tool descriptions,
  usage examples, risk tier, and an optional **per-module MCP server** (auto-generated from the routes;
  OpenAPI→MCP generators compile ~77% of endpoints out of the box, the rest after small spec fixes).
- **MCP** is the capability interface where useful (Tools = model-invoked, Resources = app-injected
  context, Prompts = user-invoked), but **not essential** — internal modules can be called directly as
  in-process tools. Expose external/third-party modules over MCP behind a **gateway** (MetaMCP/Bifrost
  pattern: servers→namespaces→endpoints, per-key allow-lists, single-round-trip entitlement-filtered
  listing).

### C.3 The "too many tools" problem (mandatory at scale)
Flat tool lists collapse model accuracy — **Berkeley Function-Calling Leaderboard: accuracy drops from
43%→2% going from 4 to 51 tools** (verified). With dozens of modules × tools, we cannot dump all
schemas into context. Solution, layered:
1. **Entitlement + permission filtering first** — the registry only ever offers tools for modules the
   tenant bought *and* the user can use (`FeatureFlags`/Entitlement Service ∩ Casbin permissions). This
   alone cuts the catalog massively per request.
2. **RAG-over-tools** — embed every tool's description+examples; retrieve top-k for the request; pass
   only those schemas. Augment descriptions with usage examples (vocabulary mismatch kills recall).
3. **Hierarchical routing** — route by module/namespace before tool, so the model never sees the global
   set.

### C.4 Self-knowledge — "the app explains every bit of its functionality"
A dedicated **self-knowledge module**: embed each module's manifest + docs + tool descriptions + the
audit/activity history into a **per-tenant vector index** (pgvector partitioned by `tenant_id` — RLS
isolation for free, planner-combined filter+vector). The agent answers "how do I…?", "what can this do?",
and "why did *this* happen?" by RAG over (a) static capability docs and (b) the tenant's own
hash-chained audit ledger + activity feed. This is what replaces a docs site, a help center, and tier-1
support — **the app is its own documentation, queryable in natural language**.

### C.5 Modalities — chat, voice, generative UI
- **Voice (talking):** lift emporio's pipeline — **Whisper word-level transcription** + the 7-stage
  structured-extraction orchestrator are directly reusable. For realtime conversation, budget the
  **~300–800ms turn** (VAD 50 / STT 150 / LLM TTFT 400 / TTS 150 / net 50). Use **LiveKit Agents or
  Pipecat** (OSS, BYO models) for control; **OpenAI Realtime** for fastest speech-to-speech. Cost is
  dominated by **audio-output tokens** — keep turns terse and **prompt-cache the system prompt (halves
  $/min)**. Economics: managed (Vapi/Retell) under ~10k min/mo; **self-host LiveKit/Pipecat above ~50k
  min/mo for 60–80% savings**.
- **Generative UI:** "do anything by talking" must return interactive widgets (forms, tables,
  dashboards, approval cards), not walls of text. Use the **declarative, code-injection-safe layering**:
  **MCP** (tools) + **A2UI** (UI-as-data JSON) + **AG-UI** (event transport for streaming/interrupts).
  Prefer this over Vercel AI SDK RSC (powerful but framework-locked + experimental) so untrusted/3p
  modules can render UI **without** injecting executable code.
- **Existing screens** stay — the agent augments, it doesn't force a chat-only UX (accessibility,
  latency, and power-user efficiency demand real UI for some tasks).

### C.6 No-human-ops (sales / support / CS)
- **Onboarding:** agentic — the agent walks a new tenant through setup, provisions defaults.
- **Buying (no sales):** when a user asks for a capability, the agent **discovers the module, explains
  it and its price, and on confirmation provisions it** via the Entitlement Service (creates the
  Chargebee subscription item → materializes the `tenant_modules` entitlement → projects module
  permissions via PAP → opens routes). Self-serve buying is proven for SMB/mid-market (Intercom Fin
  published $0.99/resolution + $49/seat trial; Devin/Lindy sign-up-and-go).
- **Support (no CS):** the self-knowledge module + audit RAG answers "how/why" questions; the agent can
  *act* to fix issues within its authz scope.
- **Bounded human escalation (the Klarna lesson):** Klarna publicly walked back AI-only support after
  cutting humans too aggressively. **Keep a thin, free, full-context escalation path** for the long
  tail and high-stakes cases. For Aegis the "human" is often the *tenant's own* approver via HITL
  (below), not Aegis staff — but a bounded Aegis escalation tier must exist for platform issues. Measure
  **quality per segment**, not just aggregate deflection.

### C.7 Conversation state & memory
Session state in a shared store with **tenant + session embedded in the key** (`tenant:{id}:session:{id}`)
— isolation lives in the key, not app logic. Short-term: conversation buffer with **auto-compaction** as
the window fills. Long-term: per-user/per-tenant memory (preferences, prior decisions) in the per-tenant
vector store. One `thread_id` per session for clean checkpointer isolation (LangGraph) / Sessions
(OpenAI/Claude SDK).

---

## D. Agent authorization, safety & governance

### D.1 Agents as first-class principals
Extend the existing internal-JWT minting (`libs/service-core/src/auth/internal-auth.ts`
`signInternalToken`, today carrying only `sourceService`) to mint **short-lived, scoped agent
credentials** carrying `agentId` + `tenantId` + granted scope. Every agent tool call then runs the
**identical** `authenticate() → authorize(Permission) → RLS` path (`libs/access-control/src/pep.ts`)
a human hits — **zero new authz code**. For multi-hop (orchestrator → subagent → tool), use **OAuth 2.0
Token Exchange (RFC 8693) On-Behalf-Of delegation** (the `act` claim, nestable) so the
agent→user chain is preserved and auditable; audience-bind tokens with **RFC 8707 resource indicators**.

### D.2 Entitlement-gated tools
An agent may only use tools for modules the tenant has bought: **coarse gate at the gateway** (module
enabled?) + **fine gate at the PEP** (permission) + the **tool registry is pre-filtered** by entitlement
∩ permission before the model ever sees a tool (C.3).

### D.3 Safety against prompt injection / tool poisoning / confused deputy
Authorization is necessary but **not sufficient** — pair it with structural defenses:
- **MCP authorization = OAuth 2.1 Resource Server** (2025-11-25 spec): mandatory PKCE/S256, RFC 9728
  protected-resource metadata, RFC 8707 resource indicators; **token passthrough forbidden** (server
  mints its own upstream tokens). Kills the confused-deputy/over-broad-token problem at the gateway.
- **Privilege separation (dual-LLM / CaMeL "code-then-execute")** once an agent ingests untrusted
  content (emails, web, RAG docs, tool outputs) — the untrusted text cannot directly drive privileged
  tool calls.
- **Tool descriptions and tool *results* are an attack surface** — version-pin + cryptographically
  verify tool definitions (stop rug-pulls), render full descriptions to users, isolate servers.
- **Layered guardrails**: input guardrails *before* the model (tripwire blocks token spend + side
  effects), output guardrails on the final producer. **NeMo Guardrails** (conversational/jailbreak
  rails) + **Guardrails AI** (structured output + PII/toxicity); budget 50–300ms/turn, run validators in
  parallel.
- **Capability allow-lists, not deny-lists**, with per-tool parameter/resource scoping.

### D.4 Risk-tiered human-in-the-loop (reuse `@aegis/approvals`)
Gate by **blast radius, not model confidence** — four tiers:
| Tier | Example | Policy |
|---|---|---|
| 1 read-only | "show me overdue invoices" | autonomous + log |
| 2 reversible write | "add a tag", "draft a report" | autonomous + log + activity feed |
| 3 external / notify | "email the vendor" | review (cheap approval) |
| 4 irreversible / money | "run payroll", "approve a $40k invoice", "push to ERP" | **mandatory human approval — `@aegis/approvals` + maker-checker** |

Durable interrupts (Temporal signals / Step Functions `waitForTaskToken`) let the agent **pause for
hours/days awaiting approval without holding compute**. The agent *proposes*; the existing approval
engine and SoD/maker-checker enforce. This is exactly the workflow engine's existing `runRule(dryRun)`
propose pattern, generalized.

### D.5 Auditability — "why was the agent allowed to do this?"
Every agent decision/action lands on the **hash-chained audit ledger** (`libs/audit`) with
**permissions-at-time-of-action** (already captured) **plus the prompt + tool-call trace** (new
`AuditAction`s: `agent.tool.invoked`, `agent.action.proposed`, `agent.action.approved`). The
**activity feed** (`libs/activity`) surfaces "what the agent did to this record" in the same timeline
humans see — essential for trust when the agent is the primary actor. The self-knowledge agent reads
this ledger to answer "why did X happen?" — closing the loop on no-human-support.

### D.6 Fine-grained authz at scale — the Casbin decision
**Verdict: layered, not rip-and-replace.** Keep **Casbin for coarse, in-process RBAC at the edge**
(small per-tenant rule sets, O(1) cached role lookups, latency-sensitive). **Casbin breaks** on (a)
per-object/per-resource authorization (flat policy explosion — millions of resources) and (b)
relationship-inherited permissions (org > team > folder > doc). For those, **move to a Zanzibar-style
ReBAC engine**:
- **OpenFGA** (CNCF, Apache-2.0, self-host, no lock-in; Auth0 publicly tested **1M req/s at 100B
  tuples**; **contextual tuples** are ideal for agent OBO delegation at check time, no write
  amplification) — **recommended default**.
- **SpiceDB** if you need the strongest consistency (**ZedToken/zookie** solves the "new enemy problem"
  — deterministic revocation, critical when an agent's access must be cut *immediately*).
- **Cedar/AVP or Cerbos** for fast, formally-analyzable ABAC where decision inputs are small/contextual
  (sub-1ms; you can *prove* "no policy lets the agent delete prod"). AVP cut single-auth pricing **up to
  97% (June 2025)**.

**Migration path:** (1) benchmark Casbin now at target tenant×module×role counts + the `watcher.ts`
reload-storm behavior (do this in the NOW phase — see roadmap); (2) introduce OpenFGA behind the PEP for
resource/relationship checks while Casbin keeps coarse RBAC; (3) use **consistency tokens** for
security-critical/right-after-revoke checks, cached (~10s TTL) for hot read paths.

### D.7 Abuse / failure modes
- **Runaway agents / cost bombs** → per-tenant token budgets + loop limits + circuit breakers (E.6).
- **Cross-tenant leakage via shared agent context/caches** → tenant-keyed everything; **lint
  aggressively** (the documented warm-process leak); session keys carry tenant id; RLS at the DB as
  backstop.
- **Compounding error over long runs** → verify-work stage per step (rules/LLM-as-judge), checkpoint
  between steps, cap fan-out.

---

## E. High-scale architecture (per functionality)

Scale tiers used throughout: **100 / 10k / 100k tenants.**

### E.1 Authorization at scale
- **100:** Casbin in-process is fine.
- **10k:** keep per-tenant rule sets tiny (<100) via RBAC + shared defaults; shard policies so each
  enforcer loads only its subset; cache role lookups. Benchmark `watcher.ts` reload fan-out.
- **100k / per-resource / relationships:** OpenFGA/SpiceDB behind the PEP (D.6); consistency tokens for
  revocation correctness.

### E.2 Tenant data isolation (RLS) at scale
RLS adds only **~2–5% overhead and ~0.3ms eval even at 50M rows / 10k tenants** *if* (and only if): the
policy reduces to a **leading-`tenant_id` composite index** and **`current_setting()` is wrapped in a
scalar subquery** so Postgres computes it once per query (InitPlan). Un-wrapped, it is evaluated per row
→ **catastrophic: 5ms→5s at 100k+ rows** (verified). Aegis already uses `set_config(..., true)` per
transaction (`libs/db/src/rls.ts`, `withTenantTransaction`) — **audit every policy for the
subquery-wrap + leading index as a release gate.**

### E.3 Connection pooling (the agent-fleet footgun)
Postgres caps at **~3,600 connections on a 32 GiB node** (~5–10 MB/backend). A fleet of hundreds of agent
workers **must** multiplex through **PgBouncer transaction pooling (~80:1)** or RDS Proxy. **Critical:**
transaction/statement pooling + RLS is the classic production footgun — tenant context **leaks across
pooled connections** unless you use **`SET LOCAL` inside an explicit transaction (never `SET SESSION`)**.
On RDS Proxy, session-level `SET` causes **pinning** that collapses multiplexing. Bugs appear *only under
concurrent load*. Make the `SET LOCAL`-in-transaction discipline a lint + load test.

### E.4 Horizontal data scale-out
Plan the path now: **Citus with `tenant_id` as distribution key** keeps the hot path a single-shard
query with full SQL/ACID and scales to millions of tenants; isolate whale tenants on dedicated shards.
Cross-shard analytics (queries omitting `tenant_id`) fan out — push those to CQRS read models / a
warehouse.

### E.5 Event bus at scale
**`#partitions` is a hard ceiling on consumer-group parallelism AND expensive to grow later** (re-keys
data) — provision generously up front. Naive `tenant_id` keying creates **hot partitions** from skewed
tenants → use **repartition-by-tenant + balanced-batch redistribution**. The transactional outbox
(`libs/events`) is the publish path; size partitions = max(throughput/~5–10MB/s/partition, max
consumers).

### E.6 LLM/agent economics at scale (the new cost center)
This is where SaaS margins go from 80–90% → 50–60% if unmanaged. Levers, in order of impact:
1. **LLM gateway from day one** — **LiteLLM** (OSS, OpenAI-compatible, virtual keys with per-tenant
   token/RPM/$ budgets, Redis-coordinated rate limits) or **Portkey** (adds guardrails + prompt
   versioning). Single chokepoint for routing, fallback, caching, metering.
2. **Prompt caching** — Anthropic cache hit ≈ 0.1× input / 90% off; the biggest agentic lever (large
   stable system prompt + tool schemas reused every turn).
3. **Model routing / cascades** — cheap small model for routing/extraction, escalate hard queries to a
   frontier model.
4. **Per-tenant budgets + real-time cost attribution (v1, not a retrofit)** — Redis quota store
   (tokens/day, RPM, daily $ cap) enforced at the gateway *before* the call; record every token against
   tenant+user+task for margin tracking. **Never hard-stop a production agent on credit exhaustion**
   (Lindy pauses agents — a reliability killer); default to metered overage/auto-top-up with alerts.
5. **Resilience triad (non-optional)** — hard ~30s timeouts; retries capped at 3 with exponential
   backoff + full jitter respecting `Retry-After`; **circuit breaker** (trip ~50% failure/60s) → fail
   fast + multi-provider fallback. Unguarded, a 5-min provider outage at 100 RPM wastes 500–1000s of
   timeout wait and starves healthy traffic.
6. **Batch API** for non-interactive work (nightly per-tenant processing, evals) at **50% off**.
7. **Provider rate limits bite before your infra does** — climb tiers, spread across keys, queue against
   dual limits (provider + per-tenant).

### E.7 RAG / self-knowledge at scale
**pgvector partitioned by `tenant_id`** (RLS isolation free, planner-combined filter+vector, immediate
freshness, ~30–50% cheaper TCO) up to **~5M vectors**; beyond that or for huge tenants, **Pinecone
namespace-per-tenant** (physical isolation, instant offboarding, cost scoped to tenant size). **Never**
one global index filtered by metadata — you scan everything and pay per GB regardless.

### E.8 Metering / billing at scale
Lift **plutus's dual-ledger** (`CreditUsageDao`, `end_to_end_id` idempotency): authoritative local
append-only **per-module sub-ledger** first, then async, idempotent, **fail-open** mirror to Chargebee.
Meter agent actions (token + action) here. Fail-open on the mirror but **bound** unbilled accrual (cap +
alert) to avoid unbounded revenue leak.

### E.9 Caching & noisy-neighbor
- **Multi-tier cache** (L1 in-process + L2 Redis), tenant-namespaced keys, mandatory triad:
  **single-flight on miss + stale-while-revalidate + jittered TTLs**, with **Redis Pub/Sub L1
  invalidation** — kills stampedes at both tiers.
- **Noisy-neighbor defense is layered, not single-point:** per-tenant **token bucket at the gateway**
  (429 + `Retry-After`), **weighted fair queuing** in workers (tiered weights, no starvation),
  **per-tenant connection caps** at the pool, and **physically isolate the largest/most-sensitive
  tenants** (dedicated shards/namespaces). One runaway tenant can triple everyone's p99 in minutes
  otherwise.

### E.10 Observability for an agentic fleet
**Langfuse** (OSS self-host, OpenTelemetry) for trace capture (prompt/output/cost/latency per step) +
**per-tenant cost attribution** + online **LLM-as-judge evals sampled at 1–10%** (judging every trace at
$0.01–0.10 is cost-prohibitive). Distributed tracing on a consistent session id across
gateway→agent→tool→event→saga; per-module/per-tenant SLOs.

### Scale-tier summary
| Capability | 100 tenants | 10k | 100k |
|---|---|---|---|
| AuthZ | Casbin in-proc | Casbin sharded + cached | + OpenFGA/SpiceDB for resource/ReBAC |
| Data isolation | RLS single node | RLS + read replicas + wrapped-subquery/leading index | Citus sharded by tenant_id |
| Connections | direct | PgBouncer txn pooling | PgBouncer + per-tenant caps |
| Events | single topic | partitioned by tenant | repartition-by-tenant + balanced batch |
| LLM | direct + caching | gateway + budgets + cascade | gateway + batch + multi-provider + self-host voice |
| RAG | pgvector | pgvector partitioned | Pinecone namespace-per-tenant for whales |
| Agents | in-request | durable engine + async | durable + autoscaled workers + fair queuing |

---

## F. Autonomous operations (NoOps / AIOps): how Aegis runs itself

The third "no humans" frontier. Design rule: **Git is the only write path to production, and everything
else is a reconciliation loop that corrects the layer beneath it.** Humans set policy and own a narrow,
explicit escalation set; everything reversible, bounded, and chaos-validated runs unattended.

Self-operation is **four stacked reconciliation layers, foundation up** — each auto-corrects the one below:
1. **K8s self-healing** — probes, ReplicaSets, PodDisruptionBudgets + node healers (node-problem-detector,
   kured, Cluster API) recover crashed processes/hung pods/dead nodes, zero humans.
2. **GitOps reconciliation** — Argo CD `selfHeal:true + prune:true` reverts any out-of-band change to Git state.
3. **Admission enforcement** — Kyverno validate + mutate makes every workload self-healing, isolated,
   observable, signed *by construction*.
4. **Intelligence / remediation** — KEDA/Karpenter autoscaling, Argo Rollouts SLO-gated canaries, an AI SRE
   agent reasoning over OpenTelemetry.

### Self-healing & auto-remediation
**Probes done right (the #1 self-inflicted-outage trap).** Every service + per-tenant agent runner ships
**startup + readiness + liveness** probes (enforced via Kyverno). Readiness pulls a pod from `Service`
endpoints without restart (1–2s); liveness restarts only on genuine deadlock (3–5s, `failureThreshold ~3`).
**A liveness probe must never call a downstream dependency** — one slow DB/cache becomes a cluster-wide
restart storm. Agent pods doing long model calls get generous startup/liveness windows so a slow inference
isn't killed mid-task. PDBs protect the control plane + shared services during node churn.

**Event-driven remediation above the cluster.** Probes handle process/node death, not application
pathologies (memory leak → OOM, stuck queue, cert near expiry, disk filling). Layer a remediation bus:
Prometheus/OTel → Alertmanager → **Aegis's existing events/outbox + Kafka** → versioned, idempotent
**auto-runbooks** with explicit blast-radius limits (restart stuck agent worker, drain a tenant hammering a
shared dependency, rotate a leaked key, clear a poison message). The outbox Aegis already runs is the
natural exactly-once trigger. **Every runbook starts in suggest/dry-run and is promoted to auto-execute only
after it survives the matching chaos scenario.**

### GitOps + IaC + policy-as-code
- **GitOps (Argo CD, Apache-2.0, CNCF graduated).** App-of-Apps + sync-waves order dependencies (policy
  engine before policies). `selfHeal + prune` auto-reverts manual `kubectl` hotfixes; **rollback = `git
  revert`**; per-tenant onboarding is a reviewed PR. Flux is the lighter alternative.
- **Policy-as-code (Kyverno, Apache-2.0, CNCF-graduated Mar 2026).** Admission controller; roll out
  **Audit → Enforce** (a violating manifest fails Argo sync, shows Degraded). **Mutate** auto-injects the
  standard probe + resource-limit + OTel block so every workload is observable + self-healing by default,
  and verifies image signatures at admission. OPA Gatekeeper (OPA is CNCF-graduated) is the heavier Rego
  option. **Trap — "two loops":** Argo `selfHeal` and a mutating webhook can fight (OutOfSync flapping);
  reconcile by reflecting the mutated end-state in Git or excluding mutated fields from diff.
- **IaC.** Crossplane (Apache-2.0, CNCF-graduated Nov 2025) provisions per-tenant cloud resources through
  the K8s API so infra is healed by the *same* Argo loop (a deleted bucket is recreated). **License trap:
  Terraform is BUSL-1.1 — not OSS.** Prefer **OpenTofu (MPL-2.0)** or **Pulumi (Apache-2.0)**; scan IaC
  pre-merge (tfsec/Checkov/Trivy).

### Autoscaling incl. scale-to-zero for idle tenants/agents
Stack three autoscalers, scaling on the **real signal, not CPU**:
- **KEDA** (Apache-2.0, CNCF graduated) scales agent workers off **Kafka lag / queue depth** (Aegis's Kafka
  is the demand signal) and **scales to zero when idle** with instant cold-start. The single biggest cost
  lever: idle tenants cost ~nothing; per-tenant cost ≈ proportional to usage, no capacity planning.
  *(Anti-pattern: HPA on CPU can't scale to zero and misses queue load.)*
- **Karpenter** right-sizes nodes under KEDA and consolidates/bin-packs to remove idle nodes.
- **HPA** for the shared API tier; **Knative** (CNCF-graduated Oct 2025) / Cloud Run for rarely-hit
  per-tenant endpoints.

### Progressive delivery + auto-rollback gated by SLOs/error budgets
**Aegis is fully autonomous here first** — highest-value, most deterministic autonomous action (bounded,
reversible; deploys cause most incidents). Every service + **agent-model upgrade** ships as an **Argo
Rollouts** canary with **AnalysisTemplates querying SLO/error-budget metrics** (API success/latency, agent
task-success rate, **model cost-per-task as a first-class SLI**). Breach → auto-rollback before most tenants
are exposed; healthy → auto-promote. SLOs are **code** (Sloth/Pyrra generate Prometheus rules); CI/CD reads
**error-budget burn** and **auto-freezes risky deploys** for any service over budget. Alert on **burn rate**,
not raw thresholds.

### AIOps / autonomous incident response + AI on-call
Distinguish classic AIOps (alert dedup/correlation) from **agentic AI SRE** (multi-step investigation). An
**AI on-call agent** (itself an Aegis agent with Tier-gated ops tools) is wired to OTel data, deploy events,
and the runbook library (candidates: PagerDuty SRE Agent, incident.io AI SRE, Cleric, Rootly — **all
proprietary SaaS**). It auto-triages, runs parallel root-cause hypotheses, **posts a cited hypothesis to
Slack**, then either fires a **pre-approved bounded runbook** (restart/rollback/scale) or **pages a human
with the analysis pre-done**. Resolved incidents enrich an **incident knowledge graph** so recurrences
become automatic. The rule is unanimous: **AI proposes, humans decide/execute** beyond well-bounded,
deploy-correlated rollbacks.

### Automated DB ops
Run Postgres on **CloudNativePG (Apache-2.0)** — declarative HA encoding DBA expertise: automated failover
(promotes most up-to-date replica; sync/quorum options), continuous WAL archiving + **PITR**, hot backups,
rolling minor upgrades, **read-replica scaling** (fits Aegis's existing prod read-replica pattern). Schema
migrations flow through **GitOps as reviewed, gated changes** — never hand-run `psql`.

### Automated security/compliance evidence + drift detection
Evidence is a **byproduct of normal operation**, feeding Aegis's **audit ledger** as the compliance trail:
- **Sign + verify everything:** SBOMs per build (Syft/Trivy), **SLSA L3** provenance, sign with
  **Sigstore/cosign** (Rekor); **Kyverno blocks unsigned/unattested images at admission**.
- **Living SBOMs** continuously enriched with VEX + drift detection.
- **External Secrets Operator** (Apache-2.0) auto-rotates DB/API/model-provider keys.
- Continuous IaC/manifest compliance scanning + Argo drift → SOC 2-style multi-tenant-boundary evidence,
  automatically.

### FinOps automation
**OpenCost** (Apache-2.0, CNCF) gives real-time per-tenant/per-namespace cost allocation. **Close the loop**
(don't leave cost as a dashboard — the ~47% idle-spend anti-pattern): feed right-sizing recommendations back
into the GitOps repo, with **Karpenter consolidation + KEDA scale-to-zero** as automatic enforcement, and
**model cost-per-task as an SLI** so cost regressions trigger the *same* canary gates as latency.

### Chaos validation
A self-healing system you haven't tried to break is a hope. Run a scheduled chaos suite (**LitmusChaos /
Chaos Mesh**, Apache-2.0, CNCF) in staging + bounded prod game-days: kill agent workers, **fail the primary
DB to force CNPG failover**, drop a tenant's queue consumer, push a deliberately-bad canary. **Promotion
gate: a runbook/failover/rollback path fires unattended only after it survives the matching injected
failure.**

### Autonomous ops control loop
```
                        ┌──────────────────────────────────────────────┐
                        │  GIT (single source of truth; only write       │
                        │  path to prod; rollback = git revert)           │
                        └───────────────┬──────────────────────────────┘
                                        │ pull / reconcile
   ┌─────────────┐   admission   ┌──────▼──────────┐    deploy as     ┌──────────────────┐
   │  Kyverno    │◀── validate ──│   Argo CD       │── canary ───────▶│  Argo Rollouts   │
   │ validate+   │   /mutate     │ selfHeal+prune  │                  │  (SLO-gated)     │
   │ mutate+sign │               └────────┬────────┘                  └────────┬─────────┘
   └─────────────┘                        │                       promote ◀────┤──▶ auto-ROLLBACK
                              ┌────────────▼───────────┐           (healthy)       (SLO breach)
                              │  RUNNING WORKLOADS      │
                              │  probes • PDBs • CNPG   │
                              │  KEDA(→0) • Karpenter   │
                              └───────────┬────────────┘
                                          │ OTel metrics/logs/traces + deploy events
                    ┌─────────────────────▼─────────────────────┐
                    │  OBSERVE: Prometheus/OTel + error budgets   │
                    └─────────────────────┬─────────────────────┘
                    ┌─────────────────────▼─────────────────────┐
                    │  DECIDE: AI SRE agent + auto-runbook lib    │
                    │  (knowledge graph; cited hypotheses)        │
                    └───────┬───────────────────────────┬────────┘
              bounded &     │                            │ novel / irreversible /
              chaos-tested  ▼                            ▼ tenant-isolation / security
              ┌───────────────────────┐        ┌────────────────────────┐
              │ ACT (unattended):      │        │ ESCALATE to human       │
              │ heal • scale(→0) •     │        │ (analysis pre-done)      │
              │ rollback • key-rotate •│        └────────────────────────┘
              │ CNPG failover          │
              └──────────┬─────────────┘
                         │ remediation expressed as a Git/outbox change → back to GIT (loop closes)
                              CHAOS suite continuously validates every ACT path
```

### What still needs a human, and how we bound it
NoOps is **augmented ops, not zero humans** — the binding constraint is human *attention*, spent only on the
genuinely novel/high-stakes/irreversible. Maturity curve: **read-only insights → advised → approval-gated →
autonomous-with-guardrails**, expanding the autonomous set as chaos-tested confidence grows.
- **Auto-allowed (unattended):** pod/node heal; metric-gated canary rollback; scale incl. scale-to-zero;
  secret/key rotation; bounded chaos-validated runbooks; CNPG failover. *(reversible, bounded, deploy-
  correlated, chaos-validated.)*
- **Always escalate:** novel/uncorrelated incidents; anything irreversible / data-loss risk; **anything
  crossing tenant isolation or exposing tenant data**; security incidents; choosing among safe remediations;
  verifying recovery; all policy/governance changes.
- A named human owns the escalation path **and** the periodic review of which actions earn promotion to
  unattended.

---

## G. Enterprise readiness & compliance

### Well-Architected multi-tenant SaaS
**Control plane vs application plane.** Aegis runs **one shared control plane** — identity, automated tenant
onboarding/offboarding, per-module entitlements/flags, agent-action metering, centralized tenant-scoped
audit, observability — governing **all** tenants uniformly regardless of app-plane isolation. This is what
makes it SaaS, not per-customer managed instances (the anti-pattern that can't scale ops or produce
consistent compliance evidence). **Agents run in the application plane; the control plane governs/observes
them.**

**Isolation tiers — pool / silo / bridge (AWS SaaS Lens), chosen per-service.** Classify every
service/store by regulatory profile + noisy-neighbor risk + cost: **Pool** (shared) for commodity modules;
**Silo** (dedicated DB/schema/stack) for premium/regulated tenants + **finance modules touching
PCI/PHI/financial records**; **Bridge** for the in-between. Isolation is **enforced at the data plane** —
per-tenant scoped short-lived credentials + **Postgres RLS** — **never app-layer `WHERE`-filtering alone**
(one missing clause or a compromised agent = cross-tenant leak = existential). Every row/object/agent action
stamped with `tenant_id`.

### Zero-trust (NIST SP 800-207)
No trust from network location; authenticate + authorize **every** request with context; assume breach;
least privilege. Agentic systems multiply **non-human identities** → every agent and module gets a
**distinct workload identity** with **narrowly-scoped, tenant-bound, short-lived credentials minted per
task** — **no agent holds standing cross-tenant access** (the anti-pattern that turns one compromised agent
into a platform-wide breach). A **PEP/PDP** evaluates **each agent tool-call** against tenant +
data-classification + action-risk before allowing it. **Encryption & keys:** envelope encryption with
**per-tenant KEKs** in an **HSM-backed KMS** (KEK never leaves KMS); TLS everywhere incl. s2s; secrets in a
vault with **automated rotation**. Per-tenant KEKs enable **crypto-shredding** — delete the tenant KEK to
render that tenant's data unrecoverable across silo, pool, **and backups** — which makes right-to-erasure
tractable.

### SOC 2 / ISO 27001 / HIPAA / PCI / GDPR — what each needs + automating evidence
Frameworks share **~70–80% control overlap → build one control set, map to many.**

| Framework | Architectural essentials |
|---|---|
| **SOC 2 Type II** | AICPA Trust Services Criteria over a period; Security mandatory, others optional. **Processing Integrity** is especially relevant to agentic finance workflows. |
| **ISO 27001** | Full ISMS; Annex A (2022) = 93 controls via a Statement of Applicability. |
| **HIPAA** | **Signed BAA** + PHI encryption in transit/at rest + access restriction + verified deletion. **SOC 2 alone does NOT satisfy HIPAA.** |
| **PCI-DSS** | Satisfied largely by **scope minimization** — never store/process card data; **tokenize + outsource to a PCI-DSS processor** so most of the env is out of scope. |
| **GDPR / CCPA** | Verified right-to-erasure across every store/backup/processor; portability (machine-readable export within 1 month); residency; consent. **Architectural, not policy-only.** |

**Automating evidence (ties to §F).** Wire control-plane telemetry — IAM, KMS config, **agent audit logs**,
CI/CD, vuln/SBOM scans, Kyverno PolicyReports, Argo drift — into a **GRC platform (Vanta/Drata/Scrut,
commercial)** that continuously collects and cross-maps one control to many frameworks. Strong autonomous-
ops fit: an agent **continuously verifies posture and opens remediation tickets on drift**. *(Anti-patterns:
manual point-in-time evidence; treating SOC 2 as sufficient for HIPAA/PCI.)*

### SRE / SLOs / error budgets
SLIs as good/total ratios; SLOs (e.g. 99.9%); error budget = 100% − SLO; alert on **burn rate**. Define SLOs
**per module and per critical agent workflow**, and treat **agent eval pass-rate as a first-class SLI**. The
**error-budget policy is machine-enforced**: autonomous-ops **halts agent-driven deploys** for any module
over budget until it recovers.

### DR (RTO/RPO) & multi-region
Define RTO/RPO **per tier**, then pick **cold** (backup/restore) → **warm** (reduced standby) → **hot**
(active-active). Premium/regulated (silo) tenants get warm/hot multi-region; pooled standard get warm.
**Automate restore drills on a schedule and measure actual RTO/RPO** — untested backups aren't a recovery
plan and won't survive regulators. **Graceful degradation:** agents fall back to **read-only / HITL safe
mode** when modules or models are unavailable rather than taking risky autonomous actions.

### Data governance
Stamp every record + agent output with **`tenant_id`, data-class, residency region**; drive
encryption/access/residency from classification; pin tenant data to a region; automate retention/expiry;
maintain a **lineage catalog** so erasure + access/portability exports assemble automatically. Build a
**control-plane deletion orchestrator** that fans erasure to every module/backup/processor **then validates
residual-data searches return nothing**, combined with **per-tenant crypto-shredding**. *(Anti-pattern:
deleting in the primary store but not every microservice/backup/processor, unverified.)*

### Supply-chain security
Per-module **SBOMs** (Syft/CycloneDX/SPDX); **SLSA L3** provenance; **Sigstore/Cosign** keyless signing →
**Rekor**; **verify signatures + provenance at deploy (Kyverno)**. SBOM (what's in it) + SLSA (built
correctly) + Sigstore (who built it). Autonomous-ops agents auto-PR vulnerable deps and block releases
failing provenance.

### AI governance
- **NIST AI RMF 1.0 — Govern / Map / Measure / Manage:** a **model/use-case registry with approval gates**
  (Govern), a **per-agent harm/impact map** (Map), an **evals + production-monitoring harness** (Measure),
  a **recurring risk-treatment cadence** (Manage). Measure/Manage are largely automatable via continuous
  evals.
- **EU AI Act — risk tiers + timeline:** four tiers; **high-risk (Annex III — incl. credit scoring, hiring,
  biometrics)** is the one that bites finance use cases. Penalties up to **€35M or 7% of global turnover**.
  Timeline: prohibited practices + AI-literacy **applied 2 Feb 2025**; GPAI **enforceable 2 Aug 2025**;
  **high-risk Annex III nominally 2 Aug 2026 — BUT the May 2026 Digital Omnibus provisional agreement defers
  Annex III to 2 Dec 2027 / Annex I to 2 Aug 2028 (pending formal adoption — TRACK THIS, the date is in
  flux).** High-risk providers must retain **auto-generated logs ≥6 months (Art. 19).** Map each Aegis agent
  use-case to a tier now.
- **ISO/IEC 42001:2023 — AIMS:** first certifiable AI management system (clauses 4–10 + 38 Annex A controls
  via a SoA). **Build the AIMS once and reuse its artifacts** (AI policy, impact assessments, lifecycle +
  data-governance + model-vendor controls) as shared evidence for AI RMF + EU AI Act — the AI analogue of
  ISO 27001.
- **Evals-as-a-control + agent-action audit:** log every agent step (tool + I/O, routing, **model + prompt
  version**, retrievals, retries, every HITL decision); runtime guardrails **pre-LLM** (PII, injection) +
  **post-LLM** (hallucination, toxicity, policy). **Continuous production evals gate higher-autonomy
  actions.** The agent audit trail is a first-class, tamper-evident, tenant-scoped control-plane log (≥6-mo
  retention for high-risk modules) — Aegis's **audit ledger**, doing double duty as compliance evidence and
  as the substrate the AI SRE agent reasons over.

### Compliance-by-design checklist → Aegis primitives
| Control objective | Aegis primitive |
|---|---|
| Provable tenant isolation (no cross-tenant leak) | **RLS** + per-tenant scoped short-lived credentials; silo tier for regulated; `tenant_id` everywhere |
| Every agent action attributable & reconstructable (Art. 19, SOC 2, HIPAA) | **Audit ledger** — tamper-evident, tenant-scoped, ≥6-mo retention |
| Per-request least-privilege authz of agent tool-calls (zero-trust) | **PEP/PDP** over tenant + data-class + action-risk |
| High-risk / consequential agent actions gated | **Approvals** (risk-tiered HITL) + eval-threshold gate |
| Feature/data access bounded to what tenant pays for | **Entitlement** (Chargebee SoR) + control-plane feature flags |
| Right-to-erasure across modules/backups | Per-tenant **KEK crypto-shred** + control-plane deletion orchestrator with verification |
| Continuous automated audit evidence | GRC platform fed by control-plane telemetry + Kyverno PolicyReports + Argo drift |
| Reliability contract enforced automatically | SLOs-as-code + machine-enforced error-budget deploy freeze |
| Supply-chain integrity | SBOM + SLSA L3 + Cosign, **verified at admission by Kyverno** |
| Model/prompt change control | Versioned model/prompt **registry with approval gates** |

---

## H. Adoption catalog (concrete OSS/SDKs)

Preference: **TS/Node-native** (Nx monorepo); reuse existing Postgres/Kafka/Chargebee; minimize vendors in
the data path given the owned, self-operated mandate. Verdicts: **Adopt / Trial / Assess / Avoid.**

> **License-trap key:** ⚠️ = read before adopting. **BUSL** (Terraform), **SSPL** (Inngest *server*),
> **BSL 1.1** (Restate), **AGPLv3** (Lago, Citus), **Llama Community License** (Llama Guard), and all
> **proprietary/managed** SaaS put data in a vendor path or carry copyleft/source-available terms.

**Agent framework:** **Claude Agent SDK** (MIT, TS) — *Adopt* (official, Claude-first, MCP-native, drops
into Nx); OpenAI Agents SDK (MIT, TS) — *Trial* (provider-portability fallback); Mastra (Apache-2.0 core,
⚠️ enterprise source-available) — *Trial* (best TS DX); LangGraph.js (MIT) — *Assess* (TS port trails
Python); CrewAI / AutoGen (Python) — *Avoid* (off-stack).

**MCP:** **MCP TypeScript SDK** (MIT) — *Adopt*; **openapi-mcp-generator** (MIT, TS) — *Adopt* (zero-lock MCP
servers from Aegis OpenAPI); MetaMCP (MIT) — *Trial* (self-hosted gateway/namespacing + OIDC); Speakeasy Gram
— *Trial*; Bifrost (Apache-2.0, Go) — *Assess* (LLM+MCP gateway in one); Composio (Apache-2.0 SDKs, ⚠️
managed) — *Assess*.

**LLM gateway:** **LiteLLM** (MIT, HTTP-agnostic) — *Adopt* (de facto OSS gateway); Portkey (Apache-2.0, TS)
— *Trial* (TS-native, guardrails built-in); Helicone — *Assess*; Cloudflare AI Gateway / OpenRouter (⚠️
proprietary) — *Assess*.

**AuthZ (augment Casbin by gap type):** **Cerbos** (Apache-2.0) — *Trial* (stateless ABAC PDP, YAML — if the
gap is policy expressiveness); **OpenFGA** (Apache-2.0) — *Trial* (Zanzibar ReBAC at scale, Postgres-backed,
TS SDK); SpiceDB — *Assess* (only if Zanzibar-grade consistency needed); Cedar/AVP, Oso, Permit.io/OPAL — *Assess*.

**Billing / metering:** **Chargebee** (⚠️ proprietary) — *Adopt* (incumbent, subscriptions/entitlements SoR);
**OpenMeter** (Apache-2.0, Go) — *Adopt* (**Kafka-native**, AI-usage metering feeding entitlements/Chargebee);
Lago (⚠️ **AGPLv3**) — *Trial* (legal review for SaaS mods); Kill Bill — *Avoid* (overlaps Chargebee).

**Voice:** **LiveKit Agents** (Apache-2.0) — *Trial* (top OSS realtime, self-host); OpenAI Realtime (⚠️
proprietary) — *Trial* (the model, not infra); Pipecat (BSD-2) — *Assess* (off-stack); Vapi/Retell (⚠️
proprietary) — *Assess* (POC speed only).

**Durable execution:** **DBOS Transact (TS)** (MIT) — *Trial* (**reuses existing Postgres**, lowest-ops);
Inngest (SDKs Apache-2.0, ⚠️ **server SSPL**) — *Trial* (best TS DX); Temporal (MIT, TS SDK) — *Trial*
(gold-standard, heavy infra); Restate (⚠️ **BSL 1.1**) — *Assess*.

**Generative UI:** **Vercel AI SDK** (Apache-2.0, TS) — *Adopt* (default TS substrate); **AG-UI** (MIT) —
*Trial* (open agent↔UI protocol, avoids lock-in); CopilotKit (MIT) — *Trial*; assistant-ui (MIT) — *Assess*;
A2UI — *Assess* (too early); thesys C1 (⚠️ proprietary) — *Assess*.

**Eval / observability:** **Langfuse** (MIT core, TS) — *Adopt*; **OpenLLMetry/Traceloop** (Apache-2.0) —
*Adopt*; **OTel GenAI conventions** (Apache-2.0; OTel CNCF-graduated May 2026) — *Adopt*; **Promptfoo** (MIT,
TS) — *Adopt* (CI eval + red-team — the autonomy gate); Braintrust (⚠️ proprietary) — *Assess*.

**Vector / RAG (stay in Postgres):** **pgvector** (PostgreSQL License) — *Adopt* (inherits RLS tenancy +
backups/ops); **pgvectorscale** (PostgreSQL License) — *Adopt* (DiskANN scale-up in Postgres); LanceDB
(Apache-2.0) — *Assess*; Turbopuffer (⚠️ proprietary) — *Assess* (only at billions of vectors); Pinecone (⚠️
proprietary) — *Avoid* (redundant vs pgvector + egress).

**Infra / scale:** **Argo CD**, **KEDA** (Apache-2.0, CNCF graduated) — *Adopt*; **PgBouncer** (ISC) —
*Adopt* (⚠️ mind RLS/`SET` in transaction-pooling); Karpenter, CloudNativePG (Apache-2.0) — *Adopt*; PgCat
(MIT) — *Trial* (read-replica splitting); Supavisor — *Assess*; Citus (⚠️ **AGPLv3**) — *Assess* (sharding
when single-node limits hit; validate RLS+sharding).

**Guardrails:** Llama Guard (⚠️ **Llama Community License**) — *Trial*; NeMo Guardrails (Apache-2.0) —
*Assess*; Guardrails AI (Apache-2.0) — *Assess*; Rebuff / LLM Guard (Apache-2.0/MIT) — *Assess* (prompt-
injection detection).

### Default starting stack
**Claude Agent SDK** · **MCP TS SDK + openapi-mcp-generator** (capabilities from existing OpenAPI, zero
lock-in) · **LiteLLM** (one HTTP gateway: routing/cost/fallback) · **Cerbos** now / **OpenFGA** when ReBAC
needed (augment Casbin by gap, don't rewrite) · **Chargebee + OpenMeter** (subscriptions SoR + Kafka-native
usage metering) · **DBOS** (durable agent workflows on the Postgres you already run) · **Vercel AI SDK +
AG-UI** (TS model I/O + streaming UI, open protocol) · **Langfuse + OpenLLMetry + Promptfoo** (tracing/eval
hub + CI eval/red-team — prerequisite for safely expanding autonomy) · **pgvector (+pgvectorscale)** (RAG in
Postgres, inherits RLS) · **Argo CD + KEDA + CloudNativePG + PgBouncer** (GitOps, Kafka scale-to-zero,
self-healing Postgres+PITR, pooled connections).

**Deferred-but-watch:** Temporal/Inngest (heavier durable exec — Inngest server SSPL), LiveKit (voice when
needed), Llama Guard/LLM Guard (guardrail service), Karpenter (node cost), a GRC SaaS (Vanta/Drata) to
auto-harvest §F telemetry into compliance evidence.

---

## I. Pricing for an agentic + modular platform

The agentic market has converged on **usage/outcome pricing**, and it must be reconciled with
per-module pricing:
- **Per-module base (subscription) + per-action/credit usage with complexity multipliers** is the right
  blend: the base **protects margin against the 5–10× cost variance** between easy and hard agent tasks
  (Devin's ACU model, ServiceNow's 10–25 units for autonomous closure); usage tracks value. A light
  module action = 1 credit; a heavy AI/voice action = 10+.
- **Meter on the plutus dual-ledger**; attribute every token to tenant+user+module (E.6/E.8).
- **Give buyers cost guardrails** — real-time consumption dashboards, threshold alerts, spend caps,
  auto-top-up. **Never hard-stop** a production agent (Lindy's reliability-killer); the #1 complaint
  across Copilot/ServiceNow is unpredictable credit bills.
- **Outcome pricing** (Sierra/Intercom Fin $0.99/resolution) is the strongest "replace humans" signal
  but only where the outcome is crisply instrumentable and auditable — viable for the support/help
  surface, risky for open-ended action. Offer it selectively.

---

## J. Roadmap (extends the modular-platform plan)

Adds the agentic + scale + autonomous-ops workstreams on top of the modular plan's NOW/NEXT/LATER.

### NOW (0–3 months) — agent runtime MVP on the governed core
| Deliverable | Lift from | Effort |
|---|---|---|
| **Auto-generated tool registry** from the router-stack walk + Joi→JSON Schema + Permission metadata | `pep-assertion.ts findUnguardedRoutes`, validators | M |
| **Agent-as-principal** (scoped JWT, OBO via RFC 8693) — every tool call hits PEP→RLS | `internal-auth.ts`, `pep.ts` | M |
| **Orchestrator + 1–2 specialist subagents** (text chat) on a durable engine | Claude Agent SDK / LangGraph; oe_core LangChain agent | L |
| **LLM gateway + per-tenant token budgets + cost attribution** (v1) | LiteLLM | M |
| **Risk-tiered HITL** wiring (Tier 4 → `@aegis/approvals`) | approvals lib, workflow `runRule(dryRun)` | M |
| **Agent audit trace** (`agent.*` AuditActions) + activity-feed surfacing | `libs/audit`, `libs/activity` | S |
| **Input/output guardrails** | NeMo + Guardrails AI | M |
| **Self-knowledge RAG** (pgvector per-tenant over manifests+docs+audit) | pgvector | M |
| **Casbin scale benchmark** + RLS subquery/leading-index audit + PgBouncer `SET LOCAL` discipline | — | M |
| **Tracing + sampled evals** | Langfuse | S |

**Milestone:** a user runs an existing flow (e.g. submit + approve an expense) **entirely by chatting**,
with the action executed through the normal PEP/RLS/audit path and a Tier-4 step gated by approvals.

### NEXT (3–9 months) — voice, generative UI, self-serve buying, scale-out
| Deliverable | Lift from | Effort |
|---|---|---|
| **Voice modality** (Whisper + realtime; LiveKit/Pipecat) | emporio voice pipeline | L |
| **Generative UI** (A2UI + AG-UI) | — | L |
| **Self-serve module buying via the agent** (provision through Entitlement Service) | modular plan, Chargebee | M |
| **OpenFGA behind the PEP** for resource/relationship authz | OpenFGA | L |
| **Durable async agent work via outbox** + repartition-by-tenant Kafka | `libs/events`, oe-connect step machine | M |
| **Per-module metering on dual-ledger** | plutus `CreditUsageDao` | M |
| **Autonomous-ops v1**: GitOps + KEDA + SLO-gated rollouts + AI on-call (Tier 1–2) | F | L |
| **Multi-tier cache + noisy-neighbor quotas** | E.9 | M |

### LATER (9–18 months) — full autonomy, marketplace agents, verticals
| Deliverable | Effort |
|---|---|
| Citus shard-out by tenant; whale isolation | L |
| Third-party module MCP servers + sandbox + agent tool governance at scale | XL |
| Autonomous-ops v2 (AIOps anomaly detection, chaos, auto-remediation Tier 3) | L |
| AI-governance certifications (ISO 42001) + EU AI Act conformity | L |
| Vertical agent packs (Fintech/AP, Construction — dogfood at SiteRecon) | M |

---

## K. Key risks & open decisions

1. **Cost-per-tenant of always-on agents.** Agentic margins compress to 50–60% unmanaged. The gateway +
   budgets + caching + cascades + scale-to-zero (E.6/F) are *mandatory v1*, not optimizations. **Open:**
   the pricing floor (base retainer) must cover the compute floor — model it before GA.
2. **Can regulated finance really run zero-support?** No — run **tiered**: agent handles the bulk,
   bounded human escalation for the long tail (the Klarna lesson). The "human" for risky *actions* is the
   tenant's own approver (HITL), not Aegis staff. Decide the platform-escalation staffing floor.
3. **Eval/regression across many modules.** With dozens of modules × tools, agent behavior must be
   regression-tested. **Build an eval harness (Langfuse + Promptfoo) per module from the start** — treat
   evals as a release gate (and an EU AI Act / ISO 42001 control).
4. **Determinism for compliance.** Auditors need reproducible authorization. The deterministic-core rule
   (§0) is what makes agent actions auditable — never let the LLM be the authorization decision.
5. **The Casbin bet.** Benchmark in NOW; commit to the OpenFGA augmentation path before resource-level
   authz volume arrives.
6. **In-process vs per-tenant agent/module versioning** (carried from the modular plan): first-party
   in-process modules upgrade fleet-wide in lockstep; per-tenant versioning is for out-of-process
   modules only.
7. **Voice & generative-UI scope.** High value but heavy; gate on real demand. Voice economics flip to
   self-host above ~50k min/mo.
8. **Build vs maturity of lifted code.** emporio/oe_core agentic code is real but provider-locked
   (OpenAI/Gemini) and pipeline-shaped, not a tool-calling loop; plutus is Java 8 with zero test coverage
   on financial code. **Harden before lifting** — especially anything that becomes billing
   source-of-truth.

---

*Drafted from verified internal + external research across eleven clusters: agentic platforms,
MCP/capability exposure, agent orchestration, agent authz/safety, LLM scale economics, multi-tenant
infra, autonomous operations, enterprise readiness/compliance, and the adoption catalog. All sections
(A–K) are complete. Volatile pricing/figures/dates marked APPROX or verified inline (notably the EU AI
Act high-risk timeline, in flux pending the May 2026 Digital Omnibus) — re-confirm at contract/build
time. Recommended next step: an adversarial red-team pass before treating this as buildable.*
