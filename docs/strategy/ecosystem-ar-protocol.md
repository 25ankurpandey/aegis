# Track 4 — The AR Management Ecosystem Protocol (AEP)

> **The question:** the SaaS platforms run near-fully autonomously; the CEO/maintainer manages
> EVERYTHING from an AR headset (the existing Wayfinder Quest app) that generates UI in real time —
> metrics, logs, decisions, approvals — talks to the platform AI, and federates AI-to-AI across every
> company the person runs. **Is there an existing protocol for this, or do we define one?**
>
> **The answer (short):** there is **no single existing protocol**, but the stack now exists in
> pieces and is converging fast: **A2A** (inter-agent tasks, v1.0 stable, Linux Foundation) +
> **A2UI** (declarative UI-as-data, Google, Apache-2.0) + **AG-UI** (agent↔frontend event stream)
> + **MCP** (tool layer, already Aegis's choice). Roughly **80% of the wire protocol already
> exists**; the genuinely net-new pieces are (1) an **A2UI → Unity/XR renderer** (no one has built
> one; the closest is an experimental Three.js renderer), (2) a **personal "ecosystem hub"** that
> federates N company orchestrators for one human, and (3) **governance/step-up semantics carried
> across the agent boundary** (risk tier, approval round-trip, audit refs) — which is exactly the
> Aegis substrate, so we define it. **Do not invent a new wire protocol. Define a PROFILE** — the
> way OpenID Connect is a profile of OAuth 2.0 — that binds A2A + A2UI + Aegis governance + device
> identity. We name it the **Aegis Ecosystem Protocol (AEP)**.
>
> Status: research-stage design. No implementation yet. Companion docs:
> `agentic-platform-design.md` (already selects MCP + A2UI + AG-UI at §181/§C.5, AG-UI=MIT,
> A2UI=Assess), `ai-native-core.md` §0.5 (minimal viable contract; four hard authority rules) and
> Facet 7 (`AegisSurface`, `requiresInput` ⇒ `@aegis/approvals`).

---

## 1. Research findings (internet-first, with sources)

### 1.1 Agent-to-agent protocols

**A2A (Agent2Agent) — the winner for inter-agent transport.**
- Created by Google (April 2025), donated to the **Linux Foundation** (June 2025). As of the
  **April 2026 update: v1.0 stable, signed Agent Cards, the AP2 (Agent Payments Protocol)
  extension, ~22K GitHub stars, 5-language SDK ecosystem, 150+ production orgs** including
  Microsoft, AWS, Salesforce, SAP, ServiceNow, Workday, IBM; GA inside Microsoft Copilot Studio,
  Azure AI Foundry, and Amazon Bedrock AgentCore.
  [rapidclaw.dev A2A 2026 guide](https://rapidclaw.dev/blog/a2a-protocol-complete-guide-2026),
  [github.com/a2aproject/A2A](https://github.com/a2aproject/A2A),
  [IBM overview](https://www.ibm.com/think/topics/agent2agent-protocol).
- Mechanics that map 1:1 onto our needs
  ([spec](https://a2a-protocol.org/latest/specification/)):
  - **Agent Card** published at `/.well-known/agent-card.json` — declares skills, MIME types,
    transports, **security schemes**; v1.0 adds **signed cards** (integrity for the hub's company
    registry).
  - **JSON-RPC 2.0 + SSE streaming**; an **eight-state Task lifecycle**: `submitted, working,
    input_required, auth_required, completed, failed, canceled, rejected`.
  - **`input_required`** = the protocol-native hook for human-in-the-loop → our approval
    round-trip. **`auth_required`** = the protocol-native hook for **step-up auth** — the agent
    "delegates fulfillment of authorization to the client," which is precisely Tier-4 step-up
    from the headset.
  - **The founder's four gates map cleanly onto this native lifecycle**, which is why AEP is a
    *profile* and not a fork: AUTHORIZATION → the PDP check that gates every tool call *inside*
    the orchestrator (invisible on the wire — the agent card only advertises capabilities the
    principal may see); DANGER → the risk tier carried in `aep:governance`, which decides whether
    a task can `complete` directly or must transit `input_required`/`auth_required`; AUTONOMY →
    whether the orchestrator is permitted to act without a human turn at all (else it parks in
    `input_required`); VERIFIABILITY → the `auditRef` + `surfaceHash` stamped on the terminal
    `completed` artifact. A2A gives us the state machine; Aegis supplies the semantics for each
    transition.
  - **Push notifications**: server-initiated HTTP POST to a client webhook for long-running /
    disconnected scenarios — the mechanism for "pending approval waiting when the CEO puts the
    headset on."
    [spec §push](https://a2a-protocol.org/latest/specification/),
    [W&B A2A walkthrough](https://wandb.ai/byyoung3/Generative-AI/reports/How-the-Agent2Agent-A2A-protocol-enables-seamless-AI-agent-collaboration--VmlldzoxMjQwMjkwNg).
  - **Extensions**: cards and messages carry declared extension URIs — the sanctioned place for
    AEP's governance block (§3.4) rather than forking the protocol.
- **AP2** (payments extension) is worth tracking: it is the A2A ecosystem's own admission that
  money-moving actions need extra ceremony — validates our Tier-4 stance.

**ACP / AGNTCY — infrastructure layer, not a competitor.**
- Cisco (with LangChain, Galileo) open-sourced AGNTCY March 2025; donated to the **Linux
  Foundation July 2025**; 65+ supporting companies; formative members include Google Cloud,
  Dell, Oracle, Red Hat.
  [The Register](https://www.theregister.com/2025/07/30/agntcy_lf_donation/),
  [LF press release](https://www.linuxfoundation.org/press/linux-foundation-welcomes-the-agntcy-project-to-standardize-open-multi-agent-system-infrastructure-and-break-down-ai-agent-silos).
- Components: **OASF** (Open Agent Schema Framework) discovery, cryptographically verifiable
  **agent identity**, **SLIM** messaging, observability. **ACP** (Agent Connect Protocol) is a
  REST/OpenAPI invoke-and-configure spec ([spec.acp.agntcy.org](https://spec.acp.agntcy.org/)).
- Explicitly **interoperable with A2A and MCP** — positioned as the "Internet of Agents"
  substrate (directory/identity/observability) *around* A2A, not instead of it.
- **Verdict:** not needed for a one-person multi-company ecosystem (the hub IS the directory).
  Revisit AGNTCY identity/OASF if AEP ever federates across *organizations you don't own*.

**MCP** stays what it already is in Aegis and Wayfinder: the **tool layer inside** each company's
orchestrator (and inside the headset for local device tools). MCP is not an inter-agent protocol;
A2A's own docs frame the split the same way (A2A = agent↔agent, MCP = agent↔tools/data).
[DataCamp A2A vs MCP](https://www.datacamp.com/blog/a2a-agent2agent).

### 1.2 Generative-UI protocols

**A2UI (Agent-to-User Interface) — the UI-as-data payload. Adopt.**
- Google open project, announced Dec 2025; **Apache-2.0**;
  [github.com/google/A2UI](https://github.com/google/A2UI) (~15.6k stars), spec hub
  [a2ui.org](https://a2ui.org/). **v0.9.1 is the production/stable line; v1.0 is a release
  candidate** (pre-1.0 churn risk, §5).
  [Google Developers Blog announcement](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/),
  [A2UI v0.9 post](https://developers.googleblog.com/a2ui-v0-9-generative-ui/).
- **Exactly the security model Aegis already mandated** (modular-plan §K, ai-native-core Facet 7):
  the agent outputs **declarative JSON, never executable code**; the client holds a **catalog of
  trusted, pre-approved components** and the agent can only compose from that catalog — "no UI
  injection attacks." Flat, streaming-friendly **adjacency-list** structure: **surfaces**
  (containers) + **components** + a **data model** with data binding; progressive rendering as
  the JSON streams. Google's spec ships a base set of **~18 primitives** (`Card`, `Button`,
  `TextField`, etc.); everything above that is a client-advertised **custom-component** set — the
  exact seam AEP uses for `aep.xr.v1` (§3.5).
- **The single most important fact for XR:** A2UI *deliberately separates UI **structure** from UI
  **implementation*** — the agent sends "a description of the component tree," which each client maps
  to **native widgets: web components, Flutter widgets, React components, or SwiftUI views** (per
  Google's launch post). That is the property no other GenUI protocol has: **the payload is
  renderer-agnostic and non-executable, so mapping a component tree onto Unity prefabs is a
  first-class use of the spec, not a hack.** MCP Apps / Apps SDK ship *HTML*; only A2UI ships a
  *tree*.
- Message operations: `createSurface`, `updateComponents`, `dataModelUpdate`, and `userAction`
  (client → agent) — a full round-trip loop.
- **Transport-agnostic by design: "A2A is a transport mechanism for communicating A2UI
  messages"** — i.e., A2UI payloads ride inside A2A task artifacts/messages. AG-UI is the other
  sanctioned transport. This composability is why AEP can be a thin profile.
- **Renderers today:** Lit + Angular (stable), React (Q1 2026), **Flutter via GenUI SDK**
  ([github.com/flutter/genui](https://github.com/flutter/genui)); community: Jetpack Compose
  ([lmee/A2UI-Android](https://github.com/lmee/A2UI-Android), 20+ components), SwiftUI, React
  Native, AGenUI (shared-C++ cross-platform), and — the key precedent — an **experimental
  Three.js/WebGL 3D renderer** (`josh-english-2k18/a2ui-3d-renderer`, listed on
  [a2ui.org community renderers](https://a2ui.org/ecosystem/renderers/)).
  **There is NO Unity renderer. That is our net-new piece — and it's a tractable one** (§3.5).
- Oracle announced Open Agent Spec support for A2UI through AG-UI
  ([Oracle blog](https://blogs.oracle.com/ai-and-datascience/announcing-agent-spec-for-a2ui-copilotkit-ag-ui))
  — multi-vendor gravity is forming around exactly this pairing.

**AG-UI (Agent–User Interaction protocol) — the event transport. Adopt where it's free, don't force it.**
- CopilotKit-originated open protocol (MIT; already "Adopt" in agentic-platform-design.md §704).
  Event-based: frontend POSTs the user's prompt/state; agent responds with an **SSE stream of
  ~17 typed events** in five categories (lifecycle, text messages, tool calls, state management,
  special/custom) — e.g. `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`, `STATE_SNAPSHOT`,
  `STATE_DELTA` (event-sourced diffs with conflict resolution).
  [docs.ag-ui.com](https://docs.ag-ui.com/introduction),
  [17 event types](https://www.copilotkit.ai/blog/master-the-17-ag-ui-event-types-for-building-agents-the-right-way).
- Supports **frontend tool calls** (agent asks the *client* to execute something — how the
  orchestrator asks the headset to place a panel, play a chime, start nav) and both **static**
  and **declarative generative UI** (the declarative flavor is A2UI).
- SDKs: TS/Python mature; Kotlin, Go, Dart, Java, Rust supported; **.NET in progress**
  ([docs](https://docs.ag-ui.com/introduction)) — relevant because Unity is C#. Microsoft Agent
  Framework ships an AG-UI integration
  ([MS Learn](https://learn.microsoft.com/en-us/agent-framework/integrations/ag-ui/)).
- **Honest assessment for the headset leg:** A2A's own SSE task streaming already delivers
  status/artifact events end-to-end. Running AG-UI *as well* between hub and headset duplicates
  semantics. Decision (§3.3): **A2A streaming is the hub↔headset transport; AG-UI is the
  browser-frontend transport for Aegis's web surfaces and an optional adapter** — we keep event
  *names* aligned with AG-UI categories so a web client is trivially supportable.

**MCP Apps (SEP-1865) / MCP-UI / OpenAI Apps SDK — wrong fit for XR. Reject for the headset.**
- MCP Apps is now the official MCP extension for embedded interactive UI; MCP-UI (community) and
  OpenAI's Apps SDK merged design lineages into it (Nov 2025); ChatGPT supports MCP Apps.
  [MCP blog](https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/),
  [OpenAI Apps SDK](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt),
  [mcpui.dev](https://mcpui.dev/guide/apps-sdk).
- Architecture is **HTML in a sandboxed iframe + `ui/*` JSON-RPC over postMessage**. A Quest
  Unity app has no iframe; embedding a WebView per panel is heavyweight, unstylable in 3D, and
  reintroduces executable-code UI (the thing modular-plan §K forbids). **A2UI's
  data-not-code model is the only one of the three that maps to native XR components.** MCP Apps
  remains relevant only for Aegis modules that ship chat-host UIs (ChatGPT/Claude surface) —
  out of scope here.

### 1.3 XR precedents — who has built anything like this?

- **Unity + MCP:** all major integrations are *editor-automation* bridges
  ([CoplayDev/unity-mcp](https://github.com/CoplayDev/unity-mcp),
  [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity), Unity's own
  [Unity MCP](https://unity.com/blog/unity-ai-mcp-how-to-get-started)).
  **[IvanMurzak/Unity-MCP](https://github.com/IvanMurzak/Unity-MCP) is the standout: it supports
  RUNTIME embedding in a built game** ("any C# method may be turned into a tool by a single
  line") — direct prior art for hosting an MCP server *inside* Wayfinder on-device, exactly the
  follow-on Wayfinder's Feature-22 doc anticipates ("full external MCP server transport is
  future work; the in-app tool catalog is the contract it will expose").
- **Spatial BI/analytics products exist but are visualization-first, not command-and-control:**
  Immersion Analytics (injects 3D/AR viz into Tableau et al., runs on Quest/Vision Pro)
  ([immersionanalytics.com](https://www.immersionanalytics.com/solutions/business-intelligence/)),
  Flow Immersive, BadVR, Virtualitics, DataView VR
  ([TechTarget survey](https://www.techtarget.com/searchbusinessanalytics/tip/AR-and-VR-data-visualizations-offer-promising-future)).
  None execute governed actions; none are agent-driven; all render *pre-authored* dashboards.
- **Virtual NOCs** put Grafana walls in VR and are now adding "AI NOC agents that monitor
  dashboards and suggest remediation"
  ([Peak AI Design virtual NOC](https://www.peakaidesign.com/blog/virtual-network-operations-center-noc),
  [Nokia metaverse NOC](https://www.nokia.com/blog/network-operations-in-the-metaverse/),
  [Proscaler AR/VR monitoring](https://www.proscaler.de/post/on-the-way-to-ar-vr-assisted-monitoring)) —
  read-only, screen-mirroring, no approvals, no protocol.
- **XR fleet MDM (ManageXR, ArborXR)** manages *headsets from the web*
  ([managexr.com](https://www.managexr.com/), [arborxr.com](https://arborxr.com/)) — the inverse
  of our direction; irrelevant except as the enrollment/kiosk layer for the CEO's own device.
- **Voice-driven XR assistants are becoming the platform default:** Android XR glasses are
  "designed around Gemini" as the primary interface (I/O 2026, Samsung/Warby Parker), with
  see-what-you-see multimodality
  ([Android XR + Gemini API docs](https://developer.android.com/develop/xr/gemini),
  [Campus Technology](https://campustechnology.com/articles/2026/05/22/google-unveils-android-xr-smart-glasses-powered-by-gemini-ai.aspx));
  Ray-Ban Meta validates audio-first assistants at scale. Google research's **XR Blocks +
  "Vibe Coding XR"** (CHI 2026) generates whole WebXR experiences from natural language and
  introduces an LLM-friendly "Reality Model"
  ([research.google blog](https://research.google/blog/vibe-coding-xr-accelerating-ai-xr-prototyping-with-xr-blocks-and-gemini/),
  [arXiv:2603.24591](https://arxiv.org/html/2603.24591)) — evidence that *generating* spatial UI
  from agent output is the research frontier, but nothing shipping does governed business ops.
- **Conclusion: the composition is novel.** Agent protocols ✅ exist, generative-UI protocols ✅
  exist, spatial dashboards ✅ exist, XR voice assistants ✅ exist — **nobody has connected
  "A2A-federated company agents" to "A2UI-rendered spatial UI" with "governed approvals from the
  headset."** First-mover territory, built almost entirely from adopted parts.

### 1.4 The Wayfinder substrate audit (what we already own)

Paths: Quest app `/Users/ankurpandey/Documents/Wayfinder`, Android companion
`/Users/ankurpandey/Documents/Github/Wayfinder`, autonomy harness
`/Users/ankurpandey/Desktop/wayfinder-autonomy`.

| Existing asset | Where | What it gives AEP |
|---|---|---|
| **TCP JSON frames** `tool_catalog` + `capability_manifest` (typed, versioned, **hashed**) | `Assets/_Wayfinder/Scripts/Voice/VoiceManager.cs` (~L442–502: `ToolCatalogMessage{type:"tool_catalog", tools[]}`, `{type:"capability_manifest", version, hash}`) | A working pattern for **capability propagation with drift-proof hashes** — the same pattern AEP uses for the *surface catalog hash* (§3.5) |
| **`IVoiceToolProvider`** per-module tool contribution | `Scripts/Voice/Mcp/IVoiceToolProvider.cs` | The seam where an `EcosystemVoiceTools` provider registers `ask_company`, `approve`, `show_dashboard` without touching the conductor |
| **`WayfinderToolCatalog` + `ToolSensitivity` tiers + owner-gate** (sensitivity derived from registration, not hand-maintained — "Policy 8") | `Scripts/Voice/Mcp/WayfinderToolCatalog.cs`, `CapabilityManifest.cs` | Local mirror of Aegis risk tiers; the **two-mic owner-gate** is a ready-made *local* pre-filter before remote Tier-4 step-up |
| **`CapabilityManifest.Build()` + `Validate()` CI drift gate**, `capability_check` (Alexa CanFulfillIntent pattern) | `CapabilityManifest.cs` | Grounded "can I do X" answers; the CI gate template AEP extends to renderer/catalog version skew |
| **`show_ai_surface` → `AiSurfaceRequestEvent` → `AiSurfacePresenter`** (Text/Image/BrowserPage kinds, `requires_input`, auto-close), EventBus decoupling, **grabbable panels** (Meta Interaction SDK, 0.3–2.0 m constraint) | `IVoiceToolProvider.cs` L82–114, `Scripts/Voice/UI/AiSurfacePresenter.cs` | **A proto-AG-UI already running in the headset.** `AiSurfaceRequestEvent` generalizes to `SurfaceRequestEvent{A2UIPayload}`; the grabbable panel prefab is the A2UI *surface* container |
| **Voice pipeline**: wake/PTT → STT (Wit.ai / local Whisper + VAD) → LLM intent over live tool catalog (Groq/Gemini/OpenRouter) w/ offline keyword fallback → TTS (local Piper) | `docs/features/22-voice-mcp/README.md`, `VoiceManager.cs` | The entire ask/answer loop, including **on-device STT/TTS (privacy + offline)**, already shipped |
| Threading/EventBus rules, object pooling, phone TCP/UDP link | `docs/architecture/THREADING_AND_EVENTBUS.md` | Network-thread → main-thread marshaling discipline the A2A SSE client must follow |

**Reading:** Wayfinder already implements a *private, single-node* version of every AEP layer —
a tool catalog (mini-MCP), a hashed capability broadcast (mini agent card), a UI-request event
stream (mini-AG-UI), and typed surfaces (mini-A2UI with a 3-component catalog). AEP is the
exercise of swapping each private mini-protocol for its open equivalent without losing the
governance discipline.

---

## 2. Direct answers to the founder's questions

**Q: Is there an existing protocol for AR-native management of an autonomous company ecosystem?**
No. And critically, **you should not create a new wire protocol either.** The three-layer stack
the industry converged on in the last ~14 months — A2A (agent↔agent) / AG-UI (agent↔frontend) /
A2UI (UI-as-data) with MCP underneath (agent↔tools) — covers discovery, task lifecycle,
human-in-the-loop, step-up auth delegation, push notifications, streaming, and injection-safe
generative UI. What does not exist anywhere: (1) an XR/Unity renderer for A2UI; (2) a personal
multi-company federation hub; (3) governance metadata (risk tier, approval id, audit ref)
standardized across the agent boundary. Those are AEP's contributions, expressed as **A2A
extensions + an A2UI catalog + a renderer**, all inside the existing protocols' sanctioned
extension points. Betting on A2A/A2UI also means every future company you build (or acquire, or
merely *use* — 150+ orgs ship A2A) plugs into the same headset for free.

**Q: AI-to-AI communication across an internally connected ecosystem of all companies/apps?**
A2A tasks between the hub agent and each company's governed orchestrator, each publishing a
signed Agent Card. Cross-company queries ("compare Aegis churn to SiteRecon churn") are hub-level
fan-out: the hub's own LLM composes *questions*, never actions — actions are always single-company
tasks that land inside that company's PDP. The core principle survives federation: **the agent
reasons; each governed core acts** — there is no cross-company authority, only cross-company
conversation.

**Q: UI generated in real time in front of the user?**
A2UI streaming (`createSurface` → progressive `updateComponents` → `dataModelUpdate`) rendered by
a Unity catalog renderer (§3.5). The LLM composes layout *from a fixed catalog*; it can never
inject code — the same four-gate discipline, applied to pixels.

---

## 3. The design — Aegis Ecosystem Protocol (AEP) v0.1

### 3.1 Positioning and naming

**AEP is a profile, not a protocol**: a binding of
`A2A v1.0 (transport + lifecycle) × A2UI v0.9/1.0 (UI payload) × Aegis governance semantics
(risk tiers, approvals, audit) × device identity (headset-as-principal)`, plus one net-new
component catalog (`aep.xr.v1`) and one net-new renderer (Unity). Declared via A2A's extension
mechanism: an orchestrator that speaks AEP lists
`https://aegis.dev/ext/aep/v1` in its Agent Card `capabilities.extensions` and tags supported UI
with the A2UI extension URI. Anything that speaks plain A2A still interoperates (text-only).

### 3.2 Topology

```
                    ┌──────────────────────────── THE PERSON ───────────────────────────┐
                    │  Wayfinder Quest app (AR)          Phone companion (Android)      │
                    │  • A2A client (via hub)            • passkey / step-up factor     │
                    │  • AEP Unity renderer (A2UI)       • notification relay fallback  │
                    │  • voice: Whisper→LLM→Piper        • existing TCP/UDP link        │
                    └───────────────▲───────────────────────────▲───────────────────────┘
                                    │ A2A (JSON-RPC+SSE over HTTPS/WSS; device-bound token)
                    ┌───────────────┴───────────────────────────┴───────────────────────┐
                    │            ECOSYSTEM HUB  (personal, self-hosted, TS/Node)        │
                    │  • A2A client of N company orchestrators; company registry of     │
                    │    signed Agent Cards; routing ("Aegis" → card)                   │
                    │  • durable notification inbox (A2A push-notification webhook      │
                    │    receiver) + offline queue for the headset                      │
                    │  • identity broker: exchanges the user's session for short-lived  │
                    │    per-company tokens (OAuth2 token exchange / OBO)               │
                    │  • hub LLM: cross-company AGGREGATION + routing ONLY (no authz,   │
                    │    no action synthesis) — LiteLLM, per-user budget                │
                    └───────▲──────────────────▲──────────────────▲─────────────────────┘
                            │ A2A               │ A2A              │ A2A
                 ┌──────────┴─────┐   ┌─────────┴──────┐   ┌───────┴────────┐
                 │ AEGIS governed │   │ SITERECON      │   │ company N…     │
                 │ orchestrator   │   │ orchestrator   │   │ (anything that │
                 │ (A2A server)   │   │ (A2A server)   │   │ speaks A2A)    │
                 │ agent card +   │   │                │   │                │
                 │ AEP extension  │   │                │   │                │
                 ├────────────────┤   └────────────────┘   └────────────────┘
                 │ inside: LLM at the edge → authz-bound tool registry (route-walk    │
                 │ + Joi + Permission) → Casbin PDP/PEP → RLS Postgres → hash-chained │
                 │ audit ledger → @aegis/approvals → entitlement (Chargebee)          │
                 └─────────────────────────────────────────────────────────────────────┘
```

Key placement decisions:
- **Each company runs ONE A2A server** — its governed orchestrator. Its "skills" in the Agent
  Card are coarse capabilities (`ops.metrics`, `billing.query`, `approvals.manage`,
  `incident.respond`), not the raw tool registry: tools stay behind the orchestrator, filtered
  per-principal *before* any LLM sees them (ai-native-core hard rule #3).
- **The hub is dumb on purpose.** It routes, aggregates, brokers identity, and buffers
  notifications. It holds no company data at rest beyond the inbox, evaluates no policy, and its
  LLM composes summaries and routing decisions only. A compromised hub can *ask* things as the
  user (bounded by the user's own permissions + per-company token scopes + step-up walls); it
  cannot mint authority.
- **The AR app is a *client + renderer*, never an authority.** It renders A2UI, captures voice,
  and signs step-up challenges. All four gates (AUTHORIZATION × DANGER × AUTONOMY ×
  VERIFIABILITY) evaluate inside each company's core — identical to a web session.
- **Multi-role, multi-person for free:** a CFO's headset enrolls as a different principal; the
  same Agent Cards serve them; Casbin decides what each sees. Nothing in AEP is single-user.

### 3.3 Message flows

**(a) Ask flow** — "what's Aegis MRR this week?"
1. Wake word → Whisper STT on-device → transcript.
2. Headset LLM-router (existing `VoiceManager` intent stage, extended with an
   `EcosystemVoiceTools` provider) classifies: *local device intent* (nav, layers — stays
   on-device) vs *ecosystem intent* → `message/send` to the hub with the transcript + AEP context
   block (`activeSurfaces[]`, gaze target id — for deixis, see (c)).
3. Hub resolves the company from the utterance + registry ("Aegis" → agent card), performs token
   exchange, opens an A2A task with `message/stream` (SSE).
4. Aegis orchestrator: LLM plans → calls authz-bound tools (PDP-checked, RLS-scoped, entitlement
   -filtered) → composes an **A2UI payload** (from the `aep.xr.v1` catalog) + a spoken summary
   string as task artifacts. Every tool call lands in the audit ledger with
   permissions-at-time-of-action, tagged `channel: "ar", device: <deviceId>`.
5. SSE events stream through the hub to the headset; the renderer progressively materializes the
   panel (streamed A2UI = user watches the dashboard assemble); Piper speaks the summary.

**(b) Notification/push flow** — approval arrives while headset is off.
Orchestrator (task in `input_required`) fires an A2A **push notification** to the hub's webhook →
hub persists to the durable inbox → if a headset session is live, forward on the WSS channel;
else deliver on next connect (+ optional phone-app mirror). Donning the headset = one
`inbox/sync` call; pending approval cards render as a spatial queue.

**(c) Approval round-trip with Tier-4 step-up FROM AR** — the crown-jewel flow:
1. Approval task sits in `input_required` with an artifact: A2UI `ApprovalCard` containing the
   **echoed concrete referent** — record id, human summary, amount, counterparty, risk tier,
   `approvalId`, and the `aep:governance` block (§3.4). The card is *data from the core*, not
   LLM prose: deictic resolution ("approve *this*") is displayed and **re-validated server-side
   against the actual record id** (ai-native-core hard rule #2).
2. User says "approve" while gazing at the card (gaze/controller target id disambiguates when
   multiple cards float — the headset sends `surfaceId + componentId + userAction`, never a
   free-text guess).
3. For Tier ≤ 2 with a fresh session: `userAction{action:"approve", approvalId}` → hub →
   orchestrator → `@aegis/approvals` (maker-checker/SoD checks the approver ≠ maker) → done.
4. For **Tier 4 / danger**: orchestrator transitions the task to **`auth_required`** with an
   `aep:stepUp` challenge (nonce, expiry ≤ 60 s, required factor). Headset displays the challenge
   *inside* the ApprovalCard and triggers the step-up factor: **passkey confirmation on the
   paired phone** (primary — Quest has no per-app biometric API, §5) or in-headset PIN on a
   randomized spatial keypad (fallback). The signed assertion returns via
   `message/send{stepUpResponse}`; the PDP verifies signature + nonce + factor freshness, then
   executes. Voice alone is NEVER a Tier-4 factor.
5. Result artifact streams back (updated card → "Approved ✓, ledger #8412"), audit ledger row
   links `approvalId + deviceId + stepUpFactor + surfaceHash` — the approval is replayable:
   *what the human saw* (the A2UI payload hash) is part of the evidence chain. This closes
   VERIFIABILITY for AR: we can prove the approver was shown the amount they approved.

**(d) Cross-company aggregate** — "how are all my companies doing?"
Hub fans out read-only `ops.metrics` tasks to every registered card in parallel, waits/streams,
hub LLM composes ONE combined A2UI dashboard (multi-surface: one panel per company arced around
the user, `aep:xr` placement hints). Failures degrade per-panel ("SiteRecon: unreachable"),
never block the rest.

### 3.4 AEP extension blocks (the profile's actual spec surface)

**Agent Card extension** (declared in `capabilities.extensions`):
```jsonc
{
  "uri": "https://aegis.dev/ext/aep/v1",
  "params": {
    "governance": true,                    // emits aep:governance blocks
    "uiCatalogs": ["a2ui.core.v0.9", "aep.xr.v1"],
    "stepUpFactors": ["phone-passkey", "headset-pin"],
    "riskTiers": [1, 2, 3, 4]
  }
}
```

**`aep:governance`** — attached (as A2A message/artifact `metadata`) to every task state change
and every actionable artifact:
```jsonc
{
  "riskTier": 4,
  "approvalId": "apr_9f3k…",            // present when input_required is an approval
  "auditRef": "led_8412",               // hash-chained ledger row for completed actions
  "permissionsHash": "sha256:…",        // permissions-at-time-of-action snapshot hash
  "recordRefs": [{"type": "invoice", "id": "inv_1183", "display": "Acme $12,400"}],
  "surfaceHash": "sha256:…"             // hash of the exact A2UI payload shown (evidence)
}
```
Rules: produced ONLY by the governed core (never the LLM); the renderer treats it as read-only
provenance; the PDP re-derives everything on execution and ignores any client echo (hard rule #3).

**`aep:xr`** — optional A2UI component/surface annotations (hints, never authority):
```jsonc
{
  "placement": "front|left|right|wrist|world-anchored",
  "priority": "ambient|normal|urgent",   // urgent = spatial chime + brought into FOV
  "scale": "card|panel|wall",
  "ttlSeconds": 120,                     // auto-close (Wayfinder AutoCloseSeconds, generalized)
  "requiresGaze": true                   // approval cards: action valid only while gazed
}
```

**`aep:stepUp`** challenge/response — carried in `auth_required` transitions:
```jsonc
// challenge (core → client)
{ "nonce": "…", "expiresAt": "…", "factor": "phone-passkey", "bind": "apr_9f3k…" }
// response (client → core)
{ "nonce": "…", "assertion": "<webauthn/passkey signature>", "deviceId": "quest_ankur_01" }
```

### 3.5 The A2UI → Unity renderer (`aep.xr.v1`) — the main net-new build

**Design: catalog-of-prefabs, adjacency-list → transform tree, JSON-only.** Mirrors how the
Flutter GenUI and Compose community renderers work
([flutter/genui](https://github.com/flutter/genui), [lmee/A2UI-Android](https://github.com/lmee/A2UI-Android));
study the experimental [Three.js 3D renderer](https://a2ui.org/ecosystem/renderers/) for the
2D-spec-in-3D-space mapping decisions.

- **Surface = grabbable world-space panel** — Wayfinder's existing grabbable panel prefab
  (Interaction SDK hover/pinch, 0.3–2.0 m constraint) becomes the `Surface` container;
  `createSurface` instantiates it via the existing `AiSurfaceRequestEvent` path renamed
  `SurfaceRequestEvent{a2uiPayload}`. Layout inside a panel: UGUI/UI Toolkit runtime layout
  groups (UI Toolkit runtime data binding is now first-class —
  [Unity 6 UI Toolkit](https://unity.com/blog/unity-6-ui-toolkit-updates)).
- **Component catalog v1 (each = one pooled prefab + a `IA2uiComponentView` binder):**
  - Core A2UI parity (cover the ~18 base primitives so any plain-A2UI payload renders): `Card,
    Column, Row, Text, Heading, Image, Button, TextField, Select, Checkbox, RadioGroup, Slider,
    List, Divider, Modal, ProgressBar, Icon, Spacer`. These are pure layout/leaf prefabs — cheap.
  - XR/ops extensions (registered as a custom catalog, exactly the pattern A2UI prescribes —
    "applications register trusted components"): `MetricTile` (big number + delta + spark),
    `LineChart`, `BarChart` (XR-legible: thick strokes, billboarded labels; consider a thin
    wrapper over XCharts (MIT) or hand-rolled mesh charts), `LogStream` (scrolling, tail-follow),
    `StatusGrid` (service health wall), **`ApprovalCard`** (first-class: renders
    `aep:governance` provenance + approve/reject/step-up affordances; the ONLY component whose
    actions can carry `approvalId`), `AgentTrace` (tool-call chain view — renders the audit
    trace of what the agent did), `CompanyBadge`.
  - Fallback rule: unknown component type → render `Text` with the component's `display`/summary
    field; never fail the whole surface (forward-compat with catalog growth).
- **Data model & binding:** A2UI's data model maps to a per-surface
  `Dictionary<string, JsonNode>` + a binding table (path → view). `dataModelUpdate` mutates the
  dictionary and dirty-flags bound views — no re-instantiation; charts animate deltas. This is
  <500 LOC of plumbing; Unity's own runtime bindings can carry the leaf updates.
- **`userAction` return path:** every interactive prefab raises
  `A2uiActionEvent{surfaceId, componentId, action, payloadFromDataModel}` on the EventBus → the
  A2A client sends it as a task message. No client-side interpretation of what an action *means*.
- **Streaming:** parse A2UI's flat JSONL incrementally; instantiate components as their nodes
  complete (the spec is explicitly designed for this — "flat, streaming JSON structure").
- **Security/drift:** the catalog is code-signed into the APK; the renderer advertises
  `uiCatalogs` + a **catalog hash** through the hub (the `capability_manifest` hash-propagation
  pattern, verbatim); orchestrators MUST NOT emit components outside the advertised catalog
  (Promptfoo eval + a hub-side schema validator enforce it); CI: extend
  `CapabilityManifest.Validate()` — every catalog component must have a registered prefab +
  binder or the build fails (the drift gate, applied to UI).
- **Effort estimate (honest):** parser+binder+action plumbing ~1.5–2 wk; 13 core components
  ~1–1.5 wk (mostly prefab work); charts ~1–2 wk (the real work); ApprovalCard+step-up UX ~1 wk.
  **~5–6 focused weeks for one person to a credible v1**, HEAVILY de-risked by the fact that
  panels, grabbing, TTS/STT, event bus, and pooling already exist.

### 3.6 Identity & security — the AR user is a PRINCIPAL

- **Enrollment:** OAuth2 **device authorization grant** (RFC 8628) — headset shows a code, user
  approves on the phone/web; the headset generates a hardware-backed keypair (Android Keystore on
  Quest); the hub registers `deviceId + pubkey` against the principal. Tokens are **sender-
  constrained (DPoP)** to that key — a stolen token is useless off-device.
- **Session model:** short-lived access tokens (≤ 15 min) auto-refreshed while worn;
  **doff detection** (Quest proximity sensor / `OVRManager.HMDUnmounted`) invalidates the session
  immediately — the headset equivalent of walking away from a logged-in terminal. Re-don =
  silent re-auth (device key) for Tier ≤ 1 visibility; first Tier ≥ 2 action forces re-auth.
- **Per-company authority:** the hub exchanges the user session for a **per-company, scope-bound,
  short-lived token** (OAuth token exchange); each orchestrator's PDP sees the same principal it
  would see from the web — RBAC/ABAC/entitlement/RLS identical. AR adds a *channel attribute*
  (`channel=ar`, `device=…`) usable in ABAC (e.g., a tenant policy may cap AR-initiated actions
  at Tier 3).
- **Step-up reality check:** Quest exposes **no per-app biometric API** — unlock patterns/eye
  tracking are OS-level only. Therefore Tier-4 step-up = **passkey ceremony on the paired phone**
  (WebAuthn, phishing-resistant, already in the user's pocket; the Android companion app is the
  natural host) or an in-headset PIN on a **randomized spatial keypad** (shoulder-surf resistant)
  as the lesser fallback. Voiceprint is explicitly rejected as a factor (deepfake trivial;
  Wayfinder's two-mic owner-gate remains a *convenience* pre-filter, not a security factor).
- **The four hard rules, extended one notch for AR:** (5) **what-you-see-is-what-you-sign** —
  the `surfaceHash` of the rendered ApprovalCard enters the audit row; the core only executes if
  the approved `approvalId`'s canonical content matches the hash it issued (defeats a
  compromised hub swapping card contents mid-flight).
- **Prompt injection:** tenant data rendered in panels (invoice memos, log lines) is *data
  model content*, never component structure — A2UI's data/UI separation is itself the
  sanitization boundary; the hub validator rejects payloads where untrusted strings appear in
  component-type or action positions. (This is the ai-native-core §0.5 injection threat model
  meeting its UI layer.)

### 3.7 Voice loop & routing

Reuse Wayfinder's pipeline untouched (wake → Whisper/VAD → intent → Piper). Add one
`IVoiceToolProvider`: `EcosystemVoiceTools` registering `ask_ecosystem(company?, question)`,
`show_dashboard(company)`, `list_pending_approvals()`, `approve(target)` / `reject(target)`
(gaze-disambiguated), `open_company(name)`. The headset LLM does *routing only*; company-side
reasoning happens in each orchestrator (keeps headset prompts tiny + tool-count cap honored,
per ai-native-core §0.5 cost rules). Spoken replies come from the orchestrator's summary
artifact — the headset never re-summarizes governed data with its own LLM (one fewer place to
hallucinate a number the user will act on).

### 3.8 Offline & latency realities

- Quest-on-WiFi/phone-hotspot is the operating assumption; SSE drops are routine → A2A
  `tasks/resubscribe` on reconnect; the hub inbox is the durability layer (headset can be off
  for a week; approvals wait).
- **Read surfaces cache**: last-rendered A2UI payloads persist on-device (encrypted at rest,
  stamped "as of 09:14") — glanceable while offline. **Actions never queue offline**: any
  Tier ≥ 2 action requires a live round-trip + fresh nonce; the UI greys action buttons when
  the channel is down. No offline-approval footgun, by construction.
- Latency budget: voice→first-spoken-token target < 2.5 s (STT ~300 ms local; hub route ~50 ms;
  orchestrator plan+first tool ~1–2 s streamed). Progressive A2UI rendering masks the tail —
  the panel skeleton appears in < 1 s while data binds late. Ambient surfaces (`MetricTile`
  walls) refresh by `dataModelUpdate` push, not re-ask.

### 3.9 Worked scenario — every hop and gate

*CEO dons headset: "Hey Wayfinder — how is Aegis doing today? Approve whatever is pending."*

1. **Don + auth:** HMD-mounted event → device-key re-auth to hub (DPoP) → principal
   `ankur@…` session, `channel=ar, device=quest_ankur_01`. Inbox sync: 2 pending items.
2. **Voice:** wake word gates mic (privacy) → Whisper (on-device) → transcript → headset router:
   ecosystem intent, company="Aegis", two sub-intents (status query; approval sweep).
3. **Ask hop:** headset → hub `message/send` (transcript + context) → hub resolves Aegis Agent
   Card → token exchange (user → aegis-scoped 15-min token) → A2A `message/stream` task T1
   opens. *Gate: hub can only ask as Ankur; nothing more exists to steal.*
4. **Governed answer:** Aegis orchestrator LLM plans → tools `metrics.mrr_today`,
   `ops.incidents_open`, `billing.failed_payments` — each: PEP → Casbin PDP (RBAC/ABAC ✓,
   entitlement ✓) → RLS query → audit row (permissions-hash, channel=ar). *Gates: AUTHORIZATION ✓,
   DANGER (Tier 1 reads) ✓, AUTONOMY (read autonomy enabled) ✓, VERIFIABILITY (ledger) ✓.*
   Orchestrator emits artifacts: spoken summary + A2UI dashboard (MetricTile×4, LineChart,
   StatusGrid) with `aep:governance{auditRef}`.
5. **Render:** SSE → hub → headset; skeleton panel at `placement:front` in ~1 s, tiles bind as
   deltas stream; Piper speaks: "MRR $41.2k, up 3.1%. One open incident, sev-3. Two approvals
   pending." *Gate: renderer accepts catalog components only; payload hash recorded.*
6. **Approval sweep:** "approve whatever is pending" does NOT auto-approve — the orchestrator
   returns the pending set as cards; blanket approval of unseen items violates the approval
   policy (approval-fatigue control from ai-native-core §0.5: each item must be *shown*).
   Two ApprovalCards fan out at `placement:right`.
7. **Card 1 (Tier 2):** vendor invoice $180 recurring — card shows echoed referent
   `inv_1183 / Acme / $180.00`. User gazes + "approve" → `userAction{approve, apr_331}` → hub →
   orchestrator → `@aegis/approvals` maker-checker (maker=agent, checker=Ankur, SoD ✓) → PDP
   re-validates record id against approval content → execute → ledger `led_8410` + surfaceHash.
   Card flips to ✓. Total: ~2 s.
8. **Card 2 (Tier 4):** wire $12,400 to a NEW counterparty — orchestrator answers the approve
   action with **`auth_required` + `aep:stepUp{factor: phone-passkey, nonce, 60s}`**. Card shows:
   "New counterparty — confirm on phone." Phone buzzes → passkey ceremony (FaceID on phone) →
   signed assertion → PDP verifies nonce+signature+freshness → maker-checker ✓ → execute →
   ledger `led_8411` (records deviceId, factor, surfaceHash). Card flips ✓; Piper: "Wire
   approved with phone confirmation." *All four gates exercised, DANGER satisfied by a
   phishing-resistant second factor — voice and gaze alone never moved money.*
9. **Audit replay (later, from anywhere):** ledger shows T1's full tool-call trace, both
   approvals, permissions-at-action, and the exact UI hashes the human saw. The AR channel is
   *more* evidenced than a web click, not less.

---

## 4. Adoption candidates

| Project | License | Fit | Verdict |
|---|---|---|---|
| [A2A spec + SDKs](https://github.com/a2aproject/A2A) (JS/TS SDK: `a2aproject/a2a-js`) | Apache-2.0, Linux Foundation | Inter-agent transport, task lifecycle, `input_required`/`auth_required`, push notifications, signed cards | **Adopt** (hub + orchestrators) |
| [A2UI](https://github.com/google/A2UI) | Apache-2.0 | UI-as-data payload; catalog security model = modular-plan §K verbatim | **Adopt spec** (v0.9 line; pin + track v1.0 RC); **build the Unity renderer ourselves** |
| [AG-UI](https://docs.ag-ui.com/introduction) | MIT | Agent↔frontend events for Aegis *web* surfaces; .NET SDK in progress | **Adopt for web; optional adapter for headset** (A2A streaming suffices there) |
| [MCP C# SDK](https://github.com/modelcontextprotocol/csharp-sdk) (w/ Microsoft) | MIT | Wayfinder's in-headset tool layer → real MCP server (Feature-22's stated follow-on) | **Adopt** (phase 4) |
| [IvanMurzak/Unity-MCP](https://github.com/IvanMurzak/Unity-MCP) | open source (verify current license) | Proven *runtime* MCP embedding in built Unity games; one-line C# method→tool | **Mine for patterns**; adopt if license clean |
| [flutter/genui](https://github.com/flutter/genui) + [lmee/A2UI-Android](https://github.com/lmee/A2UI-Android) + [a2ui-3d-renderer](https://a2ui.org/ecosystem/renderers/) | Apache-2.0 / MIT / experimental | Reference renderers — binding, catalog registration, and (3D) spatial mapping decisions | **Study, port patterns** to C# |
| [XCharts](https://github.com/XCharts-Team/XCharts) or hand-rolled mesh charts | MIT | Unity chart prefabs behind `LineChart`/`BarChart` catalog components | **Assess** (wrap, don't expose its API) |
| [AGNTCY/OASF/SLIM](https://docs.agntcy.org/) | Apache-2.0, Linux Foundation | Cross-org agent directory/identity — beyond a personal ecosystem | **Hold / re-assess** if AEP federates outside owned companies |
| [MCP Apps (SEP-1865)](https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/) / [OpenAI Apps SDK](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt) | open / proprietary | iframe-HTML UI — no iframe in Unity XR; executable-code UI violates §K | **Reject for headset** (relevant only for chat-host distribution of Aegis modules) |
| [ManageXR](https://www.managexr.com/) / [ArborXR](https://arborxr.com/) | commercial | Headset fleet enrollment/kiosk-mode for the CEO device (not the management plane itself) | **Use operationally**, not architecturally |
| [XR Blocks / Vibe Coding XR](https://research.google/blog/vibe-coding-xr-accelerating-ai-xr-prototyping-with-xr-blocks-and-gemini/) | research (Apache-2.0 framework) | LLM-friendly "Reality Model" ideas for spatial placement heuristics | **Inspiration only** (WebXR, not Unity) |

## 5. Risks and honest limits

1. **A2UI is pre-1.0.** v0.9→v1.0 may break payload shapes; renderers listed as stable are web
   ones. Mitigation: pin v0.9.x, isolate parsing behind one adapter class, ship the fallback-to-
   Text rule so unknown constructs degrade instead of failing.
2. **Quest step-up is genuinely weak on-device.** No per-app biometrics; in-headset PIN is
   shoulder-surfable (mitigated by randomized keypad) and worse UX than the phone passkey. The
   phone-passkey ceremony breaks "everything in AR" purity for Tier-4 — **accept it**; money
   deserves a second device. Revisit if Meta ships per-app auth or iris ID (Vision Pro's Optic ID
   already does this — a future visionOS client gets *better* step-up than Quest).
3. **Charts in Unity are the schedule risk** of the renderer (~1–2 wk alone). Cut scope: v1 =
   MetricTile + sparkline + bar; defer arbitrary charting.
4. **Voice+money is an error class web UIs don't have.** STT mishears; deixis misresolves.
   Mitigations already designed in: echoed referents, gaze binding, no blanket approvals,
   Tier-4 second factor, orchestrator-authored (not headset-LLM) summaries. Do not relax these.
5. **Approval fatigue is worse in AR** (a floating queue begs to be swiped through). Enforce
   ai-native-core §0.5 controls at the *orchestrator*: proposal rate limits, batching,
   confidence suppression; consider a per-session AR approval cap.
6. **Hub is a new trust node.** Sender-constrained tokens, scope-bound exchange, and
   what-you-see-is-what-you-sign (surfaceHash) bound the blast radius, but the hub's host is now
   part of the security perimeter — self-host it with the same rigor as an orchestrator.
7. **A2A SSE through mobile networks** (NAT timeouts, sleep). The inbox+resubscribe design
   absorbs it, but expect connection-management gruntwork on Quest (OkHttp-style keepalives via
   UnityWebRequest are limited — likely a raw `HttpClient` + custom SSE reader on a worker
   thread, marshaled per THREADING_AND_EVENTBUS rules).
8. **One person, two platforms.** The renderer (~5–6 wk) + hub (~2–3 wk) + orchestrator A2A
   facade (~2 wk) is ~1 quarter of focused solo work *after* the Aegis substrate (tool registry,
   approvals, ledger) exists. AEP depends on those tracks landing first; do not start the
   renderer before the tool registry emits real read-model data to render.
9. **What we are NOT claiming:** no Aegis-side implementation exists yet; A2UI has never been
   rendered in Unity by anyone; the `aep:*` extension blocks are our invention and only become
   "a protocol" if a second implementation ever consumes them. Until then AEP is a
   well-sourced private profile — which is all a personal ecosystem needs.

## 6. Phased build outline

**Phase 0 — A2A facade on Aegis (≈2 wk).** Wrap the governed orchestrator in an A2A server
(`a2a-js`): Agent Card (skills = coarse capabilities; security schemes), `message/send|stream`
mapped onto the existing agent loop, task states from the approvals engine
(`input_required`/`auth_required`), push-notification webhook emitter. Tool registry, PDP, ledger
untouched — this is a thin adapter. Exit test: a desktop A2A CLI client asks "MRR today" and gets
text + a valid A2UI JSON artifact (validated against the schema, no renderer yet).

**Phase 1 — Ecosystem hub (≈2–3 wk).** TS/Node service: company registry (signed-card pinning),
A2A client fan-out, OAuth token-exchange broker, device enrollment (RFC 8628 + DPoP), durable
inbox, hub-side A2UI schema/catalog validator, WSS channel for headsets. Exit test: two
registered companies (Aegis + a stub), one federated "how are my companies" query, one queued
push notification surviving a client restart.

**Phase 2 — Unity A2UI renderer v1 + ask flow (≈4 wk).** A2A/SSE client on Quest (worker thread
→ EventBus); `SurfaceRequestEvent` generalization of the AiSurface path; parser + data-model
binding; core 13 components + MetricTile + ApprovalCard prefabs on the grabbable panel;
`userAction` return path; `EcosystemVoiceTools` provider; catalog-hash advertisement + extended
`Validate()` CI gate. Exit test: the §3.9 scenario steps 1–5 live on-device.

**Phase 3 — Approvals + step-up from AR (≈2–3 wk).** ApprovalCard actions → `@aegis/approvals`;
`auth_required`/`aep:stepUp` round-trip; phone-passkey ceremony in the Android companion (it
already pairs over TCP — add a WebAuthn activity); doff-invalidation; surfaceHash into the audit
ledger; gaze-bound approve. Exit test: §3.9 steps 6–9, including a rejected replayed nonce and a
mid-flight card-tamper test (hub mutates payload → core refuses on hash mismatch).

**Phase 4 — Ambient ops + hardening (ongoing).** LineChart/BarChart/LogStream/StatusGrid;
persistent world-anchored "company wall" (ambient MetricTiles on `dataModelUpdate` push);
multi-company arc layout; Promptfoo evals for catalog-conformance + approval-card content
fidelity; in-headset MCP server via the C# SDK for local device tools; approval-rate controls;
offline cache encryption; (stretch) second renderer target — visionOS/SwiftUI via the community
renderer — to prove AEP's payloads are truly client-portable.

---

## Red-team correction (READ BEFORE IMPLEMENTING)

**Verdict:** Protocol bet is sound and honestly sourced (A2A v1.0 / A2UI / AG-UI claims verified accurate, not over-stated) — but the crown-jewel security claim (what-you-see-is-what-you-sign vs a compromised hub) is **NOT airtight as specified**, and cross-company aggregation is an **ungoverned cross-tenant surface**. Fix those two before any build; the rest is a well-scoped, correctly-sequenced R&D track that is genuinely a *later* bet than the core platform.

**Top fixes (ranked):**
1. **Bind the human's step-up factor to `surfaceHash`, not just the nonce/approvalId.** Today `aep:stepUp.bind = approvalId` and the assertion signs only the nonce (§3.4, §3.3-c step 4). The phone WebAuthn prompt shows a generic RP name, not "$12,400 to NEW counterparty" — and the headset (which *does* show the amount) is downstream of the untrusted hub. A compromised hub can render the benign $180 card / a contentless "confirm on phone" (this is literally what §3.9 step 8's card says) while relaying the real wire's nonce; the FaceID tap then authorizes the wire the human never saw. Fix: put `surfaceHash` (or a canonical challenge digest incl. amount+counterparty) **inside the signed WebAuthn challenge**, and **display the amount/counterparty on the phone itself** (the trusted signing device), not only in AR. `surfaceHash`-into-the-ledger is forensic (proves-after) — it is not authorization-input (prevents). Close that gap.
2. **Govern the hub aggregation boundary.** §2 / topology claims "no cross-company authority, only cross-company conversation" — but the hub LLM ingests company-A + company-B read models into one context (§3.3-d, §3.9). That is cross-tenant commingling with **no RLS, no per-company PDP, and no audit ledger** (the hub "holds no data / evaluates no policy" — yet it holds the combined answer and the routing authority). Prompt-injection in A's data (log line, invoice memo) now steers a context that also holds B's data + routing. The §3.6 injection model covers only the *renderer* seam. Add: hub-side audit log, provenance-tagged per-company context partitions, and an injection threat model for the aggregation prompt.
3. **Widen the renderer estimate and gate it on A2UI reaching 1.0.** The single load-bearing net-new piece (A2UI→Unity) is also the least de-risked: pre-1.0 payload churn + incremental JSONL streaming parse + XR-legible charts + ApprovalCard step-up UX, on one person. 5–6 wk is a floor, not a median — carry 8–10 wk and do not start until the tool registry emits real read-model data AND A2UI v1.0 ships (or explicitly accept the v0.9 rewrite cost).

**Key holes:**
- *Security:* (a) WYSIWYS ≠ airtight (fix #1); (b) ungoverned hub aggregation (fix #2); (c) hub compromise also = theft of all live per-company exchanged tokens (bounded by scope/TTL, but the hub is a single-point cross-company token vault — say so plainly and rotate aggressively); (d) shared/worn-headset principal confusion — device-key silent re-auth means possession = identity for Tier≤1; a headset handed to someone mid-session leaks read data until the first Tier≥2 gate.
- *Feasibility:* A2UI stable renderers are web-only (verified) — Unity is unproven by anyone; ambient SSE keepalive on Quest over mobile NAT is real gruntwork (§5.7 honest); <2.5 s voice→token budget through hub+token-exchange+orchestrator-LLM over mobile is optimistic (won't break correctness, will bruise UX).
- *Gaps:* no per-company revocation/kill-switch story for a rogue hub; no spec for what the *phone* displays during step-up; `stepUpResponse` replay window / nonce store not specified; multi-headset-per-principal (CFO + CEO) session concurrency unaddressed; AG-UI event-name alignment asserted but not specified.

**Where a human / different approach is genuinely needed:**
- **Fix #1 needs a security-architect review of the WebAuthn challenge construction** — getting "sign the transaction content, not a nonce" right is the same class of problem as FIDO transaction confirmation / EMV dynamic linking; do not hand-roll it. Consider WebAuthn's largeBlob/txAuthSimple-style transaction binding, or move Tier-4 confirmation entirely to the phone (amount rendered + signed on one trusted device), demoting AR to display-only for money.
- **Product call, not an engineering call:** this is ~1 quarter of solo work for a **single-user** (the CEO) surface, strictly *after* the entire governed substrate exists. It is correctly sequenced as last — but confirm it clears the bar of "core platform features a paying tenant needs" before it takes a quarter. Treat as a differentiated demo / founder-dogfood track, not a v1 platform requirement.

---

### Sources (primary)

A2A: [spec](https://a2a-protocol.org/latest/specification/) · [repo](https://github.com/a2aproject/A2A) · [2026 status](https://rapidclaw.dev/blog/a2a-protocol-complete-guide-2026) · [IBM](https://www.ibm.com/think/topics/agent2agent-protocol) · [W&B](https://wandb.ai/byyoung3/Generative-AI/reports/How-the-Agent2Agent-A2A-protocol-enables-seamless-AI-agent-collaboration--VmlldzoxMjQwMjkwNg) · [announcement](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
A2UI: [announcement](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/) · [a2ui.org](https://a2ui.org/) · [repo](https://github.com/google/A2UI) · [v0.9](https://developers.googleblog.com/a2ui-v0-9-generative-ui/) · [renderers](https://a2ui.org/ecosystem/renderers/) · [CopilotKit A2UI+AG-UI](https://www.copilotkit.ai/blog/build-with-googles-new-a2ui-spec-agent-user-interfaces-with-a2ui-ag-ui) · [design-system take](https://medium.com/@kenzic/a2ui-the-protocol-for-agent-driven-interfaces-that-works-with-your-design-system-bc7c05276513)
AG-UI: [docs](https://docs.ag-ui.com/introduction) · [17 events](https://www.copilotkit.ai/blog/master-the-17-ag-ui-event-types-for-building-agents-the-right-way) · [MS Agent Framework](https://learn.microsoft.com/en-us/agent-framework/integrations/ag-ui/) · [Oracle Agent Spec](https://blogs.oracle.com/ai-and-datascience/announcing-agent-spec-for-a2ui-copilotkit-ag-ui)
MCP Apps/Apps SDK: [MCP blog](https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/) · [OpenAI](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt) · [mcpui.dev](https://mcpui.dev/guide/apps-sdk) · [TELUS GenUI survey](https://www.telusdigital.com/insights/data-and-ai/article/accelerating-genui-ecosystem-mcp-apps-openai-apps-sdk-and-google-a2ui)
AGNTCY: [docs](https://docs.agntcy.org/) · [ACP spec](https://spec.acp.agntcy.org/) · [LF press](https://www.linuxfoundation.org/press/linux-foundation-welcomes-the-agntcy-project-to-standardize-open-multi-agent-system-infrastructure-and-break-down-ai-agent-silos) · [Register](https://www.theregister.com/2025/07/30/agntcy_lf_donation/)
XR: [IvanMurzak/Unity-MCP](https://github.com/IvanMurzak/Unity-MCP) · [Unity MCP](https://unity.com/blog/unity-ai-mcp-how-to-get-started) · [XR Blocks](https://research.google/blog/vibe-coding-xr-accelerating-ai-xr-prototyping-with-xr-blocks-and-gemini/) · [Immersion Analytics](https://www.immersionanalytics.com/solutions/business-intelligence/) · [virtual NOC](https://www.peakaidesign.com/blog/virtual-network-operations-center-noc) · [Nokia](https://www.nokia.com/blog/network-operations-in-the-metaverse/) · [Android XR Gemini](https://developer.android.com/develop/xr/gemini) · [ManageXR](https://www.managexr.com/) · [ArborXR](https://arborxr.com/) · [UI Toolkit runtime](https://unity.com/blog/unity-6-ui-toolkit-updates)
