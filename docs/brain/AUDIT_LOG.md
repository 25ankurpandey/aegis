# Audit Log — every working session, ask, and outcome (append-only)

> Chronological record of the founder↔agent conversation that shaped this project. **Never rewrite or
> delete entries; append only.** Entries are the fallback source of truth when targeted docs
> (instructions/designs/discussions/architectures) don't answer a question. Dates approximate where
> sessions spanned midnight. Format: ask → done → concluded → artifacts → open.

---

## T1 — 2026-06-30 · "Analyze everything we built; how do we monetize it?"

- **Ask:** Analyze all Aegis functionality; think how to monetize, what to build on top and sell.
- **Done:** Read README/SPEC/DESIGN/IMPLEMENTATION_PLAN; sized the codebase (~46k LOC, 9 apps, 10 libs, ~90% complete).
- **Concluded:** The moat is the **platform substrate** (RLS tenant isolation + Casbin authz + hash-chained audit + approvals engine), NOT the business apps (expense/payroll/invoice are commodity vs Ramp/Gusto/Bill). Four monetization paths ranked; recommendation: authz+tenancy developer platform, validated by dogfooding at SiteRecon; business apps become living demos.
- **Artifacts:** (analysis in conversation; superseded by T2 doc).

## T2 — 2026-06-30 · "Make it modular — tenants add & pay only for what they need, multi-industry"

- **Ask:** Plan a module-based app; tenants enable/buy modules à la carte; research how such platforms are built (Odoo/Salesforce etc.); use 5 sibling repos for reference (oe_core, oe-connect-platform, mint, emporio, plutus).
- **Done:** 16-agent research workflow — mapped Aegis modularity seams + all 5 repos; researched ERP suites, enterprise platforms, dev plugin platforms, billing/entitlement infra, architecture patterns; verified volatile claims; synthesized; red-teamed (13 gaps found and folded in).
- **Concluded:** Module manifest (`aegis.module.json`) is the one net-new primitive; Entitlement Service over Chargebee (reuse plutus dual-ledger); ~70% of entitlement substrate already exists (`tenant_features` + swappable reader + runtime PAP grants); per-tenant install granularity; kernel-vs-modules split; NOW-phase blockers: revocation state machine, module data lifecycle, RLS-assurance CI gate, existing-tenant migration.
- **Artifacts:** `docs/strategy/modular-platform-plan.md`.

## T3 — 2026-07-01 · "Is this a CRM?"

- **Ask:** Is what I'm imagining a CRM, or something else?
- **Concluded:** **Not a CRM** — a platform / aPaaS / composable business suite (Odoo/Salesforce-Platform category). A CRM could be one module on it. Trap to avoid: building one app and calling it the platform.
- **Open (founder dismissed the questions — still pending):** ecosystem scope (first-party vs partners vs open marketplace); primary goal (dogfood vs sell externally vs both); AI-agent governance now vs later.

## T4 — 2026-07-01 · "Design the entire vision — agentic-first + high scale"

- **Ask:** Research + design the whole app agentic-first: users do EVERYTHING by typing/talking; no human sales/support teams; the app self-describes; MCP optional; think deeply about behavior at very high scale.
- **Done:** 19-agent workflow — Aegis agentic seams + SiteRecon repos' AI assets; 6 research clusters (agent platforms, MCP/capability exposure, orchestration, agent authz at scale, LLM economics, multi-tenant infra scale) with adversarial verification. Design agents hit the session usage limit; research cached.
- **Concluded (research):** discovered production agentic code to lift — emporio's LangGraph voice pipeline, oe_core's LangChain NL→query agent, plutus metering; Berkeley too-many-tools finding (43%→2% accuracy 4→51 tools); Casbin fine coarse but needs OpenFGA for ReBAC; RLS ~2-5% overhead only with leading-index + subquery-wrapped current_setting; PgBouncer+RLS SET LOCAL footgun.

## T5 — 2026-07-01 · "Continue; broaden research to the whole internet; fully autonomous ops; enterprise best practices; document everything"

- **Ask:** Continue the failed design; research internet-wide for adoptable OSS/repos/SDKs; the platform must run with minimal-to-no human ops; enterprise best practices; document all research/design/architecture.
- **Done:** Synthesized the master design from cached research; supplementary 5-agent workflow (autonomous ops, enterprise readiness, adoption catalog) with claim verification; folded into the doc.
- **Concluded:** Core principle formalized — **"the agent reasons; the governed core acts."** Autonomous ops = 4 stacked reconciliation layers (K8s self-heal → GitOps selfHeal → Kyverno admission → AI SRE) with "AI proposes, humans decide" for novel/irreversible/cross-tenant. License traps: Terraform BUSL→OpenTofu, Citus/Lago AGPL, Inngest server SSPL. Default stack: Claude Agent SDK · MCP TS SDK · LiteLLM · Cerbos→OpenFGA · Chargebee+OpenMeter · DBOS · Vercel AI SDK+AG-UI · Langfuse+Promptfoo · pgvector · ArgoCD+KEDA+CNPG+PgBouncer.
- **Artifacts:** `docs/strategy/agentic-platform-design.md` (§A–K).

## T6 — 2026-07-01 · "YC RFS fit" (handoff-README ask interrupted, delivered in T7)

- **Ask:** Read https://www.ycombinator.com/rfs; which category do we fall in; we span multiple — analyze thoroughly.
- **Done:** Fetched YC Summer-2026 RFS (16 ideas); adversarial per-category fit scoring (7 candidates); synthesis; YC-partner red-team.
- **Concluded:** No clean single fit (2–3/5 across ~7 software ideas). **Lead with SaaS Challengers** (AI-native ERP-controls replacement); Software-for-Agents = moat; story = "one thing showing up in seven RFS windows." **Red-team verdict: not yet fundable as framed** — no customer/revenue/co-founder; agent layer unshipped; the fix worth more than any positioning: one design-partner running real money through the governed core.
- **Artifacts:** `docs/strategy/yc-rfs-fit.md`.

## T7 — 2026-07-01 · "Handoff README + AI-first from scratch, AI in the core of every module"

- **Ask:** (a) Create a handoff/context README so any new agent needs zero explanation. (b) Make the platform AI-first from the ground up — agentic capability built into the ROOT of every module (RBAC, ABAC, payroll, expenses, workflows, …) and everything future. Reference the parallel Wayfinder project (3 paths given).
- **Done:** Wrote `ONBOARDING.md` (repo root) + persistent memory pointer. Workflow: mined Wayfinder VR (tool catalog, IVoiceToolProvider, drift-proof CapabilityManifest + CI Validate gate, "LLM plans / app is authority") + wayfinder-autonomy (3-agent dev harness); designed the AI-Native Module Contract (9 facets, `ai` block in manifest, `@aegis/ai-core` kernel); red-teamed.
- **Concluded:** Red-team correction adopted as authoritative — **minimal viable contract**: Tools + Risk-tier mandatory on every module (money/irreversible ⇒ Tier 4), eval gate for Tier≥2 writes, everything else opt-in. LLM stays at the EDGE (never computes tiers, never resolves deictic referents into Tier-4 executes, never carries principal/tenant/permission). Honest flag: the tool-registry generator is net-new work (pep-assertion extracts only method+path today; joi-to-json not a dependency).
- **Artifacts:** `ONBOARDING.md`, `docs/strategy/ai-native-core.md` (§0.5 + §8 = corrections), memory `aegis-platform-vision`.

## T8 — 2026-07-01/02 · "Autonomous AI capabilities + RBAC/ABAC flows + danger confirmations + all operational flows"

