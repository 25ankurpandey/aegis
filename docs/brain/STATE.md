# STATE — where the project is right now (canonical; single source for "current state")

> The one place for current status. Update this at the end of every working session (it is the
> single-writer control surface; the narrative history lives in [`AUDIT_LOG.md`](AUDIT_LOG.md)).
>
> **Last updated:** 2026-07-10 (session T31). Branch **`feat/agentic-platform`** (pushed to origin =
> personal GitHub 25ankurpandey/aegis); live **pgvector** Postgres @ 55432 + Redis @ 6380 up (compose;
> note: a Docker restart stops them — `AEGIS_POSTGRES_PORT=55432 AEGIS_REDIS_PORT=6380 docker compose up -d`).

## Phase
**Design phase COMPLETE; BUILD phase STARTED.** All ten strategy docs written and adversarially
red-teamed; the consolidated red-team defines the safe build sequence. The `CONTEXT.md` master + this
`docs/brain/` second brain exist so any new agent has zero-explanation context.

## Done
- **Vision & design:** the ten `docs/strategy/*` docs (modular-platform-plan, agentic-platform-design,
  ai-native-core, agentic-operations, platform-omniscience, stack-sufficiency, knowledge-brain,
  ecosystem-ar-protocol, agentify-and-policing, yc-rfs-fit) + `red-team-consolidated.md`. All red-teamed.
- **Context infra:** `/CONTEXT.md` (master), `/ONBOARDING.md`, `docs/brain/` (README, AUDIT_LOG T1–T15,
  instructions, designs, discussions [D1–D20, O1–O8], architectures, RESOLVER, this STATE). Banners added
  to `AGENTS.md`/`HANDOFF.md`/`SPEC.md` routing to `CONTEXT.md`.
