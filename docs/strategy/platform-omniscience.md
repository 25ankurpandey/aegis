# Platform Omniscience — The Aegis Diagnostic / Remediation / Data-Export Plane

> **Track 1 of the Aegis agentic strategy.** Companion to
> [agentic-platform-design.md](./agentic-platform-design.md) (the governed agent, tool registry,
> agent-as-principal, risk-tiered HITL, LLM gateway, autonomous ops §F), and
> [ai-native-core.md](./ai-native-core.md) (AI-in-the-core, the minimal viable contract §0.5/§8,
> `@aegis/ai-core`). Read those two first — this doc **reuses their substrate wholesale** and adds one
> capability: an operator/agent that can reach across **all codebases, all databases, cache, logs,
> metrics, queues, the audit ledger, and CI/CD**, gather context, localize an issue, and — behind the
> four gates — fix it, or fulfil an arbitrary governed data/export request.
>
> **The founder's question, answered in one line up front:** *Yes — this is buildable on the Aegis
> substrate, and Aegis is unusually well-positioned to build it, because the hard part (per-request
> authorization, tenant isolation, tamper-evident audit, maker-checker approvals, a durable agent
> runtime, and an auto-generated authz-bound tool registry) already exists.* The honest caveat: the
> **diagnostic (read) plane is ~90% assembly of mature OSS today**; the **remediation (write) plane is
> propose-only for anything irreversible and stays that way** — the industry consensus (Datadog, Cleric,
> incident.io, Traversal, Resolve.ai) is unanimous that AI **proposes, humans decide/execute** beyond a
> narrow set of bounded, reversible, deploy-correlated actions. This doc makes that line precise and
> shows exactly what falls on each side.

---

## 0. TL;DR for an implementer

The Omniscience Layer is **three planes over one governed substrate**, each an application of patterns
already specified in the two companion docs:

| Plane | What it does | Write? | Reuses | Industry proof |
|---|---|---|---|---|
| **Diagnostic** (read) | MCP servers over every system — DB read-replica, Redis, Kafka, logs/traces (OTel), Sentry, Grafana/Prom/Loki, GitHub, K8s, the audit ledger — an agent forms hypotheses, queries in parallel, localizes the fault | **No** (read-only by construction) | Agent runtime, tool registry (RAG-over-tools), Langfuse tracing | Cleric, Traversal, Bits AI SRE, incident.io, Resolve.ai |
| **Remediation** (write) | Fix-as-PR on `auto/*` branches (never push), bounded chaos-tested runbooks behind the danger layer, config via GitOps PR | **Propose-only** except a narrow chaos-validated auto set | `@aegis/approvals` (Tier-4 HITL), autonomous-ops §F, agent-as-principal | Sentry Seer/Autofix, OpenHands resolver, Claude Code headless "propose-PR-never-push" |
| **Data / export** (governed read + egress) | NL→query over the multi-tenant DB, RLS-scoped, read-replica, cost-capped; export gated by the danger layer | Read + **gated egress** | Tool registry, RLS (`withTenantTransaction`), plutus metering, approvals | AWS multi-tenant RLS text-to-SQL, Postgres MCP Pro restricted mode |

**The four gates (from agentic-platform-design.md) apply to every action in every plane:**
`AUTHORIZATION × DANGER × AUTONOMY × VERIFIABILITY`. Read actions clear DANGER trivially (Tier 1) but
still pass AUTHORIZATION (RLS + PEP) and VERIFIABILITY (cited evidence). Writes must clear all four,
and irreversible writes are pinned to **propose-only** in code.

**Self-growth claim (confirmed, with one caveat):** because the tool registry is **auto-generated from
the live route stack** (route-walk + Joi→JSON Schema + `Permission`, ai-native-core.md Facet 1), any
**new module's governed operations auto-appear** in the data/export plane and the remediation plane's
"act via a module op" path **with zero manual setup**. The **infra-facing diagnostic MCP servers**
(Postgres/Redis/Kafka/OTel/GitHub/K8s) are a **fixed, finite set wired once** — they do *not* grow
per-module, and they shouldn't (there are only so many infra substrates). New *observability signals*
from a new module appear automatically **iff** the module emits through the standard OTel/audit/event
paths the kernel already mandates. §9 makes this end-to-end mechanism explicit.

---

## 1. Feasibility verdict (direct answer to the founder)

> *"When there is a platform issue to debug, or a user wants any data/export/custom thing, the AI should
> connect across ALL codebases, ALL databases, cache, logs, metrics, queues — gather context, find where
> the issue actually is, and fix it. Is this possible with the AI infrastructure we are building?"*

**Feasible, in three honesty tiers:**

**(A) Fully feasible today, mostly assembly, low risk — the diagnostic plane.** Every system you named
already has a mature, mostly-official, read-only-capable MCP server (§3). The "gather context across
everything, form hypotheses, test them in parallel, localize the fault, post a cited root cause" loop is
exactly what five production AI-SRE products already ship (Cleric, Traversal, Datadog Bits AI SRE,
incident.io, Resolve.ai — §2). None of them invented new substrate; they connect an agent to existing
telemetry/code/infra and reason. Aegis has the *same* connect-and-reason substrate (agent runtime + tool
registry + LiteLLM gateway + Langfuse), **plus** two things those products lack: a hash-chained
**audit ledger** that records permissions-at-time-of-action and agent tool-call traces (a first-class
diagnostic *and* compliance signal), and **RLS tenant isolation** so a diagnostic query cannot leak
across tenants. Verdict: **build it; you are ahead, not behind.**

**(B) Feasible but deliberately bounded — the remediation plane.** "Fix it" splits sharply:

- *Fix-as-PR* (code changes): fully feasible, and the safe pattern is settled — the agent works on an
  `auto/*` branch, opens a PR against a non-shipping branch, **never pushes to main, never deploys**, and
  a deterministic verifier (tests/lint/typecheck) plus a human gate the merge. Sentry Seer/Autofix,
  OpenHands resolver, and Claude Code headless all do exactly this (§2, §6).
- *Runbook execution* (restart a stuck worker, drain a hammering tenant, clear a poison message, rotate a
  leaked key, scale, CNPG failover, canary rollback): feasible **unattended only** for the bounded,
  reversible, **chaos-validated** set already enumerated in agentic-platform-design.md §F. Everything
  novel/irreversible/tenant-isolation-crossing/security stays **propose-only, human-executed**.
- *Config changes*: only via **GitOps PR** (Git is the sole write path to prod), never direct mutation.

