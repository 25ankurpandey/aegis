# Aegis AI-Native Core

> Companion to [agentic-platform-design.md](./agentic-platform-design.md) (the "agent reasons; the
> governed core acts" principle, tool registry, agent-as-principal, risk-tiered HITL, LLM gateway,
> self-knowledge RAG, autonomous ops) and [modular-platform-plan.md](./modular-platform-plan.md)
> (the module manifest `aegis.module.json`, the Entitlement Service, kernel-vs-modules, the six
> extension surfaces, the phase-scoped lifecycle).
>
> Those two docs established that Aegis *can* carry an agent safely and *can* ship capability as
> modules. **This** doc makes one stronger claim and specifies how to honour it: **AI is a structural
> property of every Aegis module — inherited from the kernel by construction — not a feature bolted on
> per module or centrally.** The forcing function is a mandatory `ai` block in the module manifest and
> a `@aegis/ai-core` substrate that stands to AI exactly as `libs/access-control`, `libs/db`, and
> `libs/events` stand to authorization, isolation, and eventing today.
>
> Grounded in the Aegis codebase and validated against **Wayfinder** — an AR product whose *entire*
> control surface is agentic, where a feature "does not exist to the user unless it registers a tool
> with a grounded description," and whose patterns (MCP-shaped tool catalog, `IVoiceToolProvider`
> self-registration, generated-and-CI-gated `CapabilityManifest`, `OwnerVoiceGate` sensitivity tiers,
> the reasoning-plane/acting-plane split, the 3-agent autonomous harness) are cited by name throughout.

---

## 0. Reading guide

| § | Question it answers |
|---|---|
| 1 | What "AI-first from the root" *means* for Aegis, and how it composes with — never violates — "the agent reasons; the governed core acts." AI-in-the-core vs AI-features. |
| 2 | The **AI-Native Module Contract** — the mandatory `ai` block every module implements so agentic capability is inherited, with a concrete TS-ish shape for each of the nine facets. |
| 3 | The contract **applied to each existing capability** (RBAC, ABAC, payroll, expense, invoice, workflow, audit, approvals, notifications, reporting, connectors). |
| 4 | The **module scaffold** — what a developer or an agent generates so a *new* module is AI-native on day one. |
| 5 | The **autonomous dev/ops loop** — Wayfinder's 3-agent model + feedback loops, wired to Aegis's own development and to the NoOps design in agentic-platform-design.md §F. |
| 6 | The **cross-cutting engine** — `@aegis/ai-core`, the shared AI substrate every module plugs into. |
| 7 | **Migration** — retrofitting the existing modules to the contract incrementally, no rewrite. |

> **§8 (appended after a red-team) supersedes the "all nine facets are mandatory" framing below.** Read §0.5 next before treating this as a build spec.

---

## 0.5 Red-team correction — the Minimal Viable Contract (READ THIS BEFORE BUILDING)

The body of this doc (§2) proposes a **nine-facet `ai` block mandatory on every module**. An adversarial
review concluded — correctly — that **mandating all nine is over-engineering** for a governed financial
platform: it manufactures stub facets, real per-turn cost/latency, and an eval/RAG maintenance burden
that scales with *module count* instead of *realized value*. The underlying instinct ("AI-native from the
root, governed by construction") is right **if narrowed**. Treat the following as the authoritative
contract; §2's nine facets are the *menu of optional capabilities*, not a checklist.

**Structural & inherited (REQUIRED on every module — near-zero per-module cost because they derive from
code that already exists):**
1. **Facet 1 — Tools**, auto-generated from the governed routes (route-walk + Joi → JSON Schema +
   `Permission`), authz-bound and entitlement-filtered. This is what makes a module agent-operable.
2. **Facet 5 — Risk tier** on every tool, defaulted from the HTTP verb, with **money/irreversible ⇒ Tier 4
   (mandatory human approval)**. This is what makes it governed-by-construction.

**Required only where the module exposes Tier ≥ 2 (write) tools:**
3. **Facet 6 — an autonomy eval gate.** No autonomous write ships without a passing eval. Tier-1
   (read-only) modules need none — they cannot act, so there is nothing to gate.

**Opt-in per module, where the capability earns it (NOT merge-blocking):** context/resources (2),
intents (3), triggers (4), generative-UI surfaces (7), knowledge contribution (8), module-local rails
(9). Platform guardrails and the self-knowledge index run **centrally**; a module opts *in* to
contributing rather than being forced to declare empty blocks.

**The CI gate `validateAiManifest()` enforces governance-on-declared-tools, NOT completeness-of-nine:**
(a) every EXECUTE tool has a risk tier + a non-stub description; (b) every money/irreversible tool is
Tier 4; (c) every Tier ≥ 2 tool referenced by an eval gate has a passing eval before autonomy is enabled.
It must **not** fail a merge for a missing surfaces/knowledge/intents block.

**Four hard rules that keep AI-in-the-core from leaking into authority (must be enforced in CODE, not
prose — see §8):**
- **The reasoning plane never computes a tier/threshold.** `amount > 10000 ⇒ Tier 4` is evaluated by the
  deterministic PDP from the request, never assembled/interpreted in the AI substrate.
- **The reasoning plane never resolves a deictic referent that feeds a Tier-4 execute.** "approve *this*"
  must be echoed back in the approval card (Facet 7) and re-validated by the core against the actual
  record id — a mis-resolution otherwise pays the wrong invoice.
- **The LLM output never carries `principal` / `tenant_id` / `permission`.** The executed call re-derives
  all three server-side and ignores any such fields echoed by the model. Tool defs are filtered *before*
  the model sees them.
- **Generic / reflective "update field X on record Y" tools are default-ABSENT** in a financial core
  (allowed only by explicit, named allow-list) — the classic bypass vector Wayfinder could afford as an
  AR toy and Aegis cannot.

**Also add before building** (missing from §2, detailed in §8): a per-tenant **token/cost budget +
prompt tool-count cap + context-assembly caching** (the per-turn "assemble from live registries" is the
dominant cost driver); a **prompt-injection threat model** for untrusted tenant data (invoice memos,
expense notes, connector payloads) flowing into agent context/RAG; **approval-fatigue controls**
(proposal rate limits, batching, confidence suppression) so maker-checker doesn't degrade to
rubber-stamping; and a **per-module agent kill-switch / circuit-breaker** independent of redeploy.

**The `@aegis/ai-core` engine (§6), the tool registry, and Wayfinder's `CapabilityManifest.Validate()`
CI gate stay exactly as designed** — they are the shared substrate. What changes is only *how much each
module is forced to declare*: tools + tier always; the rest by merit.

*(This section is the reconciliation of §2 with the red-team in §8. Where they differ, §0.5/§8 win.)*

---

## 1. Principle: AI-first from the root

### 1.1 The claim, stated precisely

Aegis already had two structural properties every module inherits from the kernel, whether or not the
module author thinks about them:

- **Isolation is structural** — a module gets RLS tenant isolation because it runs inside
  `withTenantTransaction` (`libs/db/src/rls.ts`); the author does not opt in, and (per modular-plan §D.2/§H)
  is *forbidden* from hand-writing RLS — the platform generates it.
- **Authorization is structural** — every route is PEP-guarded, asserted at boot by
  `findUnguardedRoutes()` (`libs/service-core/src/bootstrap/pep-assertion.ts`); an unguarded route fails
  the boot, it is not a lint warning.

**AI-first from the root means adding a third structural property of identical standing: agentic
capability is inherited from the kernel by construction.** A module is *agent-operable, agent-readable,
agent-explaining, and agent-improving the moment it exists* — for the same reason it is isolated and
authorized the moment it exists: because the kernel makes it so, and the CI gate refuses to ship a
module that isn't.

This is the exact lesson from Wayfinder, stated as an Aegis invariant. In Wayfinder a feature
contributes agent capability by dropping an `IVoiceToolProvider` component and `VoiceManager`
auto-discovers it at boot; the generated `CapabilityManifest.Validate()` *fails the build* if any
registered tool lacks a complete description or a correct sensitivity tier. There is no "AI feature" —
the app's capabilities **are** the tool list. Aegis's analogue: the manifest's `ai` block is the
`IVoiceToolProvider`; `@aegis/ai-core`'s registry is the `WayfinderToolCatalog`; a merge-blocking
`validateAiManifest()` is `CapabilityManifest.Validate()`.

### 1.2 The distinction that makes this non-trivial: AI-in-the-core vs AI-features

| | **AI-in-the-core (structural — what we require)** | **AI-features (superficial — what we reject as the definition)** |
|---|---|---|
| Where it lives | The kernel + the mandatory manifest `ai` block; inherited by every module | A chat widget, a "summarize" button, one clever endpoint per team |
| Who makes it exist | The platform, by construction; CI refuses modules without it | A product manager who prioritised it for one module |
| Coupling to capability | The module's tools **are** its capabilities — auto-derived from its routes/Joi/Permission | Bolted beside the capability, drifts from it |
| Drift behaviour | Cannot drift — generated from live registries, gated by `validateAiManifest()` | Drifts silently; the demo works, the twentieth module has no tools |
| Uniformity | Every module, identically; new module ⇒ new agent powers, zero core edits | Uneven; whichever modules got budget |
| Governance | Every tool call runs `authenticate → authorize(PEP) → RLS → audit`; no exceptions | Ad-hoc; each bolt-on re-decides safety, some get it wrong |

An AI-feature is a *thing a module has*. AI-in-the-core is a *property a module is*. Wayfinder's
`AI_NATIVE_ANALYSIS.md` names the failure mode of the superficial path directly: strong scaffolding
around a specific demo can mask a dead path (their shipped BLOCKER — a tool-result feedback loop that
never iterated, hidden by a double-execution fallback so the demo looked fine). The structural approach
plus runtime invariants (§5.4) is what prevents Aegis from shipping the same class of lie.

### 1.3 How this composes with — does NOT violate — "the agent reasons; the governed core acts"

The founder's directive ("AI in the core of every module") and the spine principle ("the agent reasons;
the governed core acts") are **the same statement viewed from two angles**, and the manifest `ai` block
is what makes them one thing rather than a tension:

- "The agent reasons; the governed core acts" is a statement about the **execution plane**: the LLM
  proposes `{tool, args}`; the deterministic core executes only registered tools through
  `authenticate → authorize(PEP) → RLS → audit`. It is Wayfinder's `OwnerVoiceGate.Allow()` running
  immediately before `WayfinderToolCatalog.Invoke()` on every resolution path, and Wayfinder's rule that
  the LLM emits validated *data*, never code or coordinates.
- "AI in the core of every module" is a statement about the **surface plane**: *what* the agent is able
  to reason over and propose against is the union of every module's declared tools, context, intents,
  and UI surfaces — and that surface exists by construction, not by bolt-on.

The composition rule, stated as a hard invariant:

> **AI-in-the-core grows the agent's *surface* (more governed tools, more readable context, more
> intents); it never grows the agent's *authority*. Every surface element the manifest declares still
> executes through the identical governed path a human API call hits. Making a module AI-native adds
> *what the agent can propose*, and adds *nothing* to *what the agent can do without the core's
> permission*.**

