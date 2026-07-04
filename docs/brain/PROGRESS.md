# PROGRESS — the standing briefing (read this each morning)

> **What this is:** the single narrative record of *everything* — what we imagined and discussed since day
> one, what is actually implemented, what is left, and what is in the pipeline. Read the **Briefing** for
> "what happened yesterday / what to do today"; read the **Ledger** for every detail. Updated every
> working session.
>
> **Companion docs:** vision master = [`/CONTEXT.md`](../../CONTEXT.md) · terse session log =
> [`AUDIT_LOG.md`](AUDIT_LOG.md) (T1–T…) · current status = [`STATE.md`](STATE.md) · where-to-look =
> [`RESOLVER.md`](RESOLVER.md) · decisions = [`discussions/README.md`](discussions/README.md) (D1–D20,
> O1–O8) · the safe build order = [`../strategy/red-team-consolidated.md`](../strategy/red-team-consolidated.md).
>
> **Last updated:** 2026-07-02 (end of session T21).

---

## ☀️ Briefing

### Where we are, in one paragraph
We spent the design phase (T1–T13) turning Aegis from a built ~46k-LOC access-control platform into a
fully-designed **agentic-first, modular, governance-native platform**, with all ten strategy docs written
AND adversarially red-teamed. Since T14 we've been **building the agentic layer for real**, strictly inside
the red-team's "safe first slice": everything is **read-only / propose-only** — the agent can discover and
*call governed tools*, and *propose* dangerous actions, but **cannot autonomously write** to money/
irreversible things. As of T21 the whole governed loop works and is tested (**103/103 ai-core tests**), the **D19 safety gate
is complete** (`executeSupervisedWrite` composes AUTHORIZATION × DANGER × VERIFIABILITY — a supervised
write executes only when the ceremony is satisfied AND the independent verifier passes, and a test proves
the unsafe path never reaches execution), and it is now wrapped in a **running two-step propose→confirm
flow** (broker + `expense` `/_ai/act` endpoints; typecheck-verified, needs infra to run live). Also shipped:
conversation/session memory, generative UI-as-data, and the registry drift-gate. **Fully-autonomous
(no-human) writes on money/irreversible stay off by design** (the ceremony requires human evidence).

### What we did last (T21) — fanned out the remaining safe-slice builds (4 in parallel)
- **Supervised action broker** (`src/execution/supervised-action-broker.ts`) + `expense` `/_ai/act` +
  `/_ai/act/:id/confirm` endpoints — the **running two-step flow** over `executeSupervisedWrite`: `propose`
  gates + persists a pending action (surfacing the ceremony), `confirm` executes only once the ceremony +
  verifier pass. This makes the D19 mechanism a real flow (the endpoint is typecheck-verified; needs infra to run live).
- **Conversation/session memory** (`src/memory/`) — `ConversationStore` + `runConversation` wrapper,
  isolation-in-the-key (per tenant+session).
- **Generative UI** (`src/ui/`) — A2UI-style UI-as-data: `renderTurn` maps turns → declarative components
  (incl. an **approval card** for `needs_ceremony`); `toolInputForm` derives a form from a tool's schema. No executable code.
- **Registry drift-gate** (`src/tool-registry/registry-validation.ts`) — the `CapabilityManifest.Validate()`
  analog: a module can't ship a tool lacking a real description / authz binding / (for writes) a risk tier.
- Plus (me): wired `deriveDangerFacts` to prefer a tool's explicit `riskTier`. **103/103 ai-core tests.**

### In flight right now
- (nothing executing — T21 integrated and verified.)

### What to do next
- **Live end-to-end demo** with a real LLM gateway — *blocked on you*: `AEGIS_LLM_BASE_URL` +
  `AEGIS_LLM_API_KEY` (LiteLLM/OpenAI/OpenRouter) and/or the Docker stack up; OR run the MCP stdio server
  into Claude Desktop. (Also: run the `/_ai/act` flow against a live `expense` to exercise supervised-write end-to-end.)
- **The module manifest + Entitlement Service** — the pay-per-module spine (Chargebee; reuse plutus
  dual-ledger). Large; needs DB + touches **O1** (ecosystem scope) — wants your decision + a focused build.
- The app/runtime **second brain** (per-tenant knowledge, pgvector, RLS-scoped) + self-knowledge RAG (needs DB).
- A first **autonomous capability** (self-audit / reconciliation) — propose-only, gated by verifier + human sample.
- Decision-gated: voice, generative-UI *renderer* (web/Unity), omniscience, AR, products.
- Still gated: **no fully-autonomous (no-human) money writes** — supervised writes require the human ceremony by design.

### Decisions still needing you (from discussions/README.md)
**O1** ecosystem scope (first-party vs marketplace) · **O2** dogfood-at-SiteRecon vs sell-first · **O5** YC
timing · **O7** co-founder / finance-domain-expert gap. (**O4** "when to build" is effectively answered — we
are building the safe slice.)

