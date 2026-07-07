# STATE — where the project is right now (canonical; single source for "current state")

> The one place for current status. Update this at the end of every working session (it is the
> single-writer control surface; the narrative history lives in [`AUDIT_LOG.md`](AUDIT_LOG.md)).
>
> **Last updated:** 2026-07-07 (session T24). Branch **`feat/agentic-platform`** (pushed to origin =
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
  - **Totals:** `nx test ai-core` = **154/154** (19 suites) · `nx test db` = **69/69** (8 suites, live
    pgvector/RLS/Chargebee) · `nx test access-control` = **104/104** (9 suites); strict `tsc --noEmit` clean;
    expense + user-management apps typecheck.

## In progress
- (nothing executing right now.)

## Next (recommended order)
1. **ABAC Phase 1** (per `docs/strategy/abac-generalization.md` §5) — `dbPolicies(action)` + the shared-DB
   `PolicyReadPort` implementation + bootstrap registration in expense; wire `combinePolicies(db, amountCap)`
   on the two expense approve routes behind a flag; seed a resource-only deny policy; then **Phase 2 = the PIP**
   (populate `principal.attributes.teamIds`/`approvalLimit` — the load-bearing prerequisite).
2. **Live end-to-end demo** — drop `AEGIS_LLM_BASE_URL`/`AEGIS_LLM_API_KEY` (or `AEGIS_LLM_PROVIDERS`) →
   the multi-LLM gateway lights up; run the `/_ai/act` supervised flow + agent memory against a live
   `expense`, or the MCP stdio server into Claude Desktop. **Blocked on the founder** (gateway key). Also
   founder-side: a real embedding provider key upgrades app-brain recall from lexical to semantic.
3. **Memory-in-anger** — run the self-audit capability on real seeded data, index its findings via
   `indexAuditProposal`, and exercise post-turn extraction end-to-end with the live gateway.
4. Generative-UI **renderer** (web/Unity) + **voice**; enterprise/compliance hardening.
5. Keep **fully-autonomous (no-human) money writes GATED** per D19; **products/AR/omniscience GATED** per D20.

## Gating open questions (need the founder — see discussions/README.md)
O1 ecosystem scope · O2 dogfood vs sell-first · O4 pace/ownership of the build · O5 YC timing · O7
co-founder / finance-domain-expert gap.