Three consequences, each a direct Wayfinder port:

1. **The reasoning plane never touches the acting plane's authority.** Aegis mirrors Wayfinder's
   AI-Gateway trust boundary (`docs/architecture/AI_GATEWAY.md`): the LLM runs behind a key-holding
   gateway (LiteLLM, per agentic-platform-design.md §E.6), tenant-entitled tool *definitions* pass
   through verbatim, the tool *call* relays back, and execution happens inside the governed core. The
   model is never a participant in execution — exactly as the Wayfinder cloud model never executes a
   tool; the Quest device does.
2. **A structural AI property is a structural *governance* property.** Because every declared tool
   carries a risk tier (§2, facet 5) derived from the manifest and gated in CI (Wayfinder's
   `OwnerSensitivityTable` is *derived* from the manifest, and `Validate()` flags a Sensitive tool
   mistagged Benign), making a module AI-native simultaneously makes it *governed-by-construction*. You
   cannot register an ungoverned tool.
3. **Breadth without abandoning the gate.** Wayfinder's `ReflectionVoiceTools` (a few broad tools that
   can reach any public member) proves you can offer the long tail — but only through default-deny
   allow-lists, blocked destructive verbs, and everything try/caught. Aegis's equivalent generic/
   reflective tools (e.g. a generic "update field X on record Y") are attractive but **must** route
   through the same `authorize(PEP) → RLS → audit` path with a default-deny allow-list and
   destructive-verb block — governance-native breadth, never a bypass.

### 1.4 What "from the root, for every capability" specifically buys

Because the property is inherited, these become true of the *whole platform at once*, not module by
module:

- **The app explains itself** (agentic-platform-design.md §C.4, §C.6 no-human-support): every module
  contributes to the self-knowledge RAG by construction (facet 8), so "how do I…/what can this do?/why
  did this happen?" is answerable for every capability — the analogue of Wayfinder's `describe_feature`
  / `how_do_i` / `capability_check` self-awareness tools, which speak only from the generated manifest
  and *decline-and-redirect* rather than hallucinate.
- **The app is routable** (agentic-platform-design.md §C.3, the "too many tools" problem): every module
  ships NL intents and capability descriptions (facet 3), so the orchestrator can route by module before
  tool without a hand-maintained routing table.
- **The app self-improves**: every module ships eval/feedback hooks (facet 6), so the platform's agent
  behaviour is measured and improved uniformly — the Aegis analogue of Wayfinder's orb-state/
  reply-quality feedback loop, hardened past the maturity caveat their own audit flags.
- **The app is safe uniformly**: risk tiers + guardrails (facets 5, 9) are declared per module and
  enforced by one substrate, so Tier-4 gating (`@aegis/approvals`) is consistent across payroll, invoice
  approval, and ERP push — not re-implemented three times.

---

## 2. The AI-Native Module Contract

Every module already ships an `aegis.module.json` (modular-plan §C). The contract adds **one mandatory
top-level `ai` block**. `validateAiManifest()` (the Aegis analogue of `CapabilityManifest.Validate()`)
runs at build/install and **fails the merge** if the block is absent or incomplete — the same standing
as `findUnguardedRoutes()` failing boot on an unguarded route. There is no "AI-optional" module, exactly
as there is no "isolation-optional" or "authz-optional" module.

Design rule throughout, lifted from Wayfinder: **machine-derivable facets are GENERATED from live
registries (so they cannot drift); human-authored facets are tightly curated and CI-gated for
completeness.** Tools are generated from routes/Joi/Permission; descriptions, intents, and risk-tier
*rationale* are curated and gated.

### 2.0 The manifest, extended (one manifest, now with a mandatory `ai` block)