---

## 🧱 Implementation ledger — what is REAL (built + tested)

Everything below is committed code, green under `nx test ai-core` (103/103 across 15 suites at T21) +
strict typecheck, with the 147 substrate lib tests unaffected. All within the **read-only / propose /
human-supervised** safe slice (no fully-autonomous money writes).

| Capability | Where | Status |
|---|---|---|
| **Access-control substrate** (RLS tenant isolation, Casbin PEP/PDP/PAP + runtime grants, hash-chained audit, approvals engine, workflow engine, Kafka events+outbox, connectors, per-tenant entitlement flags) | `apps/*`, `libs/*` (~46k LOC) | **Built pre-T1** (`SPEC.md` authoritative) |
| **Route metadata stamping** — `authorize()`/`validate()` stamp Permission + Joi schema | `libs/service-core/src/bootstrap/route-metadata.ts` | ✅ T14 |
| **Tool registry generator** — authz-bound, self-describing tools from the live router (self-sustaining) | `libs/ai-core/src/tool-registry/generate-tool-registry.ts` | ✅ T14 |
| **Joi→JSON-Schema** converter (dependency-free) | `libs/ai-core/src/tool-registry/joi-to-json-schema.ts` | ✅ T14 |
| **Per-principal tool filter** (entitlement × permission, "filter before the model sees it") | `libs/ai-core/src/tool-registry/filter-tools.ts` | ✅ T15 |
| **Tool-server** — `listToolsForPrincipal`, `invokeTool` (executes via the SAME guarded route), `toMcpToolDefinition` | `libs/ai-core/src/tool-server/tool-server.ts` | ✅ T16 |
| **`GET /_ai/tools`** capability-catalog endpoint on a service | `apps/expense/src/controllers/ai-tools.controller.ts` | ✅ T16 |
| **MCP transport** — `createAegisMcpToolServer()` (tools/list + tools/call → invokeTool, governed) | `libs/ai-core/src/mcp/mcp-tool-server.ts` | ✅ T17 |
| **Agent orchestrator + LLM gateway** — `LlmClient` seam, `OpenAiCompatibleLlmClient` (LiteLLM/OpenAI), `runAgentTurn` (filtered tools only; refuses off-offer) | `libs/ai-core/src/orchestrator/*` | ✅ T17 |
| **Danger/HITL layer** — deterministic `classifyDanger`, `decideCeremony` (graduated ladder; single-human → out-of-band, never self-approval), `ApprovalGateway` seam | `libs/ai-core/src/danger/*` | ✅ T18 |
| **Danger gate ENFORCED** in the orchestrator (`deriveDangerFacts` → `needs_ceremony`, write never auto-run) | `libs/ai-core/src/orchestrator/{derive-danger-facts,agent-orchestrator}.ts` | ✅ T19 |
| **Independent verifier / hardened Trust Rule** — `assertTrustForAutonomousWrite` (deterministic ∧ different-model dual-control; sampled-alone forbidden) | `libs/ai-core/src/verification/*` | ✅ T19 |
| **MCP stdio server** (Claude Desktop-driveable) + docs | `scripts/mcp/aegis-mcp-stdio.ts`, `AEGIS_MCP_README.md` | ✅ T19 |
| **Runnable offline demo** of the whole governed loop | `scripts/demo/agent-loop-demo.ts` | ✅ T16/T19 |
| **Supervised-write path** — `executeSupervisedWrite` (ceremony ∧ verifier → execute; unsafe path blocked, tested) + MCP `tools/call` danger gating | `libs/ai-core/src/execution/supervised-write.ts` | ✅ T20 |
| **Manifest tool descriptions** — `improveDescription` + `ToolManifest` override (description/riskTier/tags) | `libs/ai-core/src/tool-registry/tool-manifest.ts` | ✅ T20 |
| **Supervised action broker** — propose→confirm flow over `executeSupervisedWrite` + `expense` `/_ai/act` + `/_ai/act/:id/confirm` | `libs/ai-core/src/execution/supervised-action-broker.ts`, `apps/expense/.../ai-act.controller.ts` | ✅ T21 |
| **Conversation/session memory** — `ConversationStore` + `runConversation`, isolation-in-the-key | `libs/ai-core/src/memory/*` | ✅ T21 |
| **Generative UI (A2UI-shaped)** — `renderTurn` (incl. approval card) + `toolInputForm` (UI-as-data) | `libs/ai-core/src/ui/*` | ✅ T21 |
| **Registry drift-gate** — `validateToolRegistry` (CapabilityManifest.Validate analog) | `libs/ai-core/src/tool-registry/registry-validation.ts` | ✅ T21 |
| **`deriveDangerFacts` prefers explicit `riskTier`** | `libs/ai-core/src/orchestrator/derive-danger-facts.ts` | ✅ T21 |

---

## 🌌 Imagined → status (the vision, and how much is real)