The thing that is **NOT** possible/safe and must not be built: an agent with **standing write access** to
prod DBs, infra, or main-branch that "just fixes it." That is the confused-deputy/cost-bomb/cross-tenant
footgun the whole substrate exists to prevent. The remediation plane is **propose-heavy by design, not by
immaturity.**

**(C) Feasible with governance you already have — the data/export plane.** "Give me any data I'm allowed
to see, in any shape, exported" is a governed NL→query problem. The safe recipe is known (AWS's
multi-tenant RLS text-to-SQL reference; Postgres MCP Pro's restricted mode) and maps 1:1 onto Aegis
primitives: RLS-scoped read-replica connection, `EXPLAIN`-gated cost caps, read-only transaction, and
**export as a danger-gated action** (egress of tenant data is Tier 3–4, metered, audited). §7.

**What is genuinely hard / open (honest limits) — §10:** cross-repo semantic context at scale (the
"second brain"); NL→SQL correctness on a large evolving schema; keeping the infra-MCP fleet's blast
radius truly read-only under adversarial prompts; approval fatigue on the remediation plane; and the cost
of always-parsing telemetry. None of these are blockers; all are managed risks with known mitigations.

---

## 2. Research: how production AI-SRE / debugging / coding agents actually work

The five leading AI-SRE products converge on **one architecture**, which validates the Aegis design and
tells us what to copy and what to avoid.

### 2.1 The convergent AI-SRE pattern (copy this)

Every product below implements the **hypothesize → query-in-parallel → verify → localize → propose**
loop, connecting an agent to *existing* telemetry/code/infra rather than introducing new substrate:

