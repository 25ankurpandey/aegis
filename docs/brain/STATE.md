# STATE — where the project is right now (canonical; single source for "current state")

> The one place for current status. Update this at the end of every working session (it is the
> single-writer control surface; the narrative history lives in [`AUDIT_LOG.md`](AUDIT_LOG.md)).
>
> **Last updated:** 2026-07-02 (session T22). Branch **`feat/agentic-platform`**; live Postgres @ 55432 + Redis @ 6380 up.

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
  - **Totals:** `nx test ai-core` = **134/134** (17 suites) + `nx test db` = **21/21** (incl. live-DB entitlement); strict typechecks clean; expense app typechecks.

## In progress
- (nothing executing right now.)

## Next (recommended order)
1. **pgvector app-brain** — stand up a pgvector Postgres (swap compose image / one-off container), then the
   per-tenant knowledge store + self-knowledge RAG (RLS-scoped). Infra now available.
2. A first **autonomous capability** (self-audit / reconciliation) — propose-only, gated by verifier + human sample.
3. **Entitlement completion** — Chargebee webhook ingestion → materialize into `tenant_modules` (core repo
   + service done in T22); wire the entitlement predicate into the live tool filter. Touches **O1**.
4. **Live end-to-end demo** — drop `AEGIS_LLM_BASE_URL`/`AEGIS_LLM_API_KEY` (or `AEGIS_LLM_PROVIDERS`) →
   the multi-LLM gateway lights up; run the `/_ai/act` supervised flow against a live `expense`, or the
   MCP stdio server into Claude Desktop. **Blocked on the founder** (gateway key).
5. Generative-UI **renderer** (web/Unity) + **voice**; enterprise/compliance hardening.
6. Keep **fully-autonomous (no-human) money writes GATED** per D19; **products/AR/omniscience GATED** per D20.

## Gating open questions (need the founder — see discussions/README.md)
O1 ecosystem scope · O2 dogfood vs sell-first · O4 pace/ownership of the build · O5 YC timing · O7
co-founder / finance-domain-expert gap.