Everything we've discussed/designed, and where it stands. Detail for each is in `docs/strategy/`.

| Imagined / discussed | Designed? | Built? | Notes |
|---|---|:--:|:--:|
| Sell the governance substrate (not the apps) | ✅ | — | positioning (T1) |
| Modular, **pay-per-module**, multi-industry | ✅ modular-platform-plan.md | ✗ | module manifest + Entitlement Service = the big net-new build |
| **Agentic-first** (do everything by talking/typing) | ✅ agentic-platform-design.md | ◑ | tool loop + orchestrator built; voice/generative-UI/conversation-memory not |
| **AI-native from the root** (every module) | ✅ ai-native-core.md | ◑ | tools auto-generate per route (the mechanism); manifest descriptions in flight |
| **No sales/support/CS + minimal ops** (NoOps/AIOps) | ✅ | ✗ | design only |
| **Self-sustaining / auto-growing** | ✅ | ✅ | proven: a new guarded route becomes an agent tool with zero wiring |
| Autonomous + **verifiable** AI capabilities | ✅ agentic-operations.md | ◑ | verifier built; broad autonomous capabilities not; nothing writes autonomously |
| **RBAC/ABAC per role**, agentic enforcement | ✅ | ✅ | every tool call hits the PEP; tools filtered per principal |
| **Danger confirmation even with permission** | ✅ | ✅ | classifier + ceremonies built & enforced in the loop |
| End-to-end operational flows (onboarding→modules→payments→support) | ✅ | ✗ | design only |
| **Omniscient** debug/data agent | ✅ platform-omniscience.md | ✗ | design only (diagnostic plane is ~90% off-the-shelf when built) |
| **Second brain** (dev + app) | ✅ knowledge-brain.md | ◑ | dev brain = this `docs/brain/`; app/runtime brain not built |
| Stack sufficiency (TS spine + Python sidecars) | ✅ stack-sufficiency.md | ✅(decision) | verdict locked; no sidecars built yet (none needed yet) |
| **AR management ecosystem** (Wayfinder) | ✅ ecosystem-ar-protocol.md | ✗ | research; net-new = A2UI→Unity renderer |
| **Agentify** legacy + **AI policing** products | ✅ agentify-and-policing.md | ✗ | GO/NO-GO gated (D20) — do not build without an LOI |
| MCP transport | ✅ | ✅ | stdio server + in-process server both built |
| Conversation/session memory, voice, generative UI | ✅ | ✗ | pipeline |
| Live real-LLM demo | ✅ (runner ready) | ◑ | offline works; live needs a gateway key/infra (blocked on founder) |

Legend: ✅ done · ◑ partial · ✗ not yet.

---

## 🚧 Left to build / pipeline (ordered)

1. **Live real-LLM demo** (blocked on you: gateway URL + key, or Claude Desktop + the MCP stdio server) +
   run the `/_ai/act` supervised flow against a live `expense` (needs the Docker stack up).
2. **The module manifest + Entitlement Service** — the pay-per-module spine (Chargebee; reuse plutus
   dual-ledger). Large; needs DB; touches **O1** (ecosystem scope) — wants your decision + a focused build.
3. The app/runtime **"second brain"** (per-tenant knowledge, pgvector, RLS-scoped) + self-knowledge RAG (needs DB).
4. A first **autonomous capability** (self-audit / reconciliation) — propose-only, gated by verifier + human sample.
5. **Generative-UI renderer** (web/Unity) — the UI-as-data layer is done (T21); the renderer consumes it. Plus **voice** (emporio pipeline + LiveKit/Realtime).
6. Enterprise/compliance + autonomous-ops hardening (SOC2 track, GitOps/AIOps).
7. **Gated behind decisions:** omniscience layer, AR ecosystem, Agentify/Policing products.

*Done since this list was first written (T14–T21): the tool-registry generator, filter, tool-server,
MCP transport + stdio server, orchestrator + LLM gateway, danger layer (enforced), verifier, supervised-
write path + running broker/endpoint, conversation memory, generative UI-as-data, registry drift-gate,
riskTier wiring, manifest descriptions.*

**Hard gates (do NOT cross without the work + a passing "unsafe-path-blocked" test):** fully-autonomous
money/irreversible writes (D19 — needs the supervised path proven + hardened); the products/AR (D20).

---

## 📌 Ground truth reminders (so no agent drifts)
- **Nothing writes autonomously to money/irreversible.** Everything shipped is read-only/propose-only.
- **The agent reasons; the governed core acts.** Every tool call hits authenticate→authorize(PEP)→RLS→audit.
- **No customers, no revenue yet.** The biggest non-code gap (per the YC red-team) is one real design-partner.
- Update protocol: append to `AUDIT_LOG.md`, refresh `STATE.md`, update this `PROGRESS.md` briefing + ledger,
  record decisions in `discussions/`, keep `CONTEXT.md` consistent.