- **Ask:** AI should DO things on its own (run audits, run workflows on any data, find+fix bugs, check any data) with correct, verifiable results and minimal human intervention. How is RBAC/ABAC enforced agentically — what does the flow look like per role? Add confirmation/alerts for dangerous commands EVEN IF the user has permission. Design how the whole app works: onboarding, support, admin ops, tenants/users using modules, adding/updating modules, payments — everything. Keep the handoff doc updated.
- **Done:** Launched the `agentic-operations` workflow (4 design surfaces → integrate → red-team). 1/6 agents completed (autonomy+verifiability) before the session limit; **resumed 2026-07-02** with cache.
- **Concluded (framework established):** FOUR GATES on every action — Authorization (role×ABAC×entitlement; tool list filtered before the model sees it) × Danger (orthogonal axis: deterministic verb+count+amount+resource-class scoring + anomaly signal; graduated: confirm→typed-confirm→step-up MFA→cooling-off+undo→second approver→alert→soft-block) × Autonomy (reversible/verifiable=act; irreversible/money/cross-tenant=propose-only) × Verifiability (deterministic re-check OR independent second-agent verify OR sampled+audited; agent-SoD: proposer ≠ verifier).
- **Artifacts (pending workflow completion):** `docs/strategy/agentic-operations.md`.

## T9 — 2026-07-02 · "Omniscient platform agent · stack sufficiency · second brain(s) · AR ecosystem protocol · agentify+policing products · brain README infra"

- **Ask (multi-part):** (1) Feasibility: with our AI infra (MCP etc.), can the AI connect across all codebases/DBs/cache/logs, gather context, find + fix issues, serve any data/export request? (2) Is TS/Node + our frameworks enough, or do we need other languages for specific functionality? Don't shy from complex algorithms (RAG over entire app, etc.). (3) The app must be SELF-SUSTAINABLE: new functionality/modules auto-integrate into the AI flows with zero manual setup. (4) Deep internet-first research (GitHub/docs/forums) for everything. (5) Create this brain: audit log + targeted readmes (instructions/designs/discussions/architectures); agents check targeted docs first, audit log as fallback; like an Obsidian/Claude second brain (article: mindstudio.ai build-ai-second-brain-claude-code-obsidian); check "Blackboard.io RCLE"; ALSO evaluate a second brain/app-brain for the platform's own runtime agents (targeted, specific, anti-hallucination). (6) Research a protocol so the Wayfinder AR app becomes the management surface for the whole autonomous ecosystem — real-time generated AR UI, AI-to-AI across all companies one runs, multi-role. (7) Research "agentify existing companies" + "AI policing" (agent rule/permission enforcement org-wide) as sellable products. (8) NO implementation — dense, gap-free docs others can implement from.
- **Done:** Resumed the T8 `agentic-operations` workflow (cache-aware). Launched the 5-track `omniscience-brain-ecosystem` research workflow (each track researches the web then writes its own doc). **Built this brain** (`docs/brain/` with README/AUDIT_LOG/instructions/designs/discussions/architectures) and updated `ONBOARDING.md`.
- **Preliminary answers given inline (research to confirm/deepen):** (1) Yes — feasible with the MCP/tool-registry infra; the diagnostic (read) plane is proven tech, the fix plane must stay propose-PR/GitOps behind the danger layer. (3) Yes — that's exactly what the auto-generated tool registry + minimal module contract provide: new routes/modules become agent tools by construction.
- **Artifacts:** `docs/brain/*` (this infrastructure); pending: `docs/strategy/platform-omniscience.md`, `stack-sufficiency.md`, `knowledge-brain.md`, `ecosystem-ar-protocol.md`, `agentify-and-policing.md`, `agentic-operations.md`.

---

## T10 — 2026-07-02 · Track 3 (knowledge-brain) validate + refine pass

- **Ask:** (5-track omniscience-brain-ecosystem workflow, Track 3) Research internet-first, then design BOTH brains (dev-process + app/platform); validate + refine the existing `docs/brain/` skeleton rather than reinvent; answer where/format/scale, keep-current automation, query path, blackboard concurrency, anti-hallucination, update protocol.
- **Done:** Found `docs/strategy/knowledge-brain.md` already existed (complete prior run, 436 lines, cited). Ran fresh web research to re-verify volatile claims; all held. Refined the doc in place (did not reinvent): (1) fixed the stale §3.1 note that claimed `docs/brain/` didn't exist — it does now — and added §3.1.1 Reconciliation mapping the existing skeleton (flat `AUDIT_LOG.md`, README-embedded "Current state", four index-only targeted dirs) to the target shape as its Phase-0 MVP, with a no-rewrite migration; (2) added §1.2.1 GBrain (Garry Tan/YC, MIT) as the production reference implementation of the exact App Brain architecture (git-markdown → Postgres+pgvector, hybrid vector+BM25+RRF, zero-LLM auto-linked graph, git-delete→soft-delete; ~146k-page scale proof); folded hybrid+RRF retrieval into the query path (§4.5), TL;DR, and Phase 2; added GBrain + agno-agi/scout to the adoption table.
- **Concluded:** Design was already sound and implementation-ready; the refinement's load-bearing additions are (a) the skeleton is this design at t=0, not a conflict — harden in the §3.1.1 order; (b) retrieval should be hybrid pgvector+BM25 merged via RRF (measured ~+31pt P@5 over vector-only, pure SQL, no new dependency), reimplemented on our governed Postgres — never GBrain-as-a-service (bypasses RLS/PEP/audit, same reason as Letta). "Blackboard.io RCLE" re-confirmed non-existent.
- **Artifacts:** `docs/strategy/knowledge-brain.md` (refined: header, §0 TL;DR, §1.2.1, §3.1/§3.1.1, §4.5, §7, §9-Phase2).
- **Open:** split "Current state" out of `docs/brain/README.md` into a `STATE.md`; add `RESOLVER.md`; introduce `log/` per-session files alongside the flat `AUDIT_LOG.md` — all per §3.1.1.

---

## T11 — 2026-07-02 · Rerun after limit refresh; all docs landed; "return the omniscience/brain/ecosystem results"

- **Ask:** Rate limits refreshed — rerun the workflows; return the A1 (omniscience-brain-ecosystem) results.
- **Done:** Resumed BOTH workflows from cache. `agentic-operations` (4 design surfaces cached) → integrate wrote `docs/strategy/agentic-operations.md` (859 ln, §1 autonomy+verifiability · §2 per-role authz · §3 danger layer · §4 operational flows · §5 how the four gates compose); its red-team pass is still running. `omniscience-brain-ecosystem` all 5 tracks completed and wrote their docs (each internet-first + cited): `platform-omniscience.md` (574), `stack-sufficiency.md` (241), `knowledge-brain.md` (463), `ecosystem-ar-protocol.md` (661), `agentify-and-policing.md` (276). Updated `designs/README.md` (statuses), brain README Current State.
- **Concluded (per-track):** (1) OMNISCIENCE feasible — diagnostic plane ~90% off-the-shelf MCP servers (read-only creds are the real boundary, cf. CVE-2026-46519), fix plane stays propose-PR-never-push + GitOps behind the danger layer, governed NL→query for data/export; auto-growth confirmed (new modules auto-appear via the generated tool registry + kernel-forced RLS/outbox/audit/OTel). (2) STACK — TS/Node is enough for ~90% incl. the agent runtime (full TS SDK parity); 4 algo families → Python batch sidecars behind Kafka/HTTP (never DB/principal/authz); no Go/Rust service today; never rewrite; text-to-SQL win is a semantic layer not a bigger model; ParadeDB pg_search is AGPL — legal sign-off, tsvector fallback. (3) BRAIN — design externally validated by GBrain (Garry Tan/YC: git-markdown→Postgres+pgvector, hybrid vector+BM25+RRF ~+31pt P@5); this `docs/brain/` IS the design at t=0; "Blackboard.io RCLE" confirmed non-existent (= the blackboard pattern); adopt techniques, never GBrain-as-a-service (bypasses RLS/PEP/audit). (4) AR — don't invent a wire protocol; define the **Aegis Ecosystem Protocol** as a profile over A2A+A2UI+AG-UI+MCP; ~80% exists; net-new = A2UI→Unity renderer (~5–6 wks); Quest Tier-4 step-up = phone-passkey WebAuthn concession + what-you-see-is-what-you-sign (surfaceHash in the audit row). (5) PRODUCTS — lead with **Aegis Warden** (AI-policing PEP gateway: enforcement+approvals+tamper-audit is an unoccupied niche vs observability-only rivals; EU AI Act Art.12 tailwind; no source integration needed), then **Aegis Ignite** (agentify legacy); ~80% already built; honest risk = crowded/consolidating market + platform-vs-product focus tension.
- **Artifacts:** the 6 docs above; `designs/README.md`, `README.md` (Current State), this entry. Track 3 self-logged T10.
- **Open:** operations red-team still running (fold in when done); consolidated red-team of the 5 T9 docs recommended before build; O4 "flip to build?" still the gating founder decision.