- **Code (the agentic keystone — REAL, green):**
  - `libs/service-core/src/bootstrap/route-metadata.ts` — permission + schema stamping; `authorize()` and
    `validate()` now stamp their `Permission` and Joi schema.
  - `libs/ai-core/` — the agentic keystone, now with a full working loop:
    `generateToolRegistry(app)` (authz-bound self-describing tools from the live router) · dependency-free
    **Joi→JSON-Schema** converter · `filterToolsForPrincipal()` (entitlement×permission pre-filter) ·
    **`tool-server`**: `listToolsForPrincipal()`, `invokeTool()` (executes a tool over HTTP through the
    SAME guarded route a human hits — never bypasses the core), `toMcpToolDefinition()` (MCP bridge).
    **`nx test ai-core` = 18/18** incl. a real end-to-end governed loop (list→filter→invoke → core
    ALLOWS 201 / DENIES via PEP 403 / rejects bad input 400 / rejects bad auth 401). 147 existing lib
    tests still pass; strict typecheck clean.
  - **`apps/expense`** — `AiToolsController` exposes `GET /expense/v1/_ai/tools` (the auto-generated
    capability catalog for this service); registered in the controllers barrel; app typechecks clean.
  - **`libs/ai-core/src/mcp/`** — `createAegisMcpToolServer()`: exposes the registry over **MCP**
    (`@modelcontextprotocol/sdk` v1.29, installed) — `tools/list` from `toMcpToolDefinition`, `tools/call`
    routed through `invokeTool` (governed; `isError` on PEP/validate denial, never a bypass). Transport-agnostic.
  - **`libs/ai-core/src/orchestrator/`** — the first "talk to the app" loop: a provider-agnostic
    `LlmClient` seam + `OpenAiCompatibleLlmClient` (fetch adapter for LiteLLM/OpenAI/OpenRouter = the LLM
    gateway) + `runAgentTurn()` which offers the LLM only the FILTERED tools, invokes the chosen one via
    `invokeTool`, and REFUSES any tool outside the filtered set. **The danger gate is now ENFORCED here**
    (`deriveDangerFacts` → `evaluateActionGate` before invoke): a write/dangerous action returns
    **`needs_ceremony`** and is never auto-executed.
  - **`libs/ai-core/src/danger/`** — the DANGER/HITL gating layer (2nd axis, orthogonal to authz):
    deterministic `classifyDanger` (anomaly can only RAISE, never solely gate) + `decideCeremony`
    (graduated: confirm → typed-confirm → step-up → cooling-off → second-approver → block; tightens-only
    vs risk tier; **single-human tenant → out-of-band + review-queue, never self-approval**) + injectable
    `ApprovalGateway` seam (no hard @aegis/approvals dep) + `evaluateActionGate`.
  - **`libs/ai-core/src/verification/`** — the VERIFIABILITY half of D19 (hardened Trust Rule):
    `assertTrustForAutonomousWrite` requires deterministic recompute AND a **different-model** dual-control
    verify for money/external/irreversible; sampled-alone forbidden; same-model verifier fails independence.
  - **`scripts/mcp/aegis-mcp-stdio.ts`** (+ `AEGIS_MCP_README.md`) — Claude-Desktop-driveable MCP server
    over stdio (offline in-process app, or live via `AEGIS_SERVICE_BASE_URL`).
  - **`scripts/demo/agent-loop-demo.ts`** — runnable offline demo; now shows the danger gate:
    create→**needs_ceremony** (write gated), read→200, unpermitted→not offered, no-grant read→**403 (PEP)**,
    off-topic→reply. Real gateway via env vars.
  - **`libs/ai-core/src/execution/supervised-write.ts`** — the D19 MILESTONE: `executeSupervisedWrite`
    runs a dangerous write ONLY after `ceremonySatisfied` (approval/step-up/typed-confirm/cooling-off) AND
    (for money/external/irreversible) `assertTrustForAutonomousWrite` passes. Fail-closed; 9 tests prove the
    unsafe paths never reach `invokeTool`. MCP `tools/call` now danger-gated too (opt-in `dangerContext`).
  - **`libs/ai-core/src/tool-registry/tool-manifest.ts`** — `improveDescription` (imperative default,
    not "METHOD path") + `ToolManifest`/`applyToolManifest` (override description + set riskTier/tags).
  - **[T21] Supervised action broker** (`src/execution/supervised-action-broker.ts`) + `expense`
    `/_ai/act` + `/_ai/act/:id/confirm` — the running propose→confirm flow over `executeSupervisedWrite`.
  - **[T21] Conversation/session memory** (`src/memory/`) — `ConversationStore` + `runConversation`,
    isolation-in-the-key. **Generative UI** (`src/ui/`) — `renderTurn` (+ approval card) + `toolInputForm`
    (UI-as-data). **Registry drift-gate** (`src/tool-registry/registry-validation.ts`). `deriveDangerFacts`
    now prefers a tool's explicit `riskTier`.
  - **[T22] Multi-LLM gateway** (`libs/ai-core/src/llm/`) — priority/selectable/runtime-switch/fallback
    registry + `AnthropicLlmClient` + `buildLlmGateway` (env-config; lights up when keys added). 23 tests.
  - **[T22] Module Entitlement Service** (`libs/db/src/entitlement/` + migration `0032_tenant_modules`) —
    `tenant_modules` with FORCE RLS; repo + service + tool-filter predicate; **6/6 live-Postgres RLS tests**.
  - **[T22] Redis-backed durable stores** (`libs/ai-core/src/persistence/`) — conversation + pending-action
    stores (TTL'd) survive restarts; **live-Redis test**.
  - **[T22] Infra:** aegis Postgres @ 55432 (migrated) + Redis @ 6380 (compose, override ports); branch `feat/agentic-platform`.
  - **[T23] Infra → pgvector:** swapped the compose Postgres image to `pgvector/pgvector:pg15` (same PG 15
    major → the `aegis_pg` volume + all 69 tables mounted unchanged; `vector` 0.8.4 now installed).
  - **[T23] pgvector app-brain** (`libs/db/src/brain/` + migration `0033_app_brain_memory`) — the per-tenant
    self-knowledge / RAG store: `app_brain_memory` (`vector(384)` col, HNSW `vector_cosine_ops` index,
    partial-unique `(tenant,kind,ref)` upsert index, FORCE RLS) + provider-agnostic `EmbeddingClient` seam
    (offline deterministic `HashingEmbeddingClient` default) + `AppBrainRepository` (`<=>` cosine recall,
    RLS-scoped) + `AppBrainService` (owns the embed step). **9 tests** (5 offline embedding + 4 live-pgvector
    recall/RLS-isolation/upsert integration).
  - **[T23] First autonomous capability — PROPOSE-ONLY self-audit** (`libs/ai-core/src/autonomy/`) —
    `SelfAuditCapability` runs vetted deterministic checks, pushes each finding through the SAME hardened
    Trust Rule that guards autonomous writes (`assertTrustForAutonomousWrite` + different-model
    `DualControlVerifier`), and emits **proposals only** to an injected sink. Safety invariant enforced by
    construction: NO executor dependency, NO write path — a material finding that is not independently
    verified is `needs_human`; nothing is ever auto-executed. **6 tests** (incl. the safety property).
  - **[T24] Agent memory — the Wayfinder port** (`libs/ai-core/src/agent-memory/` + `libs/db/src/brain/` v2 +
    migration `0034_app_brain_memory_v2`) — supersede-by-subject (atomic, RLS-scoped), soft-invalidation
    (`valid_to`), embedder-space tagging, minScore recall, `profile()`/`salient()` tiers; the 3 memory tools
    (`memory_remember`/`recall`/`forget` — decisions = kind `decision`) as danger-gated BUILT-IN tools;
    tiered `[MEMORY]` context injection in `runConversation`; mem0-style post-turn extraction
    (ADD/UPDATE/DELETE/NOOP, confidence-gated, fail-soft). Design doc: `docs/brain/designs/agent-memory.md`.
  - **[T24] App-brain ONLINE** (`libs/db/src/brain/indexers.ts`) — `indexTools` + `indexAuditProposal`
    materialize the tool registry and audit findings into `app_brain_memory`; live test proves recall
    ("create an expense") ranks the expense tool first.
  - **[T24] Entitlement loop CLOSED** (`libs/db/src/entitlement/chargebee-webhook.ts` + user-management
    `POST /webhooks/chargebee` + expense wiring) — Chargebee events → idempotent `tenant_modules` upserts
    (at-least-once safe; paid-through-grace on cancel; strict UUID tenant from `cf_tenant_id`); the
    entitlement predicate now gates the LIVE tool surface (list + invoke identically) behind
    `AEGIS_ENTITLEMENT_FILTER=on` (default OFF/fail-open — flip after billing ingestion populates rows).
  - **[T24] ABAC Phase 0 shipped (dormant)** (`libs/access-control/src/policy-{row-mapper,ports}.ts` +
    PAP write-time hardening in user-management + `scripts/abac/audit-policies.ts`) — the PolicyRow→PolicyRule
    mapper (all-or-nothing load, `$attr` validation, scope/wildcard-allow bans), port interfaces, and PAP
    rejection of invalid policies. NO authorize() behavior change. Per `docs/strategy/abac-generalization.md` §5.
  - **[T25] ABAC Phase 1** (`libs/db/src/policy-read-port.ts` + `libs/access-control/src/policy-loader.ts`
    `dbPolicies`/`combinePolicies` + expense/user-management bootstrap registration) — the shared-DB
    `PolicyReadPort` (RLS-scoped raw SELECT of persisted `policies`, mapped all-or-nothing, FAIL-CLOSED on
    error) wired on the two expense approve routes behind `AEGIS_ABAC_DB_POLICIES=on` (default OFF). Live
    integration test (6/6): tenant A loads its deny policy, tenant B sees nothing (RLS), a malformed row
    throws `POLICY_LOAD_FAILED`.
  - **[T25] SECURITY AUDIT + docs** — multi-agent audit (4 dimensions, adversarially verified) →
    `docs/strategy/security-model.md` (how the 4 fences work + how AI inherits them + 30 verified
    guarantees) and `docs/strategy/security-findings.md` (16 confirmed findings + remediation plan). **The
    tenant fence is a hard, live-verified guarantee; all findings are within-tenant.** Top gaps: the
    **missing PIP** makes `own_and_team`, the approval amount-cap, and `manager_of` inert (silent no-op);
    invoice/pay-run/single-expense routes lack row-scope; propose→confirm doesn't bind confirmer↔proposer;
    the `isAgent` self-confirm guard is dead code; built-in memory tools have no per-user authz.
  - **[T26] ABAC Phase 2 — the PIP + fence fixes** (security-findings P0) — `UserRepository.loadPipAttributes`
    resolves `teamIds` (from `team_members`) + `managerOf` (from `approval_hierarchy`) inside the RLS tx;
    `AuthService.login` mints them into the signed JWT (unforgeable, no per-request DB). **`own_and_team`
    now enforces** (expense report loader sets `ResourceRef.teamId` → teammate allowed, other team denied);
    **`checkRowScope` is fail-closed** (missing scope→own-only, unknown→deny); **`manager_of` has a real
    source**. Closes **SCOPE-04, SCOPE-05, ABAC-02**; unblocks the amount-cap (needs `approvalLimit` source
    — founder Decision 1). Live PIP test proves resolution + tenant isolation. Also fixed 2 pre-existing
    T25 PAP-validator test regressions.
  - **[T27] Amount-cap + per-user memory + audit sweep** (migrations 0035/0036 applied) — closed
    ABAC-01/04, AGENT-03, MEM-01/02/03 + the reporting row-scope gaps. See the T27 AUDIT_LOG entry.
  - **[T28] MEM-04 + expense-list team + row-scope gate + RECONCILIATION capability** — see the T28
    AUDIT_LOG entry. Closes the last finding (16/16) + ships the first real autonomous capability.
  - **[T29] Reconciliation DEEPENED into a real financial-integrity capability** — vetted RLS-scoped
    deterministic queries over the REAL domain schema (`libs/db/src/reconciliation/queries.ts`): 3 checks
    (expense-report declared-total vs computed line-items · unresolved `flagged` duplicate invoices ·
    expenses orphaned on a soft-deleted report), each propose-only/reversible ⇒ V1-verified (no LLM key);
    verified findings indexed into the app-brain as recallable `audit_finding` memories; a per-tenant
    runner `scripts/reconciliation/run-reconciliation.ts`. Live real-schema test proves it finds exactly
    the planted discrepancies with NO domain write.
  - **[T30] Reconciliation capability COMPLETE** — HTTP surface in expense (`POST /_ai/reconcile` runs it +
    indexes findings; `GET /_ai/reconcile/findings` lists the tenant's `audit_finding` proposals; guarded by
    `audit.view`) + `AppBrainService.listByKind` + the runner gained `--all` (scheduled all-tenants sweep,
    cron target; found real flagged-duplicate invoices in a smoke run).
  - **[T31] Generative-UI renderer** (`libs/ai-core/src/ui/render-html.ts`) — the previously out-of-scope
    renderer for the UI-as-data layer: pure, XSS-safe, dependency-free `renderComponentToHtml`/`renderUiToHtml`/
    `renderUiPage` over the whole `UiComponent` union (text/badge/alert/keyValue/table/form/approvalCard);
    preserves the invariant (every value escaped, NO inline JS, actions as `data-*` + labeled buttons only).
    Demo script writes an openable page; **`GET /_ai/reconcile/findings.html`** serves a tenant's live
    findings as HTML — the agent loop is now VISIBLE in a browser with no LLM key / front-end build.
  - **Totals (T31):** `nx test ai-core` = **188/188** · `nx test db` = **99/99** (live) · `nx test
    access-control` = **126/126** · `nx test service-core` = **93/93** · `nx test user-management` =
    **41/41** · `nx test invoice` = **50/50** · `nx test payroll` = **84/84** · `nx test expense` =
    **79/79** · `nx test reporting` = **18/18**; all apps typecheck; strict `tsc` clean.
  - **(superseded) T25 totals:** `nx test db` = **79/79** (10 suites, live
    pgvector/RLS/Chargebee/policy-read-port) · `nx test access-control` = **114/114** (10 suites); strict
    `tsc --noEmit` clean; expense + user-management apps typecheck.

## In progress
- (nothing executing right now.)

## Next (recommended order) — post-T26 (security remediation continuing)
> **SECURITY REMEDIATION COMPLETE — ALL 16 of 16 findings closed, and the fence surface is
> regression-gated** (`row-scope-gate.spec.ts` fails if a new owned-resource route ships unfenced). T26
> did the row-scope slice + agent-path hardening; T27 closed the amount-cap + per-user memory + swept the
> 4 never-covered services; **T28 closed MEM-04 (session key binds userId), finished the expense-list
> own_and_team parity, added the regression gate, AND shipped the first REAL autonomous capability —
> RECONCILIATION** (deterministic checks → verified findings → recallable app-brain proposals; live-tested).
1. **Founder-gated unlocks (need YOU, not code):** drop `AEGIS_LLM_*` → live end-to-end demo (`/_ai/act` +
   agent memory + reconciliation via MCP/Claude Desktop); an embedding-provider key → semantic app-brain recall.
2. **Other net-new (buildable now):** more reconciliation checks (payroll tax, invoice AR vs ledger);
   an interactive/client generative-UI surface (a real front-end app or wiring the renderer's data-action
   buttons to the governed routes) + voice; Chargebee live webhook wiring (flip `AEGIS_ENTITLEMENT_FILTER=on`);
   ABAC Phase 3+ (env/time conditions, obligations, retire hardcoded helpers); a real scheduler/worker for
   the `--all` reconciliation sweep (today it's a cron-able script).
4. **Live end-to-end demo** — founder drops `AEGIS_LLM_*` (gateway lights up) → run `/_ai/act` + agent memory
   against live `expense` / MCP into Claude Desktop; a real embedding key upgrades recall to semantic.
5. Generative-UI **renderer** + **voice**; enterprise/compliance hardening. Money-writes GATED (D19);
   products/AR/omniscience GATED (D20).

## Gating open questions (need the founder — see discussions/README.md)
O1 ecosystem scope · O2 dogfood vs sell-first · O4 pace/ownership of the build · O5 YC timing · O7
co-founder / finance-domain-expert gap.