- **Cleric** ([cleric.ai](https://cleric.ai/), [technology](https://cleric.ai/technology),
  [ZenML case study](https://www.zenml.io/llmops-database/ai-agent-for-automated-root-cause-analysis-in-production-systems)):
  five-component architecture — **Investigation Engine** (forms hypotheses, queries the env to test
  them, proposes a root cause), **Decision Model** (learned unsupervised from the traces engineers/agents
  leave — which alerts are noise, service deps, past resolutions), **Verification Engine** (grades the
  answer *from the environment, no human in the loop*), **Calibration Engine** (replay/self-play turns
  verified outcomes into better strategies), **Discovery Engine** (maps your env so it reasons against
  *your* stack). Deployed **in the customer's VPC**; **"doesn't introduce new tools into the
  environment"** — operates like an engineer querying existing systems. Retains memory of past
  investigations. **Two Aegis lessons: (1) verification must be automatic and environment-grounded, not
  self-asserted; (2) don't invent new infra — reuse what exists** (Aegis's audit ledger is the
  ready-made "traces engineers leave" that Cleric has to learn from scratch).

- **Traversal** ([traversal.com](https://www.traversal.com/),
  [what-is-an-ai-sre](https://www.traversal.com/blog/what-is-an-ai-sre)): a **Production World Model** +
  **Causal Search Engine** that "systematically traverse complex dependency maps" to find the smoking-gun
  logs and problematic code changes — **maps a failure back to its origin even 5/10/15 hops from the
  symptom.** RCA in **2–4 minutes vs hours**, **82%+ accuracy** across enterprise customers (Amex,
  PepsiCo). **Aegis lesson: the dependency graph is the substrate that makes multi-hop RCA work** — Aegis
  can build this from the module manifest (`dependsOn`), the event topology (`events.emits/consumes`), and
  OTel service maps, without inference.

- **Datadog Bits AI SRE** ([blog](https://www.datadoghq.com/blog/bits-ai-sre/),
  [deeper-reasoning](https://www.datadoghq.com/blog/bits-ai-sre-deeper-reasoning/),
  [eval platform](https://www.datadoghq.com/blog/engineering/bits-ai-eval-platform/)): "mimics how human
  SREs think — forms hypotheses, tests them using live telemetry, follows evidence to a root cause."
  Restores service "90% faster," produces **audit-ready RCA**. As of 2026: data access widened to
  **source code, events, RUM, DB monitoring, network path, profiler**; **remediation actions**
  (Trigger/Get/List Investigation) usable in workflows; **~2× faster**. They published a whole
  engineering post on **building a real-world eval platform for autonomous SRE agents** — evals are the
  gate. **Aegis lesson: (1) an AI-SRE needs its own eval harness (we have Langfuse+Promptfoo,
  ai-native-core.md Facet 6); (2) "audit-ready RCA" is a first-class output — the Aegis audit ledger
  makes every hypothesis and action attributable by construction.**

- **incident.io AI SRE** ([incident.io/ai-sre](https://incident.io/ai-sre),
  [ZenML](https://www.zenml.io/llmops-database/ai-powered-incident-response-system-with-multi-agent-investigation)):
  a **multi-agent** system — investigations auto-spawn on incident creation, run **parallel searches**
  across GitHub PRs, Slack, historical incidents, logs/metrics/traces, spawn sub-agents that report back
  to a **main reasoning loop** (models a human IR team), present a report in Slack in **1–2 min**, and
  stay an **ambient agent** that resumes as new info arrives. Recommends **act-now vs defer**. **Aegis
  lesson: the orchestrator-worker/subagent pattern (agentic-platform-design.md §C.1) is exactly right for
  RCA — context isolation via subagents keeps the lead agent's window clean while workers sift logs.**

- **Resolve.ai** ([resolve.ai/product](https://resolve.ai/product),
  [ai-sre](https://resolve.ai/product/ai-sre)): **multi-agent** over **code + services + infra +
  telemetry**, foundation is a proactively-built **real-time knowledge graph** ("Deep System
  Comprehension") mapping services→infra→code deps→telemetry; uses AWS/K8s/GitHub/Slack **"just like a
  human engineer,"** joins data across observability/infra/code/release pipelines, surfaces root cause +
  dependency chain + evidence-backed timeline. **Aegis lesson: the knowledge graph is the durable asset;
  Aegis assembles it cheaply from the manifest + event topology + audit lineage rather than inferring.**

- **PagerDuty / Rootly / others** (from the [awesome-ai-sre](https://github.com/agamm/awesome-ai-sre)
  catalog): same pattern; all proprietary SaaS. **Aegis lesson: this is a build (OSS MCP + our runtime),
  not a buy — because our differentiator is that the diagnostic plane must run *inside* our governance
  substrate (RLS, audit, per-tenant isolation), which a third-party SaaS cannot honor.**

### 2.2 Coding agents against production codebases + safe-fix patterns

- **Sentry Seer / Autofix**
  ([docs](https://docs.sentry.io/product/issues/issue-details/sentry-ai/),
  [autofix](https://docs.sentry.io/product/ai-in-sentry/seer/autofix/),
  [traces blog](https://blog.sentry.io/sentry-ai-debugger-autofix-superpower-traces/)): three steps —
  **Root Cause Analysis → Solution Identification → Code Generation.** Uses issue details + **distributed
  tracing data end-to-end** (finds cross-service root causes, fixes touching **more than one repo at
  once**) + the integrated GitHub/GitLab codebase. **Can propose a solution or open a PR**; configurable
  to auto-run on issues it's confident about, **fixes show up as PRs ready to review**; can **hand off to
  a coding agent** (Cursor/Copilot/Claude) with full context. **Aegis lesson: propose-PR is the ceiling
  for autonomous code changes; cross-repo tracing is the enabler — Aegis needs a unified trace/session id
  across gateway→agent→tool→event→saga (agentic-platform-design.md §E.10) so RCA can cross repos.**

- **OpenHands** ([github](https://github.com/OpenHands/OpenHands), MIT, ~68k stars, $18.8M Series A;
  [resolver blog](https://www.openhands.dev/blog/open-source-coding-agents-in-your-github-fixing-your-issues);
  [software-agent-sdk](https://github.com/OpenHands/software-agent-sdk)): the **resolver** auto-fixes
  GitHub issues tagged `fix-`, runs as a **GitHub Action**, produces **a PR or a branch with intermediate
  progress**. Agent runs in a **sandboxed Docker runtime** (terminal, editor, browser, filesystem) —
  **"excellent at containing blast radius (the agent can't escape the container)."** There is an open
  issue explicitly on **"Authority separation for autonomous coding agents"**
  ([#13150](https://github.com/OpenHands/OpenHands/issues/13150)) — the same principle Aegis enforces.
  **Aegis lesson: the sandboxed-repro runtime is the reusable piece — run the fix-and-verify loop in an
  ephemeral sandbox, never against prod, and gate the PR on the sandbox's green tests.** (Adopt-candidate,
  §8.)

- **Devin / Cognition** ([review](https://aitoolranked.com/blog/devin-ai-review)): long-horizon planning,
  **sandboxed** shell/browser/editor, sub-agents; **excels at well-defined bounded tasks**, struggles
  with deep business context / novel architecture / ambiguity; practitioners **cap ACU per session**.
  **Aegis lesson: scope autonomous fixes to bounded, well-specified defects; log ambiguous/architectural
  ones for a human (mirrors the ai-native-core.md §5.1 dev-trio "architectural changes are LOGGED, never
  auto-applied").** Proprietary → not an adopt candidate; a *behavioral* model only.

- **Claude Code headless / Agent SDK**
  ([headless docs](https://code.claude.com/docs/en/headless),
  [CI/CD writeup](https://hidekazu-konishi.com/entry/claude_code_cicd_and_headless_automation.html)):
  runs unattended (`-p`), triggered by push/PR-comment/cron; the settled safe pattern — **"the routine
  cannot push to main and cannot deploy; its most powerful action is opening a PR against a branch that
  does not ship on its own, where a human gates the merge,"** plus **hard rules the prompt can't override**
  (no writes outside workspace, no `git push`, no deletes of protected paths) and **pair the agent with a
  verifier — the agent proposes; the deterministic check disposes.** **This is verbatim the Aegis
  remediation-plane contract** (§6) and it's the same SDK the agent runtime is built on
  (agentic-platform-design.md §H "Claude Agent SDK — Adopt"). **Adopt.**

### 2.3 The one universal rule extracted from all of the above

> **AI proposes; humans (or a deterministic verifier + narrow chaos-tested runbook set) decide and
> execute.** Read is autonomous; irreversible write is propose-only; the gap between them is closed only
> by *environment-grounded verification* + *chaos-validated promotion*, never by model confidence.

This is already the Aegis position (agentic-platform-design.md §D.4 risk tiers, §F autonomous-ops
promotion gate). The Omniscience Layer inherits it unchanged.

---

## 3. Research: the MCP server ecosystem (the diagnostic plane's connectors)

Every system the founder named has a mature, mostly-official, read-only-capable MCP server **today**.
This is why the diagnostic plane is "assembly, not invention." Concrete repos, maturity, and license:

| System | Repo | License / maturity | Read-only story | Verdict |
|---|---|---|---|---|
| **Postgres (prod read-replica)** | [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp) ("Postgres MCP Pro") | **MIT**, ~3k★, active | **Restricted mode**: read-only transactions, **pglast** SQL parsing rejects `commit`/`rollback`, **execution-time cap**; `EXPLAIN`, industrial-strength **index tuning**, **DB health** (buffer cache, conn health, vacuum, replication lag). *Caveat: unsafe stored-proc languages can circumvent read-only — disable them.* | **Adopt** for the data/export + DB-diagnostic plane (point at the read replica; restricted mode) |
| **Postgres (AWS-native)** | [awslabs Aurora Postgres MCP](https://awslabs.github.io/mcp/servers/postgres-mcp-server) | AWS Labs, official | Dedicated Postgres role with minimal privileges | Assess (if on Aurora) |
| **Redis** | [redis/mcp-redis](https://github.com/redis/mcp-redis) | **Official Redis**, active | NL interface over hashes/lists/sets/streams; scope via ACL user | **Adopt** (read-scoped ACL user) |
| **Kafka** | [confluentinc/mcp-confluent](https://github.com/confluentinc/mcp-confluent) | **Official Confluent**, 50+ tools (Kafka, Flink SQL, Schema Registry, Connectors) | Scope via Kafka ACLs / read-only API key; consumer-lag + DLQ inspection | **Adopt** (read-only API key; lag/DLQ diagnostics) |
| **GitHub (code)** | [github/github-mcp-server](https://github.com/github/github-mcp-server) | **Official GitHub, MIT** | **`--read-only` flag** ("write tools are skipped even if explicitly requested"); **23 granular toolsets** (repos, issues, pull_requests, actions, code_security, git…); remote (`api.githubcopilot.com/mcp/`) or local; OAuth / PAT / Enterprise | **Adopt** — read-only + toolset-scoped for diagnosis; a *separate*, write-scoped instance for the fix-as-PR path only |
| **Grafana + Prometheus + Loki** | [grafana/mcp-grafana](https://github.com/grafana/mcp-grafana), [grafana/loki-mcp](https://github.com/grafana/loki-mcp) | **Official Grafana**, active | Dashboards, datasources (Prom, Loki), alerting, incidents, OnCall; scope via Grafana service-account (Viewer role) | **Adopt** (Viewer-scoped service account) |
| **OTel traces** | [traceloop/opentelemetry-mcp-server](https://github.com/traceloop/opentelemetry-mcp-server) | Traceloop, active | Unified query over Jaeger/Tempo/Traceloop; OpenLLMetry conventions; read-only by nature | **Adopt** (aligns with agentic-platform-design.md §E.10 OpenLLMetry) |
| **Sentry** | [getsentry/sentry-mcp](https://github.com/getsentry/sentry-mcp) | **Official Sentry**, remote at `mcp.sentry.dev` | Read-oriented ("designed for human-in-the-loop coding agents"); Seer handoff | **Adopt** (if Sentry is in the stack) or rely on OTel |
| **Kubernetes** | [containers/kubernetes-mcp-server](https://github.com/containers/kubernetes-mcp-server) (+ [openshift fork](https://github.com/openshift/openshift-mcp-server)); read-only alt [patrickdappollonio/mcp-kubernetes-ro](https://github.com/patrickdappollonio/mcp-kubernetes-ro) | Active; **⚠️ CVE-2026-46519 read-only bypass fixed in v3.6.0 — pin ≥ 3.6.0** | **`--read-only` flag**; or a dedicated read-only build | **Adopt** (pin ≥3.6.0; back it with a genuinely read-only K8s RBAC ServiceAccount — defense in depth, don't trust the flag alone) |

**Cross-cutting hard rule (the CVE lesson):** the MCP server's own `--read-only` flag is **necessary but
not sufficient**. Every diagnostic MCP server must connect through **credentials that are themselves
read-only at the source** (Postgres read replica + read-only role; Redis ACL read user; Kafka read-only
API key; Grafana Viewer SA; K8s read-only RBAC SA; GitHub read-only-toolset PAT). CVE-2026-46519 (a
read-only *bypass* in a K8s MCP server) proves the flag can fail; the credential is the real boundary.
This is the exact "zero-trust, least-privilege, distinct workload identity per non-human actor" principle
in agentic-platform-design.md §G.

**Deployment note:** front the whole fleet with an **MCP gateway** (MetaMCP/Bifrost pattern already
chosen in agentic-platform-design.md §C.2/§H) so the servers→namespaces→endpoints, per-key allow-lists,
and entitlement-filtered single-round-trip listing all apply to the diagnostic tools too.

### 3.1 Text-to-SQL / governed data access research

- **AWS multi-tenant LLM analytics with RLS**
  ([blog](https://aws.amazon.com/blogs/machine-learning/multi-tenant-llm-analytics-with-row-level-security-how-we-built-a-secure-agent-on-aws/)):
  a production **three-layer** recipe — (1) cryptographic request signing (identity provenance), (2)
  **semantic validation** on the model (reject under-specified questions that would broaden data access),
  (3) **programmatic data isolation via "Split-Plane SQL"** so the generated SQL only ever runs
  RLS-scoped. **Aegis lesson: don't trust the LLM to scope — the RLS session var does it deterministically
  (`withTenantTransaction`); the LLM's SQL runs *inside* an already-scoped read-only transaction, so a
  mis-generated `WHERE` cannot cross tenants.** The AWS "semantic validation to reject vague questions
  that broaden access" maps to an input guardrail (agentic-platform-design.md §D.3).
- **Postgres MCP Pro restricted mode** (above): the concrete enforcement primitives — read-only txn +
  SQL parse + execution-time cap — are the cost-cap/read-only mechanics for §7.

---

## 4. The Omniscience Layer — architecture

```
 ┌── OPERATOR / TENANT ────────────────────────────────────────────────────────────────────────┐
 │  platform operator: "why are Kafka consumers lagging for tenant X?"                            │
 │  tenant user:       "export every invoice I approved in Q2 as CSV"                             │
 └───────────────────────────────┬───────────────────────────────────────────────────────────────┘
                                  │  utterance (+ principal, tenant, session id)
                                  ▼
 ┌── @aegis/ai-core ORCHESTRATOR (unchanged runtime; agentic §C.1) ──────────────────────────────┐
 │  input guardrails → retrieve tools (entitlement ∩ permission, RAG-over-tools) → plan →         │
 │  route to plane subagent → per action: 4-GATE check → verify → generative-UI render            │
 │  runs on durable engine (DBOS/Temporal): pauses for approvals for hours w/o holding compute    │
 └───────┬───────────────────────────────┬───────────────────────────────────┬───────────────────┘
         ▼ (Tier 1)                       ▼ (propose-only / bounded auto)      ▼ (read + gated egress)
 ┌── DIAGNOSTIC PLANE (read) ──┐   ┌── REMEDIATION PLANE (write) ──────┐  ┌── DATA/EXPORT PLANE ─────┐
 │ read-only MCP fleet, each    │   │ FIX-AS-PR: sandboxed repro →      │  │ NL→query over read replica│
 │ on read-scoped creds:        │   │  auto/* branch → PR to non-ship   │  │ RLS-scoped (withTenantTxn)│
 │  • Postgres (read replica)   │   │  branch → verifier(tests) gates   │  │ EXPLAIN cost-cap, RO txn  │
 │  • Redis (ACL RO)            │   │  → HUMAN merges. NEVER push main. │  │ statement timeout         │
 │  • Kafka (lag/DLQ, RO key)   │   │ RUNBOOKS: bounded, chaos-tested   │  │ EXPORT = danger-gated     │
 │  • OTel traces / Grafana     │   │  auto set only; rest propose-only │  │  (Tier 3–4) + metered +   │
 │  • Sentry                    │   │  behind @aegis/approvals Tier 4   │  │  audited egress           │
 │  • GitHub (RO toolset)       │   │ CONFIG: GitOps PR only            │  │ via AUTO-GENERATED module │
 │  • K8s (RO RBAC SA)          │   │  (Git = sole write path to prod)  │  │  tools + a governed SQL   │
 │  • AUDIT LEDGER (RLS)  ★     │   │ agent-as-principal, OBO delegation│  │  read tool                │
 └──────────────┬───────────────┘   └───────────────┬───────────────────┘  └───────────┬───────────────┘
                │ every call = a read via read-only cred                    │ every call = withTenantTransaction (RLS)
                ▼                                                           ▼
        ┌── VERIFY (Cleric/Bits pattern) ──┐              ┌── GOVERNED CORE (unchanged) ──────────┐
        │ environment-grounded re-check OR │              │ authenticate → authorize(PEP) → RLS →  │
        │ 2nd-agent adjudication; cited     │              │ module op → AUDIT (hash-chained) +    │
        │ evidence required; no self-assert │              │ events/outbox                          │
        └───────────────────────────────────┘              └────────────────────────────────────────┘
                │ every hypothesis + action + approval → AUDIT LEDGER (agent.* AuditActions)
                ▼  (which the diagnostic plane can then read — the loop closes: the ledger is both
                    the record of what the agent did AND a primary diagnostic signal)
```

**Key structural facts:**

1. **The diagnostic plane is read-only *by credential*, not by trust.** No diagnostic action can mutate
   anything because the underlying connection physically cannot.
2. **The remediation plane's only paths to prod are (a) a PR a human merges, (b) a chaos-validated
   bounded runbook, (c) a GitOps PR.** There is no fourth path. Agent-as-principal (scoped JWT, OBO via
   RFC 8693, agentic-platform-design.md §D.1) means even the "act via a module op" remediation runs the
   *identical* `authenticate → authorize(PEP) → RLS → audit` path a human hits — the danger layer sees it
   as a normal Tier-4 request.
3. **The data/export plane executes through the auto-generated module tool registry *and* one governed
   SQL-read tool**, both RLS-scoped; egress is a separate danger-gated step.
4. **The audit ledger is dual-use** — the diagnostic plane reads it as a signal ("what changed / who did
   what / why was this allowed"), and every Omniscience action writes to it. This is the closed loop
   Cleric has to learn from scratch and Aegis gets for free.

---

## 5. The four gates, applied to every Omniscience action

The gates are `AUTHORIZATION × DANGER × AUTONOMY × VERIFIABILITY` (agentic-platform-design.md). Here is
exactly how each plane clears them and what stays propose-only.

| Gate | Diagnostic (read) | Remediation (write) | Data/export |
|---|---|---|---|
| **AUTHORIZATION** | Operator/agent principal must hold the diagnostic scope; DB/infra creds are read-only; audit-ledger reads are **RLS-scoped** (an operator sees only permitted tenants) | agent-as-principal + **OBO delegation** (RFC 8693 `act` chain) so the user→agent chain is preserved; every module-op remediation hits PEP | **RLS by construction** — SQL runs inside `withTenantTransaction`; PEP on the export op |
| **DANGER** | Tier 1 (read) — trivially cleared, still logged | **Money/irreversible ⇒ Tier 4 (mandatory human approval)**; restart/scale/rollback ⇒ bounded auto *iff chaos-validated*; novel ⇒ propose-only | Query = Tier 1; **export/egress of tenant data = Tier 3–4** (data leaves the boundary) |
| **AUTONOMY** | Autonomous | **Propose-only** except the chaos-tested reversible set; a per-module/per-plane **kill-switch** (ai-native-core.md §0.5) disables autonomy without redeploy | Query autonomous within cost cap; export gated |
| **VERIFIABILITY** | RCA must cite evidence (log lines, trace ids, diffs); **environment-grounded verification or 2nd-agent adjudication** — never self-asserted (Cleric/Bits pattern) | Fix-as-PR gated on **deterministic verifier** (sandbox tests/lint/typecheck); runbook fires only after **matching chaos scenario passes**; recovery re-checked before close | `EXPLAIN` pre-check (cost + row estimate); result row-count vs cap; every export recorded on the audit ledger for reconstruction |

**What stays propose-only, permanently (the honest line):**
- Any **irreversible or money-moving** module operation surfaced as remediation → Tier 4, human-executed.
- Any **direct DB/infra write** → does not exist; there is no write cred and no direct-mutation path.
- Any **main-branch push or deploy** → forbidden; PR-to-non-shipping-branch is the ceiling.
- Any action **crossing tenant isolation or exposing tenant data** → escalate to human, always
  (agentic-platform-design.md §F "always escalate" set).
- Any **novel/uncorrelated** incident remediation → propose with analysis pre-done; human decides.

**Auto-allowed (unattended) — inherited verbatim from agentic-platform-design.md §F, nothing new:** pod/
node heal; metric-gated canary rollback; scale incl. scale-to-zero; secret/key rotation; bounded
chaos-validated runbooks (restart stuck agent worker, drain a hammering tenant, clear a poison message);
CNPG failover. Each is reversible, bounded, deploy-correlated, and chaos-validated.

---

## 6. The remediation plane in detail (fix-as-PR + runbooks + GitOps)

### 6.1 Fix-as-PR (code changes) — the Sentry/OpenHands/Claude-Code pattern, governed

1. **Trigger:** a diagnostic RCA localizes a code defect (cross-repo trace → smoking-gun diff, Sentry
   Seer style) **or** an operator asks for a fix.
2. **Sandboxed repro:** spin an **ephemeral sandbox** (OpenHands-style Docker runtime — blast-radius
   contained, "the agent can't escape the container") with the affected repos checked out. Never against
   prod.
3. **Fix loop:** Claude Agent SDK gather-context → edit → run tests in the sandbox; **hard rules the
   prompt cannot override** (no writes outside workspace, no `git push`, no deletes of protected paths).
4. **Verifier disposes:** the PR is opened **only if** the sandbox's deterministic checks pass
   (`nx affected build+test+lint+typecheck`, revert-on-red — same green gate as the ai-native-core.md §5.1
   dev-trio).
5. **PR to a non-shipping branch:** the agent's most powerful action is **opening a PR on an `auto/*`
   branch that does not deploy on its own**; **a human gates the merge.** Never main, never deploy.
6. **Ambiguity → log, don't act:** architectural/novel changes are logged for a human (Devin/dev-trio
   lesson), never auto-PR'd.

**Cross-repo context** (the "second brain"): the fix loop needs to know *which* repos and *where*. Feed
it from (a) the unified **session/trace id** across gateway→agent→tool→event→saga (agentic-platform-
design.md §E.10) so a symptom maps to a service maps to a repo; (b) the **module manifest** (`dependsOn`,
routes) as the code↔capability map; (c) a **pgvector code-knowledge index** per repo (the dev
second-brain) for semantic "where is X handled." This is the one genuinely net-new asset (§10 risk).

### 6.2 Runbooks — bounded, chaos-tested, behind the danger layer

A runbook is, per ai-native-core.md §5.5, **just a module tool with a risk tier and a `chaos-validated`
promotion gate.** It fires unattended only after it survives the matching injected failure (LitmusChaos/
Chaos Mesh, agentic-platform-design.md §F). The remediation bus is Aegis's existing **events/outbox +
Kafka** (exactly-once trigger). Auto set = the §5 "auto-allowed" list; everything else is
`suggest/dry-run` → posts a **cited hypothesis + proposed runbook to Slack** → human fires it.

### 6.3 Config / infra changes — GitOps only

**Git is the only write path to prod** (agentic-platform-design.md §F). A config remediation is a **PR to
the GitOps repo** (Argo CD `selfHeal+prune` reconciles; rollback = `git revert`). The agent never runs
`kubectl apply` / edits infra directly. Crossplane means even cloud resources heal through the same Argo
loop.

---

## 7. The data / export plane in detail (governed NL→any-data)

**Goal:** "give me any data I'm allowed to see, in any shape, exported" — safely, on a multi-tenant DB.

**Two execution paths, both RLS-scoped:**

1. **Structured path (preferred, auto-growing):** route the request to the **auto-generated module
   tools** (the same registry the whole platform uses). "List my overdue invoices" → `invoice.list` tool,
   PEP-checked, RLS-scoped, no raw SQL. This path **grows for free** as modules are added (§9).
2. **Ad-hoc SQL path (for arbitrary shapes the tools don't cover):** a single **governed SQL-read tool**
   backed by the Postgres MCP Pro **restricted mode** pattern, pointed at the **read replica**:
   - runs inside a **read-only transaction** with the tenant's RLS session var set
     (`set_config('app.tenant_id', …, true)` — `withTenantTransaction`) so a mis-generated `WHERE`
     **cannot** cross tenants (the AWS "programmatic isolation, don't trust the LLM to scope" lesson);
   - **`EXPLAIN` cost-cap pre-check** — reject/queue queries whose estimated cost or row count exceeds a
     per-tenant budget (prevents the analytics cost-bomb);
   - **statement timeout** (Postgres MCP Pro execution-time cap);
   - **input guardrail** rejects under-specified questions that would broaden access (AWS semantic-
     validation lesson);
   - result metered on the **plutus dual-ledger** (agentic-platform-design.md §E.8) — reads cost credits.

**Export = a separate danger-gated action.** Producing a query result is Tier 1; **egressing tenant data**
(CSV/file/email) moves data across the boundary → **Tier 3–4**, metered, and recorded on the audit ledger
so every export is reconstructable (SOC 2 / GDPR portability, agentic-platform-design.md §G). Large
exports run as **durable async** work via the outbox (pause without holding compute), then deliver.

**PII/residency:** the export op honors the module's `dataClass` and residency tags (ai-native-core.md
Facet 9) — a `financial`/`phi` export gets stricter rails and may be Tier 4 unconditionally.

---

## 8. Adoption candidates (repo / license / fit / verdict)

| Component | Repo / product | License | Fit | Verdict |
|---|---|---|---|---|
| DB diagnostic + governed SQL-read | [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp) | MIT | Restricted mode = exactly the RO-txn + parse + timeout we need; point at read replica | **Adopt** |
| Redis diagnostic | [redis/mcp-redis](https://github.com/redis/mcp-redis) | Official | Cache inspection; RO ACL user | **Adopt** |
| Kafka lag/DLQ diagnostic | [confluentinc/mcp-confluent](https://github.com/confluentinc/mcp-confluent) | Official | Consumer lag, DLQ, connectors; RO key | **Adopt** |
| Code (read) + fix-as-PR (write, separate instance) | [github/github-mcp-server](https://github.com/github/github-mcp-server) | Official, MIT | `--read-only` + 23 toolsets; second write-scoped instance for PR path | **Adopt** |
| Metrics/logs | [grafana/mcp-grafana](https://github.com/grafana/mcp-grafana), [grafana/loki-mcp](https://github.com/grafana/loki-mcp) | Official | Prom+Loki+alerts; Viewer SA | **Adopt** |
| Traces | [traceloop/opentelemetry-mcp-server](https://github.com/traceloop/opentelemetry-mcp-server) | OSS | Matches our OpenLLMetry choice | **Adopt** |
| Errors | [getsentry/sentry-mcp](https://github.com/getsentry/sentry-mcp) | Official | If Sentry in stack; else OTel covers it | **Adopt/Assess** |
| K8s | [containers/kubernetes-mcp-server](https://github.com/containers/kubernetes-mcp-server) ≥ v3.6.0 | OSS ⚠️ CVE-2026-46519 fixed 3.6.0 | RO flag **+ RO RBAC SA**; pin version | **Adopt (pinned + RO SA)** |
| Sandboxed fix-and-verify runtime | [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) | MIT | Ephemeral Docker repro; blast-radius containment; resolver = fix-as-PR reference | **Trial** (or replicate the pattern on Claude Agent SDK) |
| Autonomous fix loop | Claude Agent SDK (headless) | MIT | Already the chosen runtime; "propose-PR-never-push" + hard rules + verifier | **Adopt** (already in stack) |
| MCP gateway (namespacing, per-key allow-list, entitlement-filtered listing) | MetaMCP / Bifrost | MIT / Apache-2.0 | Front the diagnostic fleet | **Trial** (already chosen §C.2) |
| RCA behavioral reference (not adoptable) | Cleric, Traversal, Bits AI SRE, incident.io, Resolve.ai | Proprietary SaaS | Copy the hypothesize→verify→cite loop; **can't** run inside our governance substrate | **Avoid as buy; copy as pattern** |

---

## 9. Self-growth: does new functionality auto-appear with zero manual setup?

**The founder's confirm/deny question. Answer: YES for the module/governed-op surface (the majority of
value), with a precisely-bounded NO for the fixed infra-MCP fleet — and that boundary is correct.**

### 9.1 What auto-grows (zero manual setup) — the mechanism, end to end

The self-sustaining design is the **auto-generated, authz-bound tool registry** (ai-native-core.md Facet
1). Trace it end to end for a brand-new module `aegis.billing-recon`:

1. **Author writes governed routes** — each route ships a **Joi validator** + `authorize(Permission)`
   (enforced: `findUnguardedRoutes()` fails boot on an unguarded route).
2. **At boot, the route-walk generates tools** — method+path+guard walked from the live Express router
   stack, joined to **Joi→JSON Schema** (`joi-to-json`, the exact function-calling/MCP input format) and
   the `Permission`. Each route becomes an `AegisTool { name, inputSchema, permission, entitlement, kind,
   risk }` **with no hand-maintenance.**
3. **The data/export plane sees the new tools immediately** — the orchestrator's RAG-over-tools retrieval
   (filtered by entitlement ∩ permission) now includes `billing-recon.*`. "Export my billing-recon
   exceptions" resolves to the new tool the instant the module merges. **Zero manual setup.**
4. **The remediation plane's "act via a module op" path sees them too** — a Tier-4 remediation that needs
   to call a billing-recon operation is just another governed tool call; agent-as-principal + PEP handle
   it. **Zero manual setup.**
5. **The self-knowledge / diagnostic "why" surface sees them** — the module's `manifestSummary`
   (generated) + audit `auditContribution` (ai-native-core.md Facet 8) mean "why did billing-recon do X?"
   is answerable via audit RAG. **Zero manual setup.**
6. **The diagnostic plane's *signal coverage* grows automatically** — because the kernel already mandates
   that every module runs inside `withTenantTransaction` (RLS), emits through the **events/outbox**, and
   writes to the **audit ledger**, a new module's DB rows, events, Kafka topics, and audit entries are
   **already visible** to the fixed Postgres/Kafka/audit MCP servers **without wiring anything new.** The
   OTel spans a new module emits appear in the traces MCP the moment it uses the standard instrumentation
   the kernel injects (Kyverno mutate adds the OTel block, agentic-platform-design.md §F).

**The CI gate is the drift-proofing.** `validateAiManifest()` (the `CapabilityManifest.Validate()`
analogue) fails the merge if a tool lacks a risk tier or a non-stub description, so the auto-grown surface
can't silently rot. New module ⇒ new governed tools ⇒ orchestrator routes to it, self-knowledge explains
it, the data plane exports from it, the remediation plane can act through it — **with zero core edits.**

### 9.2 What does NOT auto-grow (and why that's right)

- **The infra-facing diagnostic MCP fleet is a fixed, finite set** (Postgres, Redis, Kafka, OTel,
  Grafana, Sentry, GitHub, K8s). Adding a *new kind of infrastructure* (say, a new message broker) means
  wiring one new read-only MCP server once. This does **not** scale with module count — there are only so
  many substrate types — so it is a one-time cost, not per-module toil. **Correct by design:** you do not
  want each module minting infra credentials.
- **A genuinely novel non-standard signal** (a module that logs somewhere off the OTel path, or stores
  state outside Postgres) would not auto-appear — but that violates the kernel contract and
  `findUnguardedRoutes()`/lint should already prevent it. The auto-growth guarantee is **conditional on
  the module honoring the standard isolation/event/audit/telemetry paths** — which the kernel already
  forces.

**Net:** the *high-frequency* growth (new business capabilities/modules) is **fully automatic**; the
*low-frequency* growth (new infra substrate types) is a **one-time wiring** and shouldn't be automatic.
This is exactly the self-sustaining property the founder is asking for, with the boundary drawn where it
belongs.

---

## 10. Honest limits, risks, and what is NOT possible today

1. **Cross-repo semantic context is the one net-new hard asset.** Multi-hop RCA and cross-repo fix-as-PR
   (Sentry/Traversal-grade) need a code/knowledge graph. Aegis can bootstrap it cheaply (manifest deps +
   event topology + OTel service map + pgvector code index) but **won't match Traversal's 82% multi-hop
   accuracy on day one** — that accuracy comes from a maturing world model. *Mitigation:* start with
   single-hop + manifest-driven dep traversal; treat the graph as a maturing asset; measure RCA accuracy
   as an SLI.
2. **NL→SQL correctness on a large, evolving schema is imperfect.** The RLS + read-only-txn + `EXPLAIN`
   cap make it **safe** (can't leak, can't cost-bomb) but not always **correct** — it may return the
   wrong (still-authorized) data. *Mitigation:* prefer the structured module-tool path; reserve raw SQL
   for genuine gaps; show the generated SQL + row count for confirmation before export; eval-gate the SQL
   tool (Facet 6).
3. **Read-only is only as strong as the credential.** The K8s MCP CVE-2026-46519 read-only *bypass*
   proves flags fail. *Mitigation (non-negotiable):* every diagnostic connection uses a source-level
   read-only credential (read replica/RO role/Viewer SA/RO RBAC), pinned server versions, defense in
   depth — never trust the flag alone.
4. **Prompt injection via untrusted telemetry/data.** Log lines, invoice memos, connector payloads, and
   error messages flow into agent context — a poisoned log line could try to steer a remediation
   (ai-native-core.md §8.4 gap). *Mitigation:* dual-LLM/CaMeL privilege separation once untrusted content
   is ingested (agentic-platform-design.md §D.3); untrusted text can never directly drive a privileged
   tool call; remediation always re-derives targets server-side.
5. **Approval fatigue on the remediation plane.** A flood of Tier-4 proposals degrades maker-checker to
   rubber-stamping (ai-native-core.md §8.3). *Mitigation:* proposal rate limits, batching, confidence
   suppression, and a **kill-switch** per plane.
6. **Always-parsing telemetry has real cost/latency.** Continuous investigation over logs/traces is token-
   heavy (agentic-platform-design.md §E.6). *Mitigation:* trigger investigations on alerts (not always-on
   scanning), prompt-cache the system prompt + tool schemas, cascade cheap→frontier models, per-tenant
   budgets, Batch API for non-interactive RCA.
7. **What is NOT possible / must not be built:** an agent with **standing write access** to prod DBs/infra/
   main-branch; a "self-healing" loop that mutates prod outside Git; autonomous execution of
   irreversible/money/tenant-crossing actions. These are permanently propose-only — a design decision, not
   a temporary limitation.

---

## 11. Phased build outline (slots into agentic-platform-design.md §J roadmap)

**Phase 0 — diagnostic plane MVP (NOW, mostly assembly).**
Stand up the read-only MCP fleet behind the MCP gateway, each on a source-level read-only credential:
Postgres-MCP-Pro (restricted, → read replica), redis/mcp-redis (RO ACL), mcp-confluent (RO key, lag/DLQ),
opentelemetry-mcp-server + grafana/mcp-grafana, github-mcp-server (`--read-only`), kubernetes-mcp-server
(≥3.6.0 + RO SA), and an **audit-ledger MCP** (RLS-scoped) — this last one is Aegis-specific and the
differentiator. Wire them as tools in `@aegis/ai-core`'s registry. Deliverable: an operator asks "why is
tenant X lagging?" and gets a **cited RCA** with environment-grounded verification, entirely read-only.

**Phase 1 — data/export plane (NOW→NEXT).**
Governed SQL-read tool (RO txn + RLS + `EXPLAIN` cap + timeout, metered on plutus) + route the structured
path through the auto-generated module tools. Export as a danger-gated (Tier 3–4), audited, durable-async
action. Deliverable: "export every invoice I approved in Q2 as CSV" — RLS-scoped, cost-capped, egress
approved and audited.

**Phase 2 — remediation plane, propose-only (NEXT).**
Fix-as-PR: sandboxed repro (OpenHands-style / Claude Agent SDK) → verifier-gated PR to `auto/*` →
human-merged. Runbook library on the events/outbox, all `suggest/dry-run`, posting cited hypotheses to
Slack. Config via GitOps PR. Agent-as-principal + OBO so module-op remediations hit PEP→RLS→audit.
Deliverable: an RCA that localizes a code defect opens a verified draft PR a human reviews; a stuck-worker
alert posts a proposed runbook.

**Phase 3 — bounded autonomy + verification hardening (NEXT→LATER).**
Promote the reversible, chaos-validated runbook set to unattended (restart/scale/rollback/key-rotate/CNPG
failover) — each only after surviving its matching chaos scenario. Add second-agent adjudication for RCA,
recovery re-check before incident close, kill-switches, approval-fatigue controls, and eval gates
(Langfuse+Promptfoo) on the SQL tool and the RCA loop. Mature the cross-repo code-knowledge graph.
Deliverable: the auto-allowed remediation set runs unattended with chaos-gated confidence; everything else
stays propose-only, permanently.

---

## Red-team correction (READ BEFORE IMPLEMENTING)

**Verdict:** The diagnostic-plane thesis is sound and the propose-only remediation ceiling is right — but the doc *over-claims read-only safety* ("read-only by construction / the connection physically cannot mutate") when only the DB replica is physics; everything else is read-only-by-config, and one auto-allowed action ("rotate a leaked key") is on the wrong side of its own line. Fix the credential-boundary and audit-ledger-exfil holes before wiring anything past the DB replica.

**Ranked top fixes**
1. **Remove "rotate a leaked key" from the auto-allowed/unattended set (lines 76-77, 343, 558).** It contradicts the CVE lesson that *creds are the boundary*: an agent that can autonomously rotate/replace credentials can rotate the very creds that bound its own read-only-ness (and can lock out humans / break every dependent workload). Key rotation on a *suspected-leak* is a security incident → propose-only, human-executed. Only routine, calendar-driven ESO rotation stays unattended, and that is not agent-initiated.
2. **Re-scope "read-only by construction" to "read-only by credential, verified per-source" (lines 31, 306-308).** Only the Postgres read-replica is physically read-only. Redis ACL, Kafka API key, Grafana SA, K8s RBAC SA, GitHub PAT are read-only *by configuration* — the same failure class as CVE-2026-46519. Delete the claim "the underlying connection physically cannot" mutate; replace with per-source RO cred + periodic assertion tests + deny-by-default egress.
3. **Treat the audit-ledger MCP as the platform's single richest exfil target, not a free win.** The `agent.*` ledger stores prompt/tool-call traces (payloads, and per ai-native-core §894 there is *no PII/erasure story* for embedded financial content). "RLS-scoped so an operator sees only permitted tenants" is meaningless for a *platform operator* whose scope is cross-tenant by role. Require: field-level redaction of secrets/PII at ledger write-time, a separate high-tier scope to read raw traces, and egress metering on ledger reads too.
4. **Make prompt-injection-via-telemetry a Phase-0 gate, not a §10 footnote.** The doc ingests untrusted log lines / invoice memos / connector payloads into agent context and only *names* CaMeL/dual-LLM as mitigation. Nothing in the substrate implements it yet (companion docs describe it as a design, agentic-operations flags the untrusted-connector vector as open). Until privilege separation exists in code, a poisoned log line can steer RCA and (via the "act via a module op" path) reach a Tier-4 proposal. Gate: no remediation autonomy, and no ledger/SQL tool exposure to injected content, until this ships.
5. **Correct the self-growth claim's honest edge.** "New observability signals auto-appear" is true only for route-derived module tools and for signals emitted through the *already-instrumented* OTel/audit/event paths. Infra-level signals (a new failure mode, a new saturation metric, a broker-internal condition) do **not** auto-appear — they need the fixed MCP fleet to expose that surface. The doc says this (§9.2) but the TL;DR (line 40-47) reads more optimistically than §9.2 delivers; align them.

**Key holes**
- *Security:* auto key-rotation self-referential blast radius (fix 1); audit-ledger exfil + no redaction/erasure for embedded PII (fix 3); RO-by-config creds mislabeled as physical (fix 2); OBO `act`-chain + agent-as-principal are specced (M-effort) in companions, **not built** — the "identical PEP→RLS path" guarantee is aspirational today.
- *Feasibility:* NL→SQL is *safe* (RLS can't leak) but the doc concedes it can return wrong-but-authorized data; ship structured-tool path first, keep raw SQL behind confirm-before-export. Read-replica lag means the diagnostic plane can reason on **stale** state during the exact incidents it exists for — call this out and cross-check critical facts against a bounded primary read.
- *Gaps:* single-human self-serve SMB tenant breaks maker-checker on every Tier-4 remediation/export (inherited from the operations red-team, unaddressed here — a solo operator approving their own agent's proposal is not independence); GDPR erasure vs the immutable ledger that the diagnostic plane *reads* is unreconciled for `agent.*` traces specifically; cross-repo "second brain" is genuinely net-new and gates cross-repo fix-as-PR accuracy.

**Where a human or a different approach is genuinely needed**
- Any *suspected-leak* credential action, any tenant-isolation-crossing read for a platform operator, and any irreversible/money remediation → human, always (unchanged).
- Independence-of-judgment for single-human tenants cannot be solved by SoD — needs an *external* checker (platform-side reviewer, time-delay + notify, or provider-side attestation), not a second seat the tenant doesn't have.
- Prompt-injection isolation needs the dual-LLM/CaMeL pattern actually *implemented and eval-gated* — a different, unbuilt capability, not a config of what exists.
- Reconciling erasure with the append-only ledger for embedded PII needs crypto-shredding/redaction *at the trace layer*, a design not yet present for `agent.*` records.

**Severity: high** — the thesis survives, but shipping the read plane as literally-worded (auto key-rotation, "physically cannot mutate", audit ledger as free signal, injection as a footnote) would introduce exactly the confused-deputy/exfil failure modes the substrate exists to prevent.

---

*Drafted from verified external research (five production AI-SRE products; the Postgres/Redis/Kafka/
GitHub/Grafana/OTel/Sentry/K8s MCP ecosystem with licenses + maturity + the CVE-2026-46519 read-only-
bypass lesson; Sentry Seer / OpenHands / Devin / Claude-Code safe-fix patterns; AWS multi-tenant RLS
text-to-SQL) and grounded in the Aegis substrate (agent runtime, auto-generated authz-bound tool
registry, RLS, hash-chained audit ledger, @aegis/approvals, agent-as-principal + OBO, LiteLLM gateway,
plutus metering, autonomous-ops §F). Cross-check volatile items (MCP server versions/CVEs, vendor
capabilities) at build time. Recommended next step: an adversarial red-team of the read-only credential
boundary and the prompt-injection-via-telemetry threat model before enabling any remediation autonomy.*