```jsonc
// aegis.module.json — the SAME single source of truth from modular-plan §C,
// now with a mandatory "ai" block. Everything above "ai" is unchanged.
{
  "id": "aegis.expense",
  "version": "2.3.0",
  "requiredKernel": "^4.0.0",
  "trustTier": "first-party",
  "dependsOn": ["aegis.approvals@^1.2"],
  "permissions": [ /* … as before … */ ],
  "roles":       [ /* … as before … */ ],
  "routes":      [ /* … as before … */ ],
  "events":      { "emits": ["expense.submitted","expense.approved"],
                   "consumes": ["approvals.decided"] },
  "migrations":  "migrations/",
  "rls":         "platform-generated",
  "ui":          { "mounts": [ /* … existing screens … */ ] },
  "entitlement": { /* … as before … */ },
  "customFields":{ "namespace": "x_expense_" },

  // ─────────────────────────── MANDATORY ───────────────────────────
  // Absent or incomplete ⇒ validateAiManifest() fails the merge.
  // requiredAiCore pins the @aegis/ai-core substrate contract version,
  // exactly as requiredKernel pins the host contract.
  "ai": {
    "requiredAiCore": "^1.0.0",

    "tools":       "auto:routes+joi+permission",   // facet 1 — generated; curated overrides allowed
    "context":     [ /* facet 2  — agent-readable resources */ ],
    "intents":     [ /* facet 3  — NL capability descriptions */ ],
    "triggers":    { /* facet 4  — events → agent + self-improving loops */ },
    "risk":        { /* facet 5  — risk tier per action (default + overrides) */ },
    "evals":       [ /* facet 6  — eval/feedback hooks */ ],
    "surfaces":    [ /* facet 7  — generative-UI surfaces (declarative) */ ],
    "knowledge":   { /* facet 8  — memory/knowledge contribution to self-knowledge RAG */ },
    "guardrails":  { /* facet 9  — module-specific policies */ }
  }
}
```

The nine facets follow. Types are TS-ish and live in `@aegis/ai-core` (§6) so every module imports the
same shapes rather than re-declaring them.

---

### Facet 1 — Tools (self-describing, authz-bound, auto-derived)

**This is the highest-leverage reuse in the whole design and is already 90% built.** Wayfinder's
`WayfinderToolCatalog` is a registry of `VoiceTool { Name, Description, Handler, ToolSensitivity,
List<ToolParam> }`, each mapping 1:1 to a future MCP tool registration, and each param carrying a
JSON-schema-ish shape so the planner is told the exact arg contract. Aegis already produces exactly this
material from *running code*: `findUnguardedRoutes()` walks the live Express router stack for
method + path + guard; joining that walk to each route's **Joi validator** (→ JSON Schema via
`joi-to-json`, precisely the MCP/function-calling input format) and the **`Permission`** on each
`authorize()` yields self-describing, authz-bound tools with zero hand-maintenance.

So `"tools": "auto:routes+joi+permission"` means *generate from the route-walk*; the module author only
supplies **curated overrides** — a better NL description, usage examples, or a risk-tier bump.

```ts
// @aegis/ai-core — the tool shape, generated per route, mirrors WayfinderToolCatalog.VoiceTool 1:1
interface AegisTool {
  name: string;                       // `${moduleId}.${verb}` — e.g. "expense.approve"
  description: string;                // curated + CI-gated non-stub (Wayfinder: stub description fails Validate())
  examples: string[];                 // NL phrasings — vocabulary match drives RAG-over-tools recall (§C.3)
  inputSchema: JSONSchema;            // GENERATED from the route's Joi validator (joi-to-json)
  permission: Permission;             // GENERATED from authorize(Permission) on the route — the authz bind
  entitlement: SkuRef;                // GENERATED from manifest.entitlement.sku — tenant must have bought it
  kind: 'LOOKUP' | 'EXECUTE';         // Wayfinder ToolKind: LOOKUP=RLS read, feed back, no approval;
                                      //   EXECUTE=state change ⇒ PEP + approvals + audit row (§2.5)
  risk: RiskTier;                     // facet 5; default derived from HTTP verb, curated override allowed
  handler: 'route';                   // the handler IS the existing governed route — never a second code path
}
```

**Invariants (all ported from Wayfinder, all CI- or runtime-enforced):**

- **One registry, invoked identically for human or agent.** The tool handler *is* the governed route;
  there is no parallel "agent path." Wayfinder's `Invoke()` runs a tool only if it is registered — a
  hallucinated tool name is a no-op, not a crash. Aegis: the agent proposes a `name`; if it isn't in the
  entitlement-∩-permission-filtered registry, it is refused before any core call.
- **The catalog is the stable contract; the model is swappable** (Wayfinder: offline keyword resolver ↔
  Groq/Gemini/OpenRouter behind an unchanging catalog). Aegis freezes tools + PEP + audit and treats the
  LLM provider as a LiteLLM plug-in (agentic-platform-design.md §E.6).
- **Runtime invariant (the anti-BLOCKER):** a `LOOKUP` tool can never terminate as a committing action
  — asserted at runtime in the tool-loop runner (§5.4), because this is the exact class of bug that
  shipped "verified" in Wayfinder.

---

### Facet 2 — Agent-readable context / Resources (RLS-scoped)

The agent must be able to *query the module's current state* to reason, and that query must obey the same
isolation the acting plane obeys. This is the MCP **Resources** notion (app-injected context, vs Tools
= model-invoked) and Wayfinder's `VoiceContextTarget` / perception-context feed (`PopulateVoiceContext`)
that assembles the user's *focus* into the planner every turn so "approve **this**" resolves against
real state.

```ts
interface AegisContextResource {
  id: string;                         // e.g. "expense.pending_for_me"
  description: string;                // what state this exposes (CI-gated non-stub)
  shape: JSONSchema;                  // shape of what the agent receives
  resolver: 'route' | ResolverRef;    // a LOOKUP route or a read model; ALWAYS runs in withTenantTransaction
  scope: 'rls';                       // RLS-scoped by construction — never a raw query
  focusable?: boolean;                // can be the referent of "this/it" (the enterprise "attention ray")
}
```

Two kinds, per Wayfinder's split between the live catalog and the ambient focus context:

- **Standing context** — RLS-scoped summaries the agent may pull (`expense.pending_for_me`,
  `invoice.overdue`, `payroll.next_run_summary`). Every resolver runs inside `withTenantTransaction`, so
  cross-tenant leakage is impossible at the DB, mirroring the acting plane.
- **Focus context** — the enterprise analogue of Wayfinder's head-ray/attention resolution: the record
  currently open, the entity selected, the active tenant/scope, assembled into the agent context each
  turn so deictic references ("approve **this**", "send it to **them**") bind to real, authorized state
  rather than the model's guess. `focusable: true` marks a resource as an eligible referent.

---

### Facet 3 — Natural-language intents / capability descriptions (self-explain + routable)

So the platform self-explains and the orchestrator can route by module before tool (agentic-platform-
design.md §C.3 hierarchical routing; §C.4 self-knowledge). This is Wayfinder's per-tool `examples` plus
the curated `FeatureCards` in `CapabilityManifest`, and it powers the same structured `capability_check`
verdict (the Alexa `CanFulfillIntent` pattern) that lets the assistant say "your plan does not include
payroll" instead of hallucinating.

```ts
interface AegisIntent {
  id: string;                         // "expense.submit_report"
  utterances: string[];               // "file my expenses", "submit this month's receipts"
  summary: string;                    // goal-phrased (Wayfinder GroupedSummary) — feeds "what can you do?"
  maps_to: string[];                  // tool/resource ids this intent resolves to
  requiresEntitlement: SkuRef;        // so capability_check answers "not entitled" vs "not supported"
  requiresPermission: Permission;     // so capability_check answers "not authorized, nearest allowed is Y"
}
```

`can_i(action)` / `describe_capability` / `how_do_i` are themselves governed tools (Wayfinder's
self-awareness-tools-are-tools pattern) backed by the per-tenant capability manifest (§6), so the agent's
self-description is always truthful to entitlement ∩ policy — it *declines-and-redirects*, never invents.

---

### Facet 4 — Events the module emits/consumes for agent triggers + self-improving loops