---

## T12 — 2026-07-02 · Operations red-team folded in; consolidated red-team of the 5 T9 docs launched

- **Ask:** Continue (rate limits refreshed).
- **Done:** The `agentic-operations` red-team completed (integrate had grown the doc to 1,242 ln). Folded it in as a binding **§0 "Red-team correction (READ BEFORE IMPLEMENTING)"** banner at the top + the full ranked critique as **§6** (doc now ~1.5k ln). Updated `designs/README.md` status → red-teamed. Launched a consolidated red-team workflow over the five T9 researched+cited docs (omniscience, stack, brain, AR, agentify-policing): each agent red-teams its doc, appends a correction banner to it, and a consolidation agent writes `docs/strategy/red-team-consolidated.md`.
- **Concluded (operations red-team — important):** verdict **"strong B+ design, currently a C on trust-it-with-money-unattended."** Two over-sells to fix before any Tier-2+ autonomous WRITE: (1) **determinism ≠ correctness** (the V1 re-check query is LLM-authored → wrong-but-self-consistent queries "verify" forever) and **identity-SoD ≠ independence** (maker+verifier on the same model = correlated failure); (2) **the Trust Rule is an OR** — `sampled+audited` alone lets material financial writes execute with zero per-action verification. Fix = **hardened Trust Rule (AND for money/external/irreversible/D≥3: V1 deterministic-recompute ∧ V2 provably-independent dual-control, different model family, verifier reads its own fresh snapshot; check query selected from a vetted library, LLM never authors it; sampled-alone forbidden).** Deepest contradiction: **the whole HITL stack assumes ≥2 humans, but the GTM is one-person SMBs → controls silently degrade to self-approval** (must degrade to cooling-off + out-of-band 2nd-channel + platform-side review queue instead). Other blockers: **GDPR erasure vs immutable ledger** (crypto-shred), untrusted-connector-data→proposal injection (enforced dual-LLM), agent-bypassing "human now" control, cross-principal decomposition accounting, fatigued-acceptance→promotion loop, fat-verifier scope. **Stance: ship read-only + propose-only for money/external/irreversible; earn write-autonomy as fixes land in code.**
- **Artifacts:** `docs/strategy/agentic-operations.md` (§0 + §6); `designs/README.md`; pending `docs/strategy/red-team-consolidated.md` + correction banners on the 5 T9 docs.
- **Open:** consolidated 5-doc red-team results (in flight); O4 "flip to build?" still the gating decision — but note the operations red-team is itself a strong argument to START with the read-only/propose-only slice.

---

## T13 — 2026-07-02 · Consolidated red-team of the 5 T9 docs → the safe build sequence