Modules already declare `events.emits/consumes` (modular-plan §C, `libs/events` bus + outbox). The `ai`
block declares *which of those events are agent triggers* and *which feed the self-improving loop* — the
Aegis analogue of Wayfinder's `AiOrbStateEvent` (thinking/speaking) and reply-quality `PickBestReply`
closing the loop between action and result.

```ts
interface AegisTriggers {
  agentOn: Array<{                    // events that may wake a (durable) agent workflow
    event: string;                    // "invoice.received"
    proposes: string;                 // tool/intent the agent is expected to propose
    riskCeiling: RiskTier;            // an event-triggered agent may never exceed this tier autonomously
  }>;
  learnFrom: Array<{                  // events that feed evals / self-improvement (facet 6)
    event: string;                    // "approvals.decided", "expense.rejected"
    signal: 'outcome' | 'correction' | 'override';  // was the agent's proposal accepted/edited/overridden?
  }>;
}
```

`agentOn` subscribes an agent to a topic via the outbox (agentic-platform-design.md §B async path):
`invoice.received → agent proposes invoice.match` — but bounded by `riskCeiling` so an event-triggered
agent can *propose* a Tier-4 action and still be forced through `@aegis/approvals`. `learnFrom` is the
feedback spine: every human override/correction of an agent proposal is a labelled training/eval signal,
captured on the audit ledger and fed to facet 6. This is precisely the loop Wayfinder's own audit says
was the weak point — so Aegis treats it as first-class, not implicit.

---

### Facet 5 — Risk tier per action (HITL gating via `@aegis/approvals`)

The four-tier model already exists (agentic-platform-design.md §D.4). The contract makes the tier a
**declared, CI-derived property of every tool**, exactly as Wayfinder derives its `OwnerSensitivityTable`
from the manifest's sensitivity metadata and `Validate()` flags a Sensitive-looking tool mistagged
Benign. The tier is *not* a function of model confidence — it is blast-radius, decided by the manifest.

```ts
type RiskTier =
  | 1  // read-only            → autonomous + log
  | 2  // reversible write     → autonomous + log + activity feed
  | 3  // external / notify    → cheap review
  | 4; // irreversible / money → MANDATORY human approval via @aegis/approvals + maker-checker

interface AegisRisk {
  default: RiskTier;                  // derived: GET⇒1, reversible POST/PATCH⇒2, notify⇒3, money/irreversible⇒4
  overrides: Record<string, RiskTier>;// per-tool, curated — e.g. "expense.approve" bumped to 4 above a threshold
  thresholds?: Array<{                // ABAC-style contextual escalation (see RBAC/ABAC in §3)
    tool: string; when: string;       // "amount > 10000" ⇒ escalate tier
    tier: RiskTier;
  }>;
}
```

Enforcement mirrors Wayfinder's gate exactly: the tier check runs *immediately before* the governed core
executes, on **every** resolution path (human API call, chat, voice, event-triggered) — Wayfinder runs
`OwnerVoiceGate.Allow()` before `Invoke()` on both local and phone paths so it can't be bypassed. Tier 4
⇒ the agent **proposes** and pauses on a durable interrupt (`@aegis/approvals` + maker-checker); it never
auto-executes. Fail-safe is **decline-and-ask**, never silent proceed (Wayfinder: Sensitive-tier fail ⇒
DECLINE + ASK). This generalises the workflow engine's existing `runRule(dryRun)` propose pattern.

---

### Facet 6 — Eval/feedback hooks (measured + self-improving — mirror Wayfinder's loop)

Every module declares how its agent behaviour is measured and how it improves. This is the Aegis analogue
of Wayfinder's feedback loop (orb-state + reply-quality) **and** the hardening lesson from their BLOCKER:
verify by *invariant and captured evidence*, not by demo. Wired to Langfuse + Promptfoo (agentic-platform-
design.md §E.10, §H), and — critically — fed by the `learnFrom` events of facet 4.

```ts
interface AegisEval {
  id: string;                         // "expense.categorization_accuracy"
  kind: 'offline' | 'online';         // Promptfoo CI suite | Langfuse LLM-as-judge sampled 1–10%
  dataset?: DatasetRef;               // fixtures (see §4 scaffold) — deterministic, tenant-reset per run
  metric: 'exact' | 'judge' | 'human_agreement';
  gate?: {                            // an autonomy gate: agent may act at tier ≤ X only if metric ≥ threshold
    tier: RiskTier; threshold: number;
  };
  feedbackFrom: string[];             // facet-4 learnFrom events — human override = ground-truth label
}
```

The `gate` is the mechanism agentic-platform-design.md §G calls "continuous production evals gate
higher-autonomy actions": a module's agent earns the right to act autonomously at a tier by *passing its
eval*, and loses it on regression — the machine-enforced version of Wayfinder's promotion discipline
("a runbook fires unattended only after it survives the matching chaos scenario," §5). `feedbackFrom`
closes the loop: every human correction on the audit ledger becomes a labelled example, so the module's
agent behaviour improves from real governed outcomes, not synthetic hope.

---

### Facet 7 — Generative-UI surfaces (declarative)

The agent must be able to *render* — an approval card, a report table, a confirmation dialog — as a
first-class capability, decoupled from the acting core. Wayfinder does this with `show_ai_surface`
(publishes an `AiSurfaceRequestEvent` → a presenter renders it, auto-closes unless input required) and
`requires_input`, which maps *directly* onto an approval request. Aegis uses the declarative,
code-injection-safe layering already chosen (A2UI UI-as-data + AG-UI event transport, agentic-platform-
design.md §C.5), so untrusted/3P modules can render UI **without** injecting executable code.

```ts
interface AegisSurface {
  id: string;                         // "expense.approval_card"
  trigger: 'agent' | 'tool_result';  // agent decides to render, or a tool result renders it
  schema: A2UISpec;                   // UI-as-data (declarative) — never executable code (modular-plan §K)
  requiresInput?: boolean;            // Wayfinder requires_input ⇒ routes to @aegis/approvals (HITL)
  boundTo?: string;                   // the tool/resource whose data populates it
}
```

`requiresInput: true` is the enterprise `requires_input`: the agent **requests human input** (an approval,
a disambiguation) rather than silently proceeding — the same decline-and-ask discipline as facet 5,
expressed as UI. Rendering is decoupled: the agent emits a tool call that publishes a UI event; the
presenter renders; the acting core is untouched (Wayfinder's tool/event-bus decoupling).

---

### Facet 8 — Memory / knowledge contribution (to the self-knowledge RAG)

Every module contributes to the per-tenant self-knowledge index (agentic-platform-design.md §C.4:
pgvector partitioned by `tenant_id`, RLS isolation for free) so the app is its own documentation and can
answer "why did X happen?" This is Wayfinder's generated-from-live-registries `CapabilityManifest` (so
self-knowledge cannot drift) plus its governed memory tools (`remember/recall/forget`, OFF by default,
folded into context via a preamble builder — never an opaque side-channel).

```ts
interface AegisKnowledge {
  docs: DocRef[];                     // module capability docs — embedded into the per-tenant index
  manifestSummary: 'auto';           // GENERATED from this module's tools/intents (drift-proof, Wayfinder)
  auditContribution: {                // what of this module's audit-ledger trail the "why" agent may read
    actions: AuditAction[];           // e.g. "expense.approved", "agent.action.approved"
    scope: 'rls';
  };
  memoryTools?: {                     // governed remember/recall/forget, RLS-scoped to tenant/user
    enabled: boolean;                 // OFF by default (Wayfinder default-off personalization)
    facets: string[];                 // e.g. ["preferred_gl_code", "usual_approver"]
  };
}
```

Machine fields (`manifestSummary`) are generated so they can't drift; `docs` are curated and CI-gated for
completeness (Wayfinder: a card that dangles or a layer without a complete card fails `Validate()`).
`auditContribution` is what makes "why was this allowed / why did this happen?" answerable per module —
the self-knowledge agent RAGs over the hash-chained ledger (`libs/audit`, which already stores
permissions-at-time-of-action) scoped by RLS.

---

### Facet 9 — Guardrails / policies specific to the module

Module-specific safety on top of the platform guardrails (agentic-platform-design.md §D.3: input rails
before tokens, output rails on the producer; NeMo + Guardrails AI). This is Wayfinder's per-tool
sensitivity + `ReflectionVoiceTools`' layered gates (namespace allow-list, per-member allow-list,
blocked destructive verbs, everything try/caught) expressed declaratively.

```ts
interface AegisGuardrails {
  inputRails: RailRef[];              // e.g. block if utterance contains raw card PAN (PCI scope, §J)
  outputRails: RailRef[];             // e.g. never surface another employee's salary in a payroll answer
  allowList?: string[];               // for any generic/reflective tool: explicitly reachable actions only
  blockedVerbs?: string[];            // destructive-verb block (Wayfinder ReflectionVoiceTools discipline)
  dataClass: 'public'|'internal'|'pii'|'phi'|'financial';  // drives residency/encryption (§G) + which rails fire
}
```

Default-deny is the rule (agentic-platform-design.md §D.3 "allow-lists, not deny-lists"): a generic or
reflective tool is reachable only for allow-listed actions, destructive verbs are blocked, and
`dataClass` drives which output rails fire (a `financial`/`phi` module gets stricter leakage rails). The
substrate runs these; the module only declares them.

---

## 3. The contract applied to each existing capability

Each capability below already has governed primitives; the `ai` block turns them into agent surface with
**no new authority**. Concrete, grounded, one row per capability. (Tools generated from routes/Joi/
Permission unless noted; risk tiers per facet 5.)