- **Ask:** Continue (rate limits refreshed).
- **Done:** Consolidated red-team completed. Each of the 5 T9 docs got a binding "## Red-team correction (READ BEFORE IMPLEMENTING)" banner appended; the synthesis landed at `docs/strategy/red-team-consolidated.md` (127 ln). Updated `designs/README.md` (5 docs → red-teamed + added the consolidated master row + meta-theme note), added decisions **D18/D19/D20**, updated O4. All nine strategy docs are now red-teamed.
- **Concluded:** All 5 docs = "high" severity, but 4 are high on *spec/wording* with sound architecture (omniscience, stack, knowledge, ecosystem-ar) and 1 is high on *business timing* — agentify-and-policing verdict: **"strong research, wrong bet now"** (enforcement wedge is a feature not a moat, being closed by AWS AgentCore/Okta; collapse to one dogfooded primitive; don't lead on the EU AI Act deadline — it accelerates incumbents). **THE META-THEME (most important finding of the whole project):** RLS/tenant isolation is real for the live DB but is quietly re-established *weaker* on every DERIVED plane — object-store extracts, the agent/audit ledger, hub aggregation, ANN retrieval, cross-tenant operators. Six cross-cutting themes; a **16-item ranked fix-before-build list**; the **"build FIRST" slice** (read-only single-tenant structured-tool spine + read-replica diagnostic + dogfood maker-checker/audit + brain Phase-0 + manifest-tier knowledge); a **"do NOT build until X"** blocker table. Top cross-cutting fixes: (1) implement+eval-gate dual-LLM/CaMeL injection isolation as a Phase-0 gate; (2) reclassify the agent/audit ledger as the richest exfil target (write-time PII/secret redaction, high-tier scope for raw traces, egress metering); (3) GDPR erasure vs immutable ledger + all derived copies (crypto-shred); (4) single-human-tenant independence (external checker); (5) real separate read/write RLS + deny-on-unset-GUC + ANN-under-RLS; (6) fix "read-only by construction" (false for 5/8 connectors) + remove auto key-rotation from the unattended set (self-referential confused-deputy); (7) stop selling determinism/tamper-evidence as correctness (add environment-grounded eval gates).
- **Artifacts:** `docs/strategy/red-team-consolidated.md`; correction banners on all 5 T9 docs; `designs/README.md`; `discussions/README.md` (D18/D19/D20, O4); this entry.
- **Open:** O4 now = *when* to start the build-first slice + who builds it. The design phase is effectively complete — every strategy doc is written and red-teamed.

---

## T14 — 2026-07-02 · BUILD STARTED — the keystone tool-registry generator (built + prototyped, green)

- **Ask:** "Let's start building as well as prototyping in parallel."
- **Done:** Recon'd the real code (repo buildable: Node 26, Nx 19, joi+casbin+inversify present; **joi-to-json absent — red-team confirmed**), read the exact seams (pep-assertion.ts, expense controller+validator, pep.ts authorize, validate middleware, tsconfig paths). Then built the keystone of the whole agentic layer:
  1. **Metadata stamping** (fixes the red-team's "permission/schema trapped in closures"): new `libs/service-core/src/bootstrap/route-metadata.ts` — `markPermissions`/`readPermissions`, `markSchema`/`readSchema` (same pattern as the existing `markAuthGuard`). `authorize()` now stamps its Permission(s); `validate()` now stamps its Joi schema + source. Exported from service-core.
  2. **New `@aegis/ai-core` lib** (the shared AI substrate): `generateToolRegistry(app)` walks the live Express router, reads the stamps, and emits **authz-bound, self-describing tool descriptors** (name/method/path/permissions/inputSchema/inputSources). Dependency-free **Joi→JSON-Schema** converter via `.describe()` (handles object/string/number/integer/boolean/date, required, length/min/max, uuid/guid/isoDate/email/uri formats, enums). Added `@aegis/ai-core` path alias.
  3. **Prototype against expense**: a spec mounts the REAL expense route definitions (real authenticate/authorize(Permission)/validate + mirrored expense validators) and asserts the generated tools.
- **Concluded / verified:** `nx test ai-core` = **6/6 pass**; the two expense routes generate exactly 2 authz-bound tools (health/unguarded excluded), permissions bound to the exact enum values, POST body + GET :id schemas derived correctly (integer, uuid-format, date-time, length, required, enums). Existing libs still green: **147 tests** (service-core 93 + access-control 54). **Strict typecheck clean** for ai-core + both changed libs. This proves the self-sustaining claim (D15): a new guarded route becomes an agent tool with zero manual wiring. NOTE the honest scope — the generator is read/derive only (no execution), which is exactly the safe read-only slice of D18; nothing here touches the gated write-autonomy planes (D19).
- **Artifacts:** `libs/service-core/src/bootstrap/route-metadata.ts`; edits to `pep.ts`, `validation.middleware.ts`, service-core `index.ts`, `tsconfig.base.json`; new lib `libs/ai-core/**` (project/tsconfig/jest/src/tool-registry/{types,joi-to-json-schema,generate-tool-registry}, test).
- **Open / next increments:** (a) entitlement+permission pre-filter of the registry per principal (`filterToolsForPrincipal`); (b) wire the generator into a real service bootstrap to expose the registry (diagnostic endpoint / MCP server — MCP SDK needs `npm i`); (c) descriptions from the module manifest instead of `METHOD path`; (d) brain Phase-0 scaffolding (STATE.md/RESOLVER.md/log/).

---

## T15 — 2026-07-02 · Parallel: build increment #1 (tool pre-filter) + the exhaustive context docs

- **Ask:** "Continue in parallel. Also create context.md / spec.md / agents.md + handoff.md containing ALL the context — every idea, thought, what we're building/evolving into, everything since the beginning — so any new agent needs zero explanation. Miss nothing."
- **Done (build track, background agent):** `libs/ai-core/src/tool-registry/filter-tools.ts` — `filterToolsForPrincipal(tools, {permissions, isModuleEnabled?})`, the entitlement×permission pre-filter ("filter the tool list before the model sees it"; PEP remains the real gate). Exported from the ai-core barrel; 6 new tests. **`nx test ai-core` = 12/12**, strict typecheck clean. Only `libs/ai-core/` touched.
- **Done (docs track, main loop):** Wrote **`/CONTEXT.md`** — the exhaustive master (18 sections: vision, the full T1–T14 origin arc, every founder idea/thought as a concept, the core principle + four gates, architecture built-vs-target, autonomous+verifiable capabilities, governance, operational flows, ancillary ambitions, stack, current build state, decisions/open-Qs, the safe build sequence + meta-theme, reference repos, business reality, working method, full doc index). Added non-destructive **"start here / vision has evolved → read CONTEXT.md"** banners to `AGENTS.md`, `HANDOFF.md`, `SPEC.md` (their existing content is authoritative only for the shipped code, preserved). Built brain Phase-0 nav infra: **`docs/brain/RESOLVER.md`** (the "if you need X, go here" routing table — anti-hallucination) + **`docs/brain/STATE.md`** (canonical single-writer current state). Wired RESOLVER/STATE into the brain README + folder layout; pointed ONBOARDING at CONTEXT.
- **Concluded:** Every conventional entrypoint (AGENTS/HANDOFF/SPEC/ONBOARDING/README-of-brain) now routes a new agent to the full context in ≤1 hop; CONTEXT.md is the master, RESOLVER routes, STATE gives status, AUDIT_LOG gives history. Design docs total ten + the consolidated red-team. Build phase is live and green (keystone: route-metadata stamping + ai-core generator + Joi→JSON-Schema + per-principal filter).
- **Artifacts:** `/CONTEXT.md`; banners on `AGENTS.md`/`HANDOFF.md`/`SPEC.md`; `docs/brain/RESOLVER.md`, `docs/brain/STATE.md`; edits to brain `README.md`, `ONBOARDING.md`; `libs/ai-core/src/tool-registry/filter-tools.ts` + test + barrel export.
- **Open:** next code increments — expose the registry (diagnostic endpoint / MCP server, needs `npm i @modelcontextprotocol/sdk`) so an agent can actually CALL a governed tool end-to-end; then tool descriptions from a module manifest. Gating decisions O1/O2/O4/O5/O7 still pending.

---

## T16 — 2026-07-02 · The working governed tool loop (list → filter → invoke) + expense endpoint

- **Ask:** "Yes" — wire the registry into the expense service and stand up the loop so an agent lists + calls a governed tool.
- **Done:** Built the **tool-server** layer in `libs/ai-core/src/tool-server/tool-server.ts`:
  `listToolsForPrincipal(app, ctx)` (generate+filter), `invokeTool(tool, args, ctx)` — **executes a tool
  over HTTP by calling the SAME guarded route a human hits** (Bearer token + x-tenant-id + correlation
  headers; path-param substitution; body for writes, query for GET), and `toMcpToolDefinition(tool)` (the
  dependency-free MCP bridge). Exported from the ai-core barrel. Added an **end-to-end integration test**
  (`test/tool-loop.spec.ts`) that stands up a real mini-app (context → authenticate → authorize(Casbin) →
  validate → handler + errorMiddleware) with an in-memory enforcer + signed JWTs, listens on an ephemeral
  port, and drives the loop via `invokeTool`. Added `test/jest.setup.ts` (sets AUTH_JWT_SECRET) + `setupFiles`.
  Wired into the service: `apps/expense/src/controllers/ai-tools.controller.ts` exposes
  `GET /expense/v1/_ai/tools` (authenticate-only catalog; carries no permission stamp so it never lists
  itself), registered in the controllers barrel.
- **Verified:** `nx test ai-core` = **18/18** (6 registry + 6 filter + 6 governed-loop). The loop proves:
  allowed call → **201**; caller lacking the permission → **403 from the PEP** (agent cannot bypass);
  invalid input → **400 from validate()**; bad token → **401**; GET path-param substitution → **200**.
  Strict typecheck clean for the ai-core lib AND the expense app (`tsc -p apps/expense/tsconfig.app.json`).
  147 existing lib tests unaffected.
- **Concluded:** the read-only/propose-safe **"agent lists + calls a governed tool"** loop is real and
  tested — "the agent reasons; the governed core acts" is now demonstrated in code, not just designed.
  Still entirely within the D18 safe slice (no writes to money/irreversible planes; no LLM in the loop yet
  — invocation is a deterministic HTTP client through the existing guards).
- **Artifacts:** `libs/ai-core/src/tool-server/tool-server.ts` (+ barrel export), `libs/ai-core/test/{tool-loop.spec.ts,jest.setup.ts}`, `libs/ai-core/jest.config.ts` (setupFiles), `apps/expense/src/controllers/ai-tools.controller.ts` (+ barrel).
- **Decision noted:** did NOT run `npm i @modelcontextprotocol/sdk` unprompted (repo/lockfile-mutating + network) — MCP transport is a ~30-line wrapper over `toMcpToolDefinition`+`invokeTool` once the founder OKs the dep. The HTTP loop already delivers the capability.
- **Open / next:** MCP transport (pending dep OK); the **agent orchestrator** (LLM picks a tool → invokeTool) = the first real "talk to the app"; tool descriptions from a module manifest; keep write-autonomy GATED (D19).

---

## T17 — 2026-07-02 · Parallel builds: MCP transport + agent orchestrator (both integrated, green)

- **Ask:** "Let's do both in parallel" — the agent orchestrator (LLM loop behind a gateway) AND the MCP transport; use a workflow since ultracode is on.
- **Done:** Installed the approved dep `@modelcontextprotocol/sdk@^1.29.0` (the shared prerequisite; done by me, not an agent). Ran a **2-agent Workflow in parallel**, each isolated to its own directory (no shared-file edits, relative-import tests, scoped test runs) to avoid conflicts + the tsc race:
  - **Agent A → `libs/ai-core/src/mcp/mcp-tool-server.ts`**: `createAegisMcpToolServer()` builds an MCP `Server`, maps the registry to `tools/list` via `toMcpToolDefinition` (JSON-Schema passthrough, no Zod), and routes `tools/call` through `invokeTool` (governed; `isError: !result.ok` surfaces PEP/validate denials). Transport-agnostic (returns server + connect/close). Used a SAFE FACADE (local typed interface + dynamic-import-with-cjs-fallback) so the ESM-only SDK doesn't break our strict commonjs/moduleResolution-node build.
  - **Agent B → `libs/ai-core/src/orchestrator/`**: `LlmClient` seam + `OpenAiCompatibleLlmClient` (fetch adapter to an OpenAI-compatible `/chat/completions` = LiteLLM/OpenAI/OpenRouter gateway; injectable fetch) + `runAgentTurn()` (offers the LLM ONLY the filtered tools; invokes the chosen tool via `invokeTool`; REFUSES any tool outside the filtered offer before any HTTP call). Result union: tool | message | refused.
  - **Integration (me):** added the four barrel exports to `libs/ai-core/src/index.ts`; ran the UNIFIED verification.
- **Verified:** `nx test ai-core` = **28/28** across 5 suites (registry 6 · filter 6 · tool-loop 6 · orchestrator 5 · mcp 5). Orchestrator tests use a stub `LlmClient` (offline) driving the real governed mini-app (tool/message/refused/not-offered) + a mocked-fetch unit test of the OpenAI-compatible client. MCP tests do a real in-memory `Client`↔`Server` round-trip (`tools/list` + `tools/call` allowed→201, denied→isError, no bypass), offline. **Strict lib typecheck clean** (facade kept the SDK out of the type graph); **expense app still typechecks** with the expanded barrel. 147 other lib tests unaffected.
- **Concluded:** the platform now has BOTH agent surfaces on the governed core — a **conversational orchestrator** (LLM picks among filtered tools → invokes through the guarded route) and an **MCP server** (external MCP clients like Claude drive the same governed tools). Both honor "the agent reasons; the governed core acts": the LLM only ever selects; execution always traverses authenticate→authorize(PEP)→validate→RLS→audit. Still the D18 safe slice — no write-autonomy; the LLM cannot invent or reach a tool the caller isn't permitted.
- **Parallelization method note (for future):** two code agents CAN run in parallel safely if partitioned to distinct dirs, forbidden from editing shared files (index.ts/package.json), tests use relative imports + `--testPathPattern` (so ts-jest compiles per-file, no cross-agent race), and the caller does barrel wiring + one unified verify. Worktree isolation is NOT usable here (git worktrees lack node_modules → no toolchain).
- **Artifacts:** `libs/ai-core/src/mcp/mcp-tool-server.ts` (+ test), `libs/ai-core/src/orchestrator/{llm-client,openai-compatible-client,agent-orchestrator}.ts` (+ test), `libs/ai-core/src/index.ts` (barrel), `package.json` (mcp dep).
- **Open / next:** a LIVE demo (real LLM gateway + running expense, or MCP over stdio/HTTP into Claude Desktop); then the **DANGER/HITL gating layer (D19)** — the blocker before any autonomous write on money/irreversible; then tool descriptions from a module manifest.

---

## T18 — 2026-07-02 · Parallel: the danger/HITL gating layer + a runnable governed-loop demo

- **Ask:** "yes" (build both in parallel) + "keep updating the docs."
- **Done (2-agent parallel Workflow, same partition discipline):**
  - **`libs/ai-core/src/danger/`** — the DANGER layer (2nd axis, orthogonal to authorization), grounded in
    agentic-operations.md §3 + the §0/§6 red-team corrections: `classifyDanger` (deterministic per-dimension
    scoring — destructiveness/blast-radius/monetary/sensitivity/regulatory; anomaly can only RAISE the level,
    never solely gate, never lower; thresholds configurable) → `decideCeremony` (level→ceremony:
    allow/confirm/typed_confirm/step_up/cooling_off/second_approver/alert_only/block; escalations for
    Tier-4/irreversible-money/regulatory; composes tighten-only vs risk tier; typed phrase e.g.
    "DELETE 4211 invoice"; **single-human tenant (approverPoolSize ≤ 1 or undefined) → requiresOutOfBand +
    reviewQueue, NEVER self-approval**) → `evaluateActionGate` + `requiredStepsBeforeInvoke`; plus an
    injectable `ApprovalGateway` interface (no hard @aegis/approvals dep — ai-core stays light).
  - **`scripts/demo/agent-loop-demo.ts`** + `AGENT_LOOP_README.md` — runnable offline demo (stub LLM by
    default; real gateway when AEGIS_LLM_BASE_URL/AEGIS_LLM_API_KEY set). Ran offline: create→**201**,
    read→**200**, viewer create not even offered→reply, create-as-viewer→**403** (PEP denies at the route),
    off-topic→reply. `runDemo()` exported + verified by `libs/ai-core/test/demo.spec.ts`.
  - **Integration (me):** added the 5 danger barrel exports to `libs/ai-core/src/index.ts`; ran the UNIFIED verify.
- **Verified:** `nx test ai-core` = **43/43** (7 suites: registry 6 · filter 6 · tool-loop 6 · orchestrator
  5 · mcp 5 · danger 14 · demo 1). Strict lib typecheck clean (no barrel collisions); expense app typechecks;
  147 substrate lib tests unaffected.
- **Docs updated (as requested):** `CONTEXT.md` §12 (current build state now lists tool-server, MCP,
  orchestrator+gateway, danger layer, demo; DESIGNED-NOT-built narrowed to the verifiability half + the
  further tracks); brain `STATE.md` (Done + Next); this entry.
- **Concluded:** the danger GATE now exists (the D19 human-friction half). Honest status: it is BUILT but
  **not yet enforced in the invoke path** — `runAgentTurn`/MCP `tools/call` don't yet consult
  `evaluateActionGate`; and the **verifiability half of D19** (independent different-model verifier / hardened
  Trust Rule) is still unbuilt. So autonomous WRITES on money/irreversible remain OFF; everything shipped is
  still the D18 safe read-only/propose-only slice.
- **Artifacts:** `libs/ai-core/src/danger/{types,danger-classifier,danger-policy,approval-gateway,danger-gate}.ts` (+ danger.spec.ts), `scripts/demo/{agent-loop-demo.ts,AGENT_LOOP_README.md}` (+ demo.spec.ts), `libs/ai-core/src/index.ts` (barrel), `CONTEXT.md`, `docs/brain/STATE.md`.
- **Open / next:** (1) the verifiability-half verifier; (2) WIRE the danger gate into the orchestrator + MCP invoke path (built ≠ enforced); (3) live demo w/ real gateway (needs infra + key); (4) module-manifest tool descriptions.

---

## T19 — 2026-07-02 · Both halves of D19: danger gate ENFORCED + independent verifier + MCP stdio

- **Ask:** "Let's do it in parallel" (enforce the danger gate + build the verifier + live-ready MCP) + keep updating docs. (First run hit the limit at 120s with nothing cached; re-ran after refresh — all three completed.)
- **Done (3-agent parallel Workflow, resumed after a limit-abort; then caller integration):**
  - **(A) Danger gate ENFORCED in the orchestrator** — `libs/ai-core/src/orchestrator/derive-danger-facts.ts` (deterministic method→verb, path→resourceClass, amount/count/irreversible) + `runAgentTurn` now computes `evaluateActionGate(deriveDangerFacts(tool,args), {approverPoolSize})` BEFORE invoke: `allow` → invoke (kind `tool`); anything else → new kind **`needs_ceremony`** (no HTTP call). Added `AgentTenantContext`, optional `params.approvals` (calls `ApprovalGateway.requireApproval` on `second_approver`), and the `AgentNeedsCeremonyTurn` union member.
  - **(B) Independent verifier (verifiability half of D19)** — `libs/ai-core/src/verification/{types,verifier,trust-rule}.ts`: `assertTrustForAutonomousWrite` — money/external/irreversible require deterministic recompute (matches expected) AND a **different-model** dual-control verify; sampled-alone forbidden; same-model verifier fails the independence precondition (identity-SoD ≠ independence). 11 tests.
  - **(C) MCP stdio server** — `scripts/mcp/aegis-mcp-stdio.ts` (Claude-Desktop-driveable over stdio; offline in-process app or live via `AEGIS_SERVICE_BASE_URL`; StdioServerTransport via the same safe-facade loader) + `AEGIS_MCP_README.md` (config snippet + real LLM-gateway env vars). 2 tests.
  - **Integration (me):** added barrel exports (`derive-danger-facts`, `verification/*`); ran the unified verify; **fixed the demo** — enforcing the danger gate correctly changed a create from 201 → `needs_ceremony` (a write is no longer auto-executed) which also short-circuited the old create-as-viewer 403 scenario, so I reshaped the demo + `demo.spec.ts` to tell the new story: write → `needs_ceremony`; and the no-bypass 403 proof now uses a LOW-DANGER read with a no-grant token (passes the gate, PEP denies at the route). Also fixed an over-strict assertion (a $1500 create is a lightweight `confirm`, so `requiresHuman` is correctly false; assert ceremony ≠ `allow` + level ≥ 1 instead).
- **Verified:** `nx test ai-core` = **59/59** across 9 suites (registry 6 · filter 6 · tool-loop 6 · orchestrator 8 · mcp 5 · danger 14 · verification 11 · demo 1 · mcp-stdio 2). Strict lib typecheck clean; expense app typechecks; 147 substrate tests unaffected.
- **Concluded:** BOTH halves of D19 now exist as enforceable code — the danger gate is ENFORCED in the loop (writes are surfaced, never auto-run) and the independent-verifier Trust Rule is implemented. IMPORTANT honesty: they are **not yet wired together** into a supervised-write path (a `needs_ceremony` write cannot yet proceed even after approval + verification — there's no combined path), and the gate is not yet wired into MCP `tools/call`. So fully-autonomous/supervised money writes remain OFF; everything shipped is still the D18 safe read-only/propose-only slice.
- **Docs updated:** `CONTEXT.md §12` (danger-enforced, verifier, MCP stdio; DESIGNED-NOT-built now = "wire gate+verifier into a supervised write path"); brain `STATE.md`; this entry.
- **Artifacts:** `libs/ai-core/src/orchestrator/{derive-danger-facts.ts, agent-orchestrator.ts}`, `libs/ai-core/src/verification/*` (+ verification.spec.ts), `scripts/mcp/{aegis-mcp-stdio.ts, AEGIS_MCP_README.md}` (+ mcp-stdio.spec.ts), `scripts/demo/agent-loop-demo.ts` (+ demo.spec.ts), `libs/ai-core/src/index.ts` (barrel), `CONTEXT.md`, `docs/brain/STATE.md`.
- **Next:** (1) the SUPERVISED-write path (combine gate+verifier; test that the unsafe path is blocked) + wire the gate into MCP tools/call; (2) live demo w/ real gateway (needs key/infra); (3) module-manifest tool descriptions.

---

## T20 — 2026-07-02 · The supervised-write path (D19 milestone) + manifest tool descriptions + PROGRESS briefing

- **Ask:** continue the plan in parallel; keep docs updated; **create a standing "everything" briefing doc** so each morning gives full context (done yesterday / do today / what's left / pipeline / every detail).
- **Done (2-agent parallel Workflow + caller integration):**
  - **(A) Supervised-write path** — `libs/ai-core/src/execution/supervised-write.ts`: `CeremonyEvidence`,
    `ceremonySatisfied(decision,evidence)` (per-ceremony proof: typed-confirm exact phrase, step-up verified,
    second_approver granted, cooling-off elapsed, out-of-band for single-human, block always refused),
    `mapBlast(facts)`, and `executeSupervisedWrite(params)` — fail-closed order: ceremony → (material writes)
    `assertTrustForAutonomousWrite` → only then `invokeTool`. **Wired the danger gate into MCP `tools/call`**
    (opt-in `dangerContext`): dangerous call → `isError` + required ceremony, no invoke.
  - **(B) Manifest descriptions** — `libs/ai-core/src/tool-registry/tool-manifest.ts`: `improveDescription`
    (imperative phrase, e.g. "Create an expense", singularizer fixed for -es clusters) + `ToolManifest` /
    `applyToolManifest` (override description + set `riskTier`/`tags`); `AegisTool` gains optional
    `riskTier?`/`tags?`; `generateToolRegistry` accepts `opts.manifest` and defaults description via
    `improveDescription`.
  - **Integration (me):** added barrel exports (`tool-manifest`, `execution/supervised-write`); ran the
    unified verify; **fixed a strict-build failure** the tests missed — an unused `paramSegments` local in
    `tool-manifest.ts` (ts-jest runs with noUnusedLocals:false; the lib build has it on).
- **Verified:** `nx test ai-core` = **75/75** across 11 suites (prev 9 + supervised-write 9 + tool-manifest
  7). Strict lib typecheck clean; expense app typechecks; 147 substrate tests unaffected. Headline: the
  supervised-write tests prove the UNSAFE path (no ceremony / verifier rejected / deterministic mismatch /
  sampled-only / wrong typed phrase / block) NEVER reaches `invokeTool`.
- **Concluded:** the **D19 milestone is complete** — a **human-supervised** dangerous write can now execute
  ONLY when (ceremony satisfied) ∧ (independent verifier passes), composing AUTHORIZATION × DANGER ×
  VERIFIABILITY. **Fully-autonomous (no-human) money/irreversible writes remain OFF by design** (the
  ceremony requires human evidence). Honest remaining gap: `executeSupervisedWrite` is proven in tests but
  not yet wired into a running end-to-end app flow (an endpoint/UI that collects approval + calls it).
- **Docs:** created the standing **`docs/brain/PROGRESS.md`** morning-briefing (briefing + full
  imagined→implemented→left→pipeline ledger; updated to T20); refreshed `STATE.md`; `CONTEXT.md §12`; this entry.
- **Artifacts:** `libs/ai-core/src/execution/supervised-write.ts` (+ supervised-write.spec.ts), edits to
  `src/mcp/mcp-tool-server.ts`; `libs/ai-core/src/tool-registry/{tool-manifest.ts,generate-tool-registry.ts,types.ts}` (+ tool-manifest.spec.ts); `libs/ai-core/src/index.ts` (barrel); `docs/brain/PROGRESS.md`, `STATE.md`, `CONTEXT.md`.
- **Next:** expose supervised-write as a running flow; prefer `riskTier` in `deriveDangerFacts`; live real-LLM demo (needs founder key/infra); conversation memory → module manifest + Entitlement Service.

---

## T21 — 2026-07-02 · Fanned out the remaining safe-slice builds (4 in parallel) — 103/103

- **Ask:** implement the remaining; fan out all remaining implementations (ultracode).
- **Scope call (honest):** fanned out everything **safely buildable + offline-testable now, within the D18
  safe slice**; explicitly deferred the infra/decision-gated items (live real-LLM demo — needs founder key;
  full Entitlement Service — DB+Chargebee + O1; pgvector app-brain — DB; voice/products/AR — heavy/gated).
- **Done (4-agent parallel Workflow + caller integration):**
  - **(1) Supervised action broker** — `libs/ai-core/src/execution/supervised-action-broker.ts`
    (`PendingActionStore`/`InMemoryPendingActionStore`, `SupervisedActionBroker.propose`/`confirm`): the
    running two-step flow over `executeSupervisedWrite` — propose gates + persists the pending action
    (surfacing the ceremony), confirm executes only once ceremony + verifier pass. + `expense`
    `/_ai/act` + `/_ai/act/:id/confirm` controller (typecheck-verified; needs infra to run). 5 tests.
  - **(2) Conversation/session memory** — `libs/ai-core/src/memory/` (`ConversationStore`,
    `InMemoryConversationStore`, `sessionKey`, `runConversation` wrapper — orchestrator untouched;
    isolation-in-the-key). 4 tests.
  - **(3) Generative UI (A2UI-shaped, UI-as-data)** — `libs/ai-core/src/ui/` (`UiComponent` union;
    `renderTurn` incl. an **approval card** for `needs_ceremony`; `toolInputForm` from a tool's schema;
    a test asserts NO function values — the UI-as-data invariant). 10 tests.
  - **(4) Registry drift-gate** — `libs/ai-core/src/tool-registry/registry-validation.ts`
    (`validateToolRegistry` — the CapabilityManifest.Validate analog: errors on placeholder description /
    empty permissions / missing schema / duplicate names; warns on writes lacking a risk tier). 9 tests.
  - **Integration (me):** added 6 barrel exports; wired `deriveDangerFacts` to prefer a tool's explicit
    `riskTier`; ran the unified verify; **fixed one expense typecheck error** (the broker controller
    assigned `req.params.id` (`string | string[]`) to a string — switched to the house `routeParam` helper).
- **Verified:** `nx test ai-core` = **103/103** across 15 suites; strict lib typecheck clean; **expense app
  typechecks** (incl. the new `/_ai/act` + `/_ai/tools` controllers); 147 substrate tests unaffected.
- **Concluded:** the safe read-only/propose/human-supervised slice is now broadly built end-to-end — tool
  discovery → filter → orchestrate (LLM) / MCP → danger gate → supervised propose→confirm (with verifier) →
  UI-as-data rendering → registry drift-gate + memory. **No fully-autonomous money writes** (by design).
  What remains is infra/decision-gated (live demo, Entitlement Service, pgvector brain, renderer, voice, products).
- **Docs updated:** `PROGRESS.md` (briefing → T21, ledger +4 rows, where-we-are, pipeline renumbered),
  `STATE.md`, `CONTEXT.md §12`, this entry.
- **Artifacts:** `libs/ai-core/src/{execution/supervised-action-broker.ts, memory/*, ui/*, tool-registry/registry-validation.ts}` (+ 4 specs), `apps/expense/src/controllers/ai-act.controller.ts` (+ barrel), edits to `libs/ai-core/src/{index.ts, orchestrator/derive-danger-facts.ts}`; docs.
- **Next:** live demo (founder key/infra) + run `/_ai/act` live; then module manifest + Entitlement Service (O1); pgvector app-brain; a first autonomous capability; the UI renderer + voice.

---

## T22 — 2026-07-02 · Branch + real infra + 3 infra-backed builds (multi-LLM · entitlement · Redis persistence)

- **Ask:** clarify "safe slices" (are we skipping for complexity?); move all work to a NEW branch (nothing pushed); do LLM integration the Wayfinder way (adapter/factory, multiple LLMs, priority-based, selectable, runtime-switchable); Postgres+Docker+Redis are available locally — **set up whatever's needed, don't cut corners or skip because of setup**; fan out parallel agents; do passes; keep implementing until a benchmark, then founder adds LLM keys.
- **Clarified "safe slice":** it is ONE deliberate safety property (agent never autonomously moves money/irreversible without a human ceremony + independent verifier — the D19 gate), NOT corner-cutting for complexity. The only real deferrals were infra/decision-gated; the infra excuse is now removed.
- **Branch:** created `feat/agentic-platform` from `main`; committed the full T14–T21 agentic layer as a checkpoint (`cf230f0`). main untouched; nothing pushed.
- **Infra (real, no mocks):** brought up the aegis-stack **Postgres @ 55432 (fully migrated — the `aegis_pg` volume already had all 68 tables)** + **Redis @ 6380** via docker compose on override ports (host 5432/6379 are the founder's own). `aegis_owner` = DDL/migrations; non-owner `aegis_app` = RLS runtime (can't DDL — by design). Confirmed the host migrate command (ts-node + tsconfig-paths).
- **Done (3-agent parallel Workflow + integration):**
  - **(1) Multi-LLM gateway** (`libs/ai-core/src/llm/`) — studied Wayfinder's `ProviderChain` pattern; built a provider registry that is **priority-ordered, selectable (`setActive`), runtime-switchable, with per-hop fallback**; `AnthropicLlmClient` (fetch, no dep) alongside `OpenAiCompatibleLlmClient`; `buildLlmGateway(specs)` + `readLlmProviderSpecsFromEnv()` (AEGIS_LLM_PROVIDERS json, or AEGIS_LLM_* single provider). **23 tests** (offline).
  - **(2) Module Entitlement Service** (`libs/db/src/entitlement/` + `apps/cli/src/migrations/0032_tenant_modules.ts`) — the pay-per-module CORE: `tenant_modules` table with FORCE RLS (RESTRICTIVE tenant policy + aegis_app grants), repo (`withTenantTransaction`), `EntitlementService` (`isModuleEnabled`/`listEnabledModuleIds`/`setModuleEntitlement`), and a sync-predicate builder for the ai-core tool filter (`moduleIdFromTool`/`entitledModuleIds`). Migration APPLIED to the live DB; **6/6 integration tests against real Postgres proving RLS tenant isolation** (owner-seed / app-role reads). Added `@aegis/events` to db jest moduleNameMapper (the real withTenantTransaction import chain is now exercised live).
  - **(3) Redis-backed durable stores** (`libs/ai-core/src/persistence/`) — `RedisConversationStore` + `RedisPendingActionStore` (TTL'd; ioredis, no dep) so sessions + pending supervised actions survive restarts. **Live-Redis integration test** (unique key prefix + cleanup).
  - **Integration (me):** added 7 ai-core barrel exports (llm + persistence); (Track 2 owned the libs/db barrel + migration index). Ran the unified verify.
- **Verified:** `nx test ai-core` = **134/134** (17 suites); `nx test db` = **21/21** (incl. the live-DB entitlement RLS test); ai-core lib + db lib + expense app all strict-typecheck clean.
- **Docs updated:** `PROGRESS.md` (T22 briefing + ledger +4 rows + next + count), `STATE.md`, `CONTEXT.md §12`, this entry.
- **Next:** pgvector app-brain (stand up pgvector image) + self-knowledge RAG; a first autonomous capability; entitlement completion (Chargebee webhooks + wire the live tool filter); then the founder drops LLM keys → live end-to-end demo. Fully-autonomous money writes stay gated (D19).

---

## T23 — 2026-07-04 · pgvector app-brain + first autonomous capability (propose-only self-audit) + push

- **Ask:** rerun the parallel agents to finish the T22-next passes; continue + complete the implementation;
  push `feat/agentic-platform` to the founder's personal GitHub (they'd been switched to `main` via GitHub
  Desktop); keep all handoff docs current; and separately **analyze** (no code) a proposal to generalize
  ABAC into data-driven policies.
- **Recovery:** the two background build agents from the prior turn were killed by a session limit, but they
  had already WRITTEN their files — GitHub Desktop auto-stashed the uncommitted work when the branch was
  switched to `main`. Recovered by `git checkout feat/agentic-platform` + `git stash pop` (restored the
  migration, `libs/db/src/brain/*`, `libs/ai-core/src/autonomy/*`, the self-audit spec, and the
  docker-compose pgvector edit). The two app-brain test files hadn't been reached — the caller wrote them.
- **Infra → pgvector:** swapped the compose Postgres image to `pgvector/pgvector:pg15` (PG 15 major
  unchanged → `aegis_pg` volume + all 69 tables mounted as-is; `vector` 0.8.4 installed; L2/cosine
  smoke-tested; Redis untouched). Removed the obsolete compose `version:` key.
- **Done (2 tracks, integrated + verified by the caller):**
  - **(1) pgvector app-brain** (`libs/db/src/brain/` + `apps/cli/src/migrations/0033_app_brain_memory.ts`) —
    the per-tenant self-knowledge / RAG store. `app_brain_memory`: `vector(384)` column, HNSW
    `vector_cosine_ops` index, partial-unique `(tenant_id, kind, ref) WHERE ref IS NOT NULL` upsert index,
    FORCE + RESTRICTIVE RLS, `aegis_app` grants. `EmbeddingClient` seam + offline deterministic
    `HashingEmbeddingClient` (FNV-1a bag-of-tokens, L2-normalized — real provider is a drop-in);
    `AppBrainRepository` (`<=>` cosine `searchSimilar`, RLS-scoped `remember`/`deleteByRef`);
    `AppBrainService` (owns embed). Migration APPLIED to the live DB; schema verified. **9 tests** (5 offline
    embedding determinism/normalization/similarity + 4 live-pgvector recall-ranking / RLS-isolation / upsert).
  - **(2) First autonomous capability — PROPOSE-ONLY self-audit** (`libs/ai-core/src/autonomy/`) —
    `SelfAuditCapability` runs vetted DETERMINISTIC checks (LLM never authors them), routes each finding
    through the SAME hardened Trust Rule that guards autonomous writes (V1 deterministic AND, for material
    blasts, a different-model V2 `DualControlVerifier`), and emits **proposals only** to an injected sink.
    Safety invariant enforced BY CONSTRUCTION: `SelfAuditDeps` has no executor to inject → no `invokeTool` /
    `executeSupervisedWrite` / broker → nothing is ever auto-executed; unverified material findings are
    `needs_human`. **6 tests** incl. the explicit safety property.
  - **Integration (caller):** wired both barrels (`libs/db` +4 brain exports, `libs/ai-core` +2 autonomy
    exports) and the migration index (`0033`); wrote the two app-brain test files; ran the migration; fixed
    one test-only import (`APP_BRAIN_EMBEDDING_DIM` is exported from `brain/types`, not `brain/embedding-client`).
- **Verified:** `nx test db` = **30/30** (5 suites) · `nx test ai-core` = **140/140** (18 suites) · strict
  `tsc --noEmit` over all new files + graph = clean.
- **Git:** committed to `feat/agentic-platform`; **pushed `-u origin feat/agentic-platform`** to
  https://github.com/25ankurpandey/aegis (the branch now exists on the founder's personal GitHub; `main`
  untouched).
- **Analysis deliverable (no code):** `docs/strategy/abac-generalization.md` — feasibility + target
  architecture + step-by-step plan + risks/tests for replacing hardcoded ABAC helpers (`amountCapPolicies`)
  with a DB-backed generic policy loader (persisted `policies` → `AccessShape.PolicyRule[]`, Redis
  tenant+permission cache with PAP-driven invalidation, a PIP to populate `principal.attributes` —
  `teamIds`/`approvalLimit` — that login does NOT currently set), plus the `memberships` (many-tenant
  identity) question. Verdict: high-value, feasible, incremental; the load-bearing prerequisite is the PIP
  (today `own_and_team` and the amount-cap rule silently no-op because those attributes are never populated).
- **Next:** entitlement completion (Chargebee → tenant_modules; wire live tool filter); bring the app-brain
  online inside a capability; the ABAC generalization build (analysis-first); then the founder's LLM key →
  live end-to-end demo. Autonomous money writes stay gated (D19); products/AR/omniscience gated (D20).

---

## T24 — 2026-07-07 · Wayfinder memory port + app-brain online + Chargebee loop closed + ABAC Phase 0

- **Ask:** "use the workflow and start implementing everything possible in parallel"; study the founder's
  Wayfinder repos' embedding/memory infrastructure (Android/VR-constrained there) and port what applies
  (server-side Aegis can be more flexible).
- **Wayfinder study:** found the memory architecture in `~/Documents/GitHub/Wayfinder` — ADR-0001 (memory =
  Postgres + pgvector, NOT a markdown vault — same store we already built), `MemoryStore.kt`
  (supersede-by-subject, tombstones, embedder-space tags, minScore, profile/salient), tiered retrieval
  (Letta), the 3 memory tools, mem0 post-turn extraction. Ported the semantics; DROPPED the local-first
  machinery (sync engine, LWW cursors, push queues, brute-force scans) — Aegis is Postgres-authoritative
  with HNSW + RLS. Mapping doc: `docs/brain/designs/agent-memory.md`.
- **Interrupted + recovered (twice-proven pattern):** the 4-track workflow was killed by a session limit
  after 1 track finished — but the other 3 had already written most files. Inventoried via git status,
  restarted the exited compose containers (Docker restart had stopped them), ran the landed specs
  (agent-memory 14/14, chargebee 27/27 — green as landed), spawned ONE completion agent for the
  half-done ABAC track, and finished the small gaps (live chargebee spec, design doc, wiring) myself.
- **Done (4 tracks, integrated + verified):**
  - **(1) db-memory** — migration `0034_app_brain_memory_v2` (subject/embedder/importance/valid_to +
    partial supersede index); v2 repo/service: atomic supersede-by-subject inside `withTenantTransaction`,
    soft-invalidation everywhere (reads filter `valid_to IS NULL`; ref-upsert REVIVES dead rows keeping the
    one-row-per-ref invariant), minScore (`distance <= 1 - minScore`), embedder filter, deterministic
    `profile()`/`salient()`. Plus `indexers.ts` (indexTools/indexAuditProposal → the app-brain is ONLINE;
    live test: recall ranks the expense tool first).
  - **(2) agent-memory (ai-core)** — `AgentMemoryStore` structural seam (AppBrainService satisfies it; libs
    stay decoupled); `makeMemoryTools` (remember/recall/forget as BUILT-IN tools with declared danger facts —
    run through the SAME `evaluateActionGate`; a risky builtin gets `needs_ceremony`, tested); `buildMemoryContext`
    (Tier-0 profile ≤40 + Tier-1 salient ≤10 `[MEMORY]` preamble, fail-soft); `extractMemoryOps`/`applyMemoryOps`
    (mem0: strict-JSON ops, malformed ⇒ [], minConfidence 0.7); `runAgentTurn` gained `builtinTools` (registry
    wins name collisions), `runConversation` gained `agentMemory`. 14 new tests.
  - **(3) entitlement-live** — `chargebee-webhook.ts` pure mapper (strict UUID tenant from `cf_tenant_id`,
    unmapped skipped never guessed; created/activated/changed/resumed/reactivated → active; cancelled →
    paid-through-grace via `current_term_end`; deleted/paused → off; at-least-once safe by upsert; out-of-order
    caveat documented) + user-management `POST /webhooks/chargebee` (Basic auth, hash-then-timingSafeEqual,
    fail-closed unconfigured, always-200 on auth success, NOT in the tool registry) + expense `entitlementGate`
    behind `AEGIS_ENTITLEMENT_FILTER=on` (default OFF/fail-open, documented; list + invoke share ONE predicate).
    Live integration test: created→enabled under RLS, replay-idempotent (1 row), deleted→disabled,
    suite-plan multi-module, future/past term-end grace.
  - **(4) ABAC Phase 0 (dormant)** — landed mapper/ports verified doc-conformant; completion agent added PAP
    write-time hardening (Joi + service-level MERGED-row validation on PATCH — catches effect-flip-to-allow on
    a `'*'` row; `ErrUtils.validation` idiom), `scripts/abac/audit-policies.ts` (owner `row_security = off`
    audit; smoke-ran: 0 rows, safe for Phase 1), and 51 tests (44 mapper incl. all-or-nothing BOTH effects,
    12 malformed envelopes, 7 malformed `$attr`; 7 ports). No authorize() change.
  - **Integration (caller):** barrels (db +2, ai-core +4, access-control +2), migration index (0034), ran the
    migration, flipped deep imports → `@aegis/access-control`, deleted 2 stray `Untitled` files, wrote the live
    chargebee spec + the design doc.
- **Verified:** ai-core **154/154** (19 suites) · db **69/69** (8 suites, all live vs pgvector) ·
  access-control **104/104** (9 suites) · expense + user-management typecheck · strict tsc over new files clean.
- **Next:** ABAC Phase 1 (dbPolicies + port impl + expense approve routes behind flag) then Phase 2 (the PIP);
  live e2e demo + semantic embeddings (founder keys); run self-audit in anger + index findings.

---

*Append new entries below this line, keeping chronological order (oldest first). Next entry: T25.*