| Capability | Root-level AI (what the agent gains) | Grounded in existing primitives | Notable tier / guardrail |
|---|---|---|---|
| **RBAC** (`libs/access-control`, `pap.service.ts`) | **NL policy authoring** ("give the Ontario finance team expense-approve up to $5k") → agent emits a *validated policy spec*, not code, applied via `applyPolicyGrant`; **"who can do X / why was this allowed?"** queries via facet-2 context + facet-8 audit RAG; **access-anomaly detection** via facet-4 `learnFrom` on grant/deny events. | PAP `applyPolicyGrant` + `watcher.ts` reload; audit captures permissions-at-time-of-action. | Policy change = **Tier 4** (maker-checker); agent emits a *spec the PAP validates*, never raw Casbin — Wayfinder "emit validated data, never code." |
| **ABAC** | **NL attribute-rule authoring** + **contextual risk escalation** wired to facet-5 `thresholds` ("amount > 10k ⇒ Tier 4"); explain *which attributes* caused an allow/deny. | Casbin ABAC matchers; PDP over tenant + data-class + action-risk. | Attribute rules changing authz = **Tier 4**. Output rail: never leak the *values* of attributes the asker can't see. |
| **Payroll** (`apps/payroll`) | **Agent-run pay-run proposal**: agent assembles the run from RLS-scoped context (facet 2), renders a review surface (facet 7), and **pauses on a Tier-4 durable interrupt**; on approval the *existing* payroll op executes; agent **explains** the run line-by-line from audit. | Existing payroll routes as tools; `@aegis/approvals`; `libs/audit`. | Run payroll = **Tier 4, mandatory** — the canonical "propose, never auto-execute." Output rail: an employee querying payroll sees only their own record (RLS + rail). |
| **Expense** (`apps/expense`) | **Conversational submit** (voice, lift emporio's Whisper pipeline); **auto-categorization / GL coding** proposal (Tier 2, reversible) with eval-gated autonomy (facet 6); **policy-violation explanation**. | Expense routes; approvals for over-threshold; oe_core GL coding to lift. | Submit/tag = **Tier 2** autonomous once `categorization_accuracy` eval ≥ threshold; approve-over-threshold = **Tier 4**. |
| **Invoice** (`apps/invoice`) | **Event-triggered matching**: facet-4 `agentOn: invoice.received → propose invoice.match` (lift oe_core PO-matching); **NL dispute/shortpay handling**; **"why was this invoice held?"** | Invoice routes; oe_core invoice/PO matching, dispute/shortpay (finance crown jewel). | Match = **Tier 2**; approve/pay ≥ threshold = **Tier 4**. LOOKUP match-candidates fed back in a bounded loop before any commit (§5.4). |
| **Workflow** (emporio choreography, oe-connect step machine) | **NL rule authoring** → agent emits a **validated rules-as-data spec** (the SceneSpec analogue: allow-listed nodes + budget caps, validator checks, engine interprets — Wayfinder "generate a workflow ⇒ emit a spec, never code"); **rule-suggestion from event patterns** via facet-4 `learnFrom`. | Rules-as-data workflow engine; `runRule(dryRun)` propose; `TopicManager` choreography. | Authoring a rule that *acts* = **Tier 3/4** by the rule's own blast radius. Validator enforces allow-listed nodes only. |
| **Audit** (`libs/audit`, hash-chained) | **NL forensic query** ("show every Tier-4 action the agent proposed last quarter and who approved it") via facet-8 audit RAG; **tamper-alert** as a facet-4 trigger on chain-verification failure. | Hash-chained append-only ledger; already stores prompt/tool-call trace `agent.*` actions. | All audit reads = **Tier 1** but RLS-scoped and rail-guarded (an asker sees only their tenant's chain). Tamper-alert routes to escalation (§5). |
| **Approvals** (`@aegis/approvals`) | The **HITL substrate for every other module's Tier-4** — the agent *proposes*, approvals enforces maker-checker; agent **drafts the approval rationale** and renders the approval card (facet 7, `requiresInput`). | Approvals engine + SoD/maker-checker; durable interrupts (Temporal/DBOS). | The approval decision itself is always human (Tier 4 by definition). Agent may draft, never decide. |
| **Notifications** (`apps/notification`) | **NL-composed, context-aware notifications** the agent drafts and *proposes to send* (external ⇒ Tier 3); **digest summarization**; emporio/n8n fan-out as the external bridge. | Notification routes; emporio n8n fan-out. | Send external = **Tier 3** (cheap review). Output rail: no PII/financial detail in a channel the recipient isn't cleared for. |
| **Reporting** (`apps/reporting`) | **NL report authoring** ("monthly spend by GL code, flag anything > 20% MoM") → agent proposes a report spec over **CQRS read-views fed by events**; renders a table/dashboard surface (facet 7). | Reporting; CQRS read models (needed for cross-module reporting). | Read/generate = **Tier 1–2**. Reports respect RLS + `dataClass` rails so a report can't aggregate across a boundary the asker can't see. |
| **Connectors** (`libs/connectors`, oe-connect) | **Agent-configured integrations** ("connect our NetSuite, map these fields") → agent walks setup and proposes a *validated connector config* (Saleor-style handshake); **self-healing sync**: facet-4 `agentOn` on a sync-failure/stuck-job event → agent proposes the remediation runbook (retry, refresh creds, replay) bounded by `riskCeiling`. | Connector registry + config-store; oe-connect adapter factory, retry/refresh decorators, stuck-job reconciliation. | Configure = **Tier 3** (external, reviewable). Push-to-ERP = **Tier 4**. Provider **keys never reach the agent** — routed through the connector, mirroring Wayfinder's key-holding gateway. |

Two cross-capability notes:

- **NL authoring everywhere emits validated *data*, never code** — RBAC policy specs, workflow rules-as-
  data, connector configs, report specs. This is the single most load-bearing Wayfinder port ("the LLM
  emits declarative DATA; execution is a separate validated deterministic step") and it is what keeps NL
  authoring inside "the agent reasons; the governed core acts."
- **Self-healing (connectors) and event-triggered proposals (invoice, workflow)** are the module-level
  feed into the platform autonomous loop (§5): a module's `agentOn` remediation proposals are bounded,
  chaos-tested, and promoted to unattended only after surviving the matching failure — the same promotion
  gate as the ops runbooks.

---

## 4. The module scaffold — AI-native on day one

A developer (or an agent — self-serve module authoring is itself a Tier-4 governed capability) runs one
generator. It produces a module whose tools, context, intents, events, evals, and UI **exist by
default**, so AI-nativeness is the starting state, not a later task. This extends the existing
`createService()` / DI bootstrap and the `pep-assertion` route-walk.

```
$ aegis new module billing-recon
  ✓ aegis.module.json          — scaffolded incl. a complete "ai" block (all 9 facets stubbed valid)
  ✓ src/register.ts            — createService() DI bundle (existing pattern; @aegis/approvals proof)
  ✓ src/routes/*.ts            — each route: Joi validator + authorize(Permission)  ⇒ a tool by construction
  ✓ src/context/*.ts           — facet-2 resolvers, each wrapped in withTenantTransaction (RLS by default)
  ✓ ai/intents.yaml            — facet-3 NL intents + utterances (curated; CI-gated for completeness)
  ✓ ai/evals/*.promptfoo.yaml  — facet-6 offline eval suite + a deterministic fixture set
  ✓ ai/surfaces/*.a2ui.json    — facet-7 declarative UI (A2UI; no executable code)
  ✓ migrations/                — module-owned; platform GENERATES the RLS (authors never write it)
  ✓ fixtures/                  — synthetic two-tenant seed for the cross-tenant leak test (§H) + eval datasets
```

What makes each facet exist without author effort:

- **Tools (facet 1) are free.** Because every scaffolded route ships a Joi validator + `authorize()`,
  the `pep-assertion` route-walk + `joi-to-json` + the `Permission` yields the tool registry
  automatically. The author writing a route *is* the author writing a tool — there is no separate step,
  which is the whole point of "structural, not bolted-on." (Wayfinder: a feature ships tools by dropping
  a provider; Aegis: a feature ships tools by having governed routes.)
- **Context (facet 2) is RLS-safe by default** because resolvers are generated wrapped in
  `withTenantTransaction`.
- **Risk tiers (facet 5) default from HTTP verb** and are overridable; a scaffolded EXECUTE route with a
  money/irreversible signal defaults to Tier 4, so a new module is *safe by default*.
- **Evals + fixtures (facet 6) ship a runnable suite and a deterministic two-tenant fixture set** — the
  same fixtures feed the §H cross-tenant leak gate and the Promptfoo eval, so the module is testable and
  isolation-gated from commit one (Wayfinder: self-driving deterministic scenarios, tenant reset per run,
  machine-readable probe reports).
- **`validateAiManifest()` runs in the generator and in CI**: the scaffold's `ai` block is complete by
  construction, and any later edit that leaves a stub description, a dangling intent, or a mistagged risk
  tier fails the merge — the drift gate is on from birth.

**A new module inherits the agent's full surface the instant it merges** — new module ⇒ new governed
tools ⇒ the orchestrator can route to it, the self-knowledge agent can explain it, the eval harness
measures it — with zero core edits, exactly as Wayfinder's `VoiceManager.BuildCatalog()` auto-discovers a
new `IVoiceToolProvider` with no conductor rewrite.

---

## 5. Autonomous dev/ops loop for Aegis

Adopt Wayfinder's autonomous model wholesale — verified at source across two Wayfinder repos — for both
**building Aegis** and **operating Aegis**, wired to the NoOps design already written (agentic-platform-
design.md §F).

### 5.1 The 3-agent development trio (bug-hunt / test / build-continuation)

Wayfinder runs three scheduled Claude Code agents off a shared `CONTEXT.md` + per-role order files, with
strict lane separation. Aegis's Nx TS monorepo maps cleanly:

| Wayfinder role | Aegis role | Mutation lane | Green gate (replaces Unity compile) |
|---|---|---|---|
| Bug-hunter (trace one flow end-to-end, fix safe, log risky) | Traces one governed flow `authenticate→authorize→RLS→audit` per module; fixes safe bugs | `auto/bughunt` branch | `nx affected build+lint+typecheck`, 0 errors, revert-on-red |
| Tester (read-only on product code; honest PASS/FAIL/SKIP/BLOCKED) | Runs the module's e2e against the governed core with a **mock LLM brain**; RLS-scoped reads only | **read-only** | `nx affected test`; distinguishes a real defect from a quota/credential block |
| Build-continuation / impl (finish half-done work to DONE) | Finishes one scaffolded facet/module to complete + eval-green | `auto/impl` branch | full `nx affected build+test+lint` |

Ported guardrails (copy verbatim — agentic-platform-design.md §F autonomous-ops discipline):

- Shared `AGENTS_CONTEXT.md`: module manifest, RLS/Casbin model, event/outbox contract, entitlement
  rules, and **the "agent reasons; core acts" rule** so every autonomous change still flows through
  `authenticate → authorize → RLS → audit`.
- **One mutating agent per repo at a time**; tester is read-only. A **single serial integration lane**
  for anything touching shared schema/RLS/audit (Wayfinder's serial scene/prefab lane).
- **Green `nx affected build+test` is a hard precondition to commit; revert-on-red.** Never push
  main/release; never touch secrets; leave the tree clean each pass.
- **Bounded passes + `JOURNAL.md` resume-pointers** so work survives session/limit refresh; durable
  human-skimmable trackers (`FINDINGS`/`RESULTS`/`PROGRESS`/`DECISIONS`) outside the context window —
  which **pair naturally with the hash-chained audit ledger**: the agents' own action log becomes a
  tamper-evident record.
- **Architectural/ambiguous changes are LOGGED for a human, never auto-applied.**

### 5.2 The continuous E2E loop with self-acquired fixtures

Wayfinder fires a live E2E every 30 min against a real VM, self-acquires inputs (synthesizes audio,
generates fixtures), reports honestly, and stops the billed VM after each pass. Aegis's analogue: an E2E
loop against a **governed test tenant** (real Postgres+RLS, real Casbin policies, connectors in sandbox)
that **self-generates fixtures** (synthetic invoices/expenses/employees with realistic shape and
variance) rather than blocking, keeps the **PASS/FAIL/SKIP/BLOCKED** honesty rule, and feeds failures
straight into the bug-hunter's ledger. Cost guard + teardown are part of the harness (Wayfinder Policy 11
stops the billed VM every pass).

### 5.3 The in-process "governed-core + client-twin" harness

Wayfinder's `WayfinderSim` stands up the real runtime with a mock brain; a JVM "phone twin" speaks the
real wire protocol — full stack, no hardware. Aegis's analogue: an in-process harness that stands up the
governed core with a **mock LLM brain** and asserts the full path `authenticate → authorize → RLS →
audit` per tool, plus a **client twin** that speaks the real API/MCP wire protocol. Scenarios are
self-driving and deterministic (reset tenant fixtures each run, emit a DONE sentinel, write
machine-readable probe reports) so CI and the agents can gate on them.

### 5.4 Test at the seam + runtime invariants (the anti-BLOCKER discipline)

Wayfinder's cautionary tale is a shipped BLOCKER — a tool-result feedback loop that never iterated,
*masked* by a double-execution fallback so demos looked fine. Their own fix: extract a `ToolLoopRunner`,
assert ≥2 gateway calls, and add a runtime guard that a LOOKUP never leaves `resolve()`. Aegis adopts the
principle as a rule: **every new AI seam gets an isolated seam test AND a runtime invariant, so a green
demo can never disguise a dead governed path.** Concretely:

- **`ToolLoopRunner` with a hard iteration cap** (bounded LOOKUP→observe→decide loop, agentic-platform-
  design.md §D.7 loop limits) + a runtime assert that a **`LOOKUP` tool can never terminate as a
  committing action** (facet 1 invariant).
- **`no state change without an audit row`** — a runtime invariant on the acting plane: any module op
  that mutates state and does not write `libs/audit` fails the assertion (the governed-path guarantee,
  verified, not assumed).
- **Seam tests** for each new abstraction: the PEP on the agent path, the RLS scope on a facet-2
  resolver, an approvals node on a Tier-4 tool, a connector self-heal runbook, the tool-loop runner.

### 5.5 Self-operation wiring to the NoOps design

The dev trio's ops sibling is the **AI SRE agent** already specified (agentic-platform-design.md §F): a
Tier-gated Aegis agent over OpenTelemetry + deploy events + the runbook library that auto-triages, posts
a cited hypothesis, then fires a **pre-approved bounded runbook** or escalates with analysis pre-done.
The link to this doc: an ops runbook is *just a module tool* with a risk tier and a `chaos-validated`
promotion gate — **a remediation fires unattended only after it survives the matching injected failure**,
the exact analogue of Wayfinder's rule ("a runbook fires unattended only after it survives the matching
chaos scenario") and of facet-6's eval `gate` (an agent earns a tier by passing its test). Git remains
the only write path to prod; remediation is expressed as a Git/outbox change; the loop closes.

---

## 6. Cross-cutting engine — `@aegis/ai-core`

So modules don't each reinvent the AI plumbing, `@aegis/ai-core` is the shared AI substrate — the "AI
substrate" analog to how `libs/access-control`, `libs/db`, and `libs/events` are shared libs today. A
module `import`s it exactly as it imports the PEP or `withTenantTransaction`; it is the kernel service
the manifest `ai` block plugs into. This is Wayfinder's insight that the tool catalog + governance layer
+ context assembly are **load-bearing shared infrastructure**, not per-feature code.

```
┌─ @aegis/ai-core  (kernel AI substrate; the "agent reasons" plane) ─────────────────────┐
│                                                                                         │
│  Orchestrator            router + specialist subagents; durable (DBOS/Temporal);        │
│                          context isolation via subagents (agentic §C.1)                 │
│                                                                                         │
│  Tool Registry           aggregates every module's facet-1 tools; filtered by           │
│                          entitlement ∩ permission BEFORE the model sees them (§C.3);    │
│                          RAG-over-tools + hierarchical routing. == WayfinderToolCatalog │
│                                                                                         │
│  Context Assembler       generates per-request context from LIVE registries (never      │
│                          hand-written): identity + entitled tools + RLS-scoped facet-2   │
│                          state + focus context + strict tool-step JSON contract +        │
│                          audit history. == Wayfinder BuildSystemPrompt / SendVoiceContext│
│                                                                                         │
│  Capability Manifest     per-tenant, generated from module registry + Entitlement Svc +  │
│                          Casbin scope; can_i()/capability_check() decline-and-redirect;  │
│                          validateAiManifest() = merge-blocking drift gate.               │
│                          == Wayfinder CapabilityManifest + Validate()                    │
│                                                                                         │
│  LLM Gateway             LiteLLM behind a key-holding BFF; tool defs pass through         │
│                          verbatim, tool-CALL relays back, execution stays in the          │
│                          governed core; per-tenant budgets/cost/fallback/cache.          │
│                          == Wayfinder AI Gateway (reasoning plane ≠ acting plane)         │
│                                                                                         │
│  Eval Harness            Langfuse (online, sampled judge) + Promptfoo (offline CI);      │
│                          runs every module's facet-6 suites; owns the autonomy gate.     │
│                                                                                         │
│  Memory / RAG            pgvector partitioned by tenant_id (RLS free); ingests every      │
│                          module's facet-8 knowledge; governed remember/recall/forget.    │
│                                                                                         │
│  Guardrails              NeMo + Guardrails AI; runs every module's facet-9 rails;         │
│                          input-before-tokens, output-on-producer; allow-list/verb-block. │
│                                                                                         │
│  Tool-Loop Runner        bounded LOOKUP→observe→decide + the §5.4 runtime invariants.    │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                   │ every EXECUTE flows down into ▼
                        ┌─ the DETERMINISTIC governed core (unchanged) ─┐
                        │ authenticate → authorize(PEP) → RLS → audit    │
                        └────────────────────────────────────────────────┘
```

Design invariants of the substrate:

- **The substrate is the reasoning plane; it holds no authority.** Every EXECUTE it proposes goes down
  into the unchanged governed core. `@aegis/ai-core` can be swapped brain-first (provider, even offline
  degraded mode) without touching a single module or the PEP/RLS/audit path — Wayfinder's "intelligence
  is pluggable, the contract + governance are constant."
- **Modules declare (the `ai` block); the substrate operates.** A module never talks to an LLM directly
  and never holds a provider key (mirrors connectors never holding keys, §3). It declares tools/context/
  intents/evals/rails; `@aegis/ai-core` aggregates, filters, assembles, gates, and executes-via-core.
- **`requiredAiCore` in the manifest pins the substrate contract** exactly as `requiredKernel` pins the
  host contract — so the substrate can evolve additively without breaking installed modules (modular-plan
  §E versioning discipline).

---

## 7. Migration — retrofit to the contract incrementally, no rewrite

The contract is designed to be **additive** — the same property that made the modular manifest additive
(modular-plan §E: additive evolution only, `requiredKernel` pins compat). Nothing here is a rewrite;
every step lights up more agent surface over already-governed code. Sequenced onto the existing NOW/NEXT/
LATER roadmap (agentic-platform-design.md §J).

**Phase 0 — the substrate exists but demands nothing yet (NOW).**
Stand up `@aegis/ai-core` (§6) and generate the tool registry from the *existing* `pep-assertion`
route-walk + Joi + Permission (agentic-platform-design.md §J NOW: "auto-generated tool registry"). At
this point **every existing module already has facet-1 tools for free**, because they already have
governed routes — no module edits. The `ai` block is *optional* in this phase; `validateAiManifest()`
runs in **shadow mode** (logs incompleteness, blocks nothing), mirroring the modular-plan §P dark-launch
discipline for the gateway entitlement check.

**Phase 1 — backfill the cheap facets, still additive (NOW→NEXT).**
For each module, generate the machine-derivable facets (tools done; facet-2 context resolvers wrapped in
`withTenantTransaction`; facet-8 `manifestSummary`) and curate the human ones (facet-3 intents, facet-1
descriptions). This is a per-module PR, not a rewrite. Wire facet-5 risk tiers by deriving defaults from
HTTP verb and curating the Tier-4 overrides (payroll-run, invoice-approve-over-threshold, ERP-push, any
policy change) — which immediately makes the agent path safe for that module.

**Phase 2 — flip the gate on, module by module (NEXT).**
Once a module's `ai` block is complete, flip `validateAiManifest()` from shadow to **enforce for that
module** (per-module, like the modular-plan's per-module entitlement flip). From then on that module
cannot merge a change that drops a tool description, dangles an intent, or mistags a risk tier — the drift
gate is live. New modules (§4 scaffold) are born enforced.

**Phase 3 — light up the loops (NEXT→LATER).**
Add facet-4 triggers (event → agent proposals, bounded by `riskCeiling`) and facet-6 eval gates so
modules earn autonomy at a tier by passing evals; add facet-7 surfaces and facet-9 module rails. Stand up
the 3-agent dev trio (§5.1) and the E2E loop (§5.2) against the governed test tenant. Promote per-module
self-heal/remediation proposals to unattended only after they survive the matching chaos scenario (§5.5).

**Ordering rule (from the modular-plan grant-order lesson, §F):** for any module, land **tools →
context → risk tiers** (safe surface) *before* **triggers → eval-gated autonomy** (active behaviour) —
never let an event-triggered agent act on a module whose risk tiers aren't yet declared. This is the
retrofit analogue of "grant permissions only after migrations finish."

**What never changes during migration:** the governed core (`authenticate → authorize(PEP) → RLS →
audit`), the module's routes, and its data. The retrofit only *declares* what the agent may reason over
and propose against — it adds surface, never authority. That is the whole contract, restated as the
migration's safety guarantee.

---

*Drafted as the third strategy pillar, on top of the agentic-platform design (the governed agent) and the
modular-platform plan (the module manifest + Entitlement Service). The load-bearing bet: making AI a
structural property via a mandatory manifest `ai` block + a `@aegis/ai-core` substrate + a merge-blocking
`validateAiManifest()` gate is the same move that made isolation and authorization structural — and it is
the move Wayfinder validates in a shipping agentic product (tool catalog as the stable contract,
self-registration, generated-and-gated capability manifest, reasoning-plane/acting-plane split, 3-agent
autonomous harness), including the cautionary lesson that a green demo must never substitute for a runtime
invariant. Re-confirm provider/tooling choices against agentic-platform-design.md §H at build time.*

---

## 8. Red-team (authoritative correction — supersedes §2's "all nine mandatory")

A skeptical principal-engineer review of §1–§7. **Verdict:** *"AI in every module from the root" as an
absolute nine-facet mandate is the wrong framing; the instinct is right if narrowed to a structural
tool+tier minimum, with everything else opt-in, and the tier/referent/principal decisions nailed to the
deterministic core in code — not prose.* §0.5 is the actionable distillation; the full findings:

### 8.1 Over-engineering risks
- **Mandating all nine facets** makes authors write **stub facets to satisfy `validateAiManifest()`** —
  the exact "stub that passes Validate()" failure the doc claims to prevent. Why does read-only
  `libs/audit` (Tier-1) need generative-UI, `learnFrom` loops, or destructive-verb blocklists? A
  hash-chain tamper alert is a deterministic cron check, not an agent trigger.
- **"Tools are free / 90% built" is overstated.** `pep-assertion.ts` today extracts only method+path (to
  find *unguarded* routes); it does **not** extract the Joi validator or the `Permission`. Turning it
  into a tool generator that emits inputSchema+permission+entitlement is **net-new work**, and
  `joi-to-json` is **not** a repo dependency. There's no story for routes that don't cleanly become tools
  (file uploads, streaming, custom-middleware validation).
- **NL authoring as a facet for RBAC/ABAC/workflow/connectors/reporting = five separate
  NL→validated-spec compilers**, each needing a grammar, validator, and eval suite. For low-frequency
  admin actions (you write a Casbin rule rarely), a **deterministic form + dry-run preview is cheaper,
  safer, and more predictable** than an LLM emitting a spec a human must fully re-verify anyway.
- **Eval gates on every module** imply an offline Promptfoo suite + online Langfuse judge + labelled
  dataset from day one — the harness cost dwarfs the value for a Tier-1-lookup module. Gate autonomy only
  where autonomy is granted (Tier ≥ 2).
- **The 3-agent dev trio + 30-min E2E loop** are a second product borrowed wholesale from a solo AR app;
  a mutating agent on `auto/impl` touching shared RLS/audit schema is a large standing risk without
  headcount to babysit it.

### 8.2 Cost / latency risks
- **Context assembly "from live registries every turn"** (identity + entitled tools + RLS-scoped state +
  focus + audit history) is DB + policy work *per token-round* — the dominant latency/cost driver — and
  the doc gives **no token budget, cache TTL, or tool-count ceiling**.
- **Mandating tools on every module *manufactures* the too-many-tools problem** that RAG-over-tools then
  spends a subsystem solving. Fewer modules exposing tools ⇒ smaller catalog ⇒ cheaper routing.
- **Online judge (Facet 6) + pgvector self-knowledge (Facet 8) cost scale with module × tenant count, not
  with realized usage** — you pay to embed/judge modules whose agent path is never exercised.
- Durable orchestrator + tool-loop runner + input/output guardrail rails in the hot path add fixed
  per-interaction latency in front of what could be a direct governed query for a Tier-1 lookup.

### 8.3 Determinism conflicts (the authority-leak risks)
- **Facet-5 thresholds** (`amount > 10000 ⇒ Tier 4`) MUST be computed by the deterministic PDP from the
  request. If assembled/interpreted in the AI substrate, an LLM-influenced path decides whether human
  approval is required. The doc *asserts* "tier decided by manifest not model," but the enforcement point
  isn't nailed to the PDP **in code**.
- **Facet-2 focus context** ("approve *this*") puts deictic resolution in the reasoning plane; a
  mis-resolved referent feeding a Tier-4 execute pays the wrong invoice. The referent must be echoed in
  the approval card and re-validated by the core.
- **Generic/reflective tools** ("update field X on record Y") are the classic bypass vector — in a
  financial core they must be **default-absent**, not default-present-with-guards.
- **"AI in the core of every module" vs "AI at the edges"** is a real tension the doc papers over.
  Mandating an `ai` block invites module-local agent code that erodes the "agent only ever hits the same
  HTTP-equivalent route a human hits" boundary. The **edge-only model preserves that boundary
  structurally**; the in-core model relies on discipline the CI gate can't fully check. → mitigations in
  §0.5.
- **Event-triggered `agentOn` agents** that propose Tier-4 actions still make an ungoverned
  decision-*to-propose* in a money path; unbounded, this surfaces as **approval fatigue** (humans
  rubber-stamping a flood) — an erosion of maker-checker in practice.

### 8.4 Missing (add before building)
- **No cost/latency budget** anywhere (per-tenant token ceiling, prompt tool-count cap, context-assembly
  caching, target p95 for an agent turn) — the biggest omission for a design whose central move
  multiplies the catalog and per-turn context.
- **No prompt-injection threat model** for context/RAG fed by untrusted tenant data (invoice memos,
  expense notes, connector payloads) — critical for finance; generic NeMo rails don't address it.
- **No approval-fatigue controls** (proposal rate limits, batching, confidence suppression).
- **No per-module agent kill-switch / prod circuit-breaker** independent of redeploy; no action when an
  eval regresses in prod.
- **No explicit "LLM output never carries principal/tenant/permission; the call re-derives them
  server-side"** invariant.
- **No PII/residency/erasure story** for embedding financial content into the self-knowledge RAG beyond
  "RLS-scoped."

### 8.5 The minimal viable contract (the build target)
Required everywhere: **Facet 1 (tools) + Facet 5 (risk tier, money⇒Tier 4).** Required for Tier ≥ 2
modules: **Facet 6 (eval gate).** Everything else **opt-in**. Gate = governance-on-declared-tools, not
completeness-of-nine. Keep the LLM strictly at the **edge**; tier/referent/principal decisions live in
the PDP / approval-card echo-back / server-side derivation. Generic reflective tools default-absent. Add
the cost budget, injection threat model, and approval-fatigue controls first. `@aegis/ai-core`, the tool
registry, and the `Validate()` CI gate stay as designed — only the per-module *mandate* shrinks.
