# 🧠 The Aegis Dev Brain — Memory Map

> **This folder is the second memory of the Aegis project.** Any new or parallel agent (or human)
> gets full context here with **zero re-explanation**: what we're building, every decision made, what
> happened in every working session, where we are now, and what's next.
>
> **Last updated:** 2026-07-02 · Maintained by every agent that works on this repo (see Update Protocol).

---

## Navigation protocol (follow this order — do not skip ahead)

1. **This file** — orientation + current state (below).
2. **The targeted folder for your need** — go directly to the specific doc:
   - Need standing rules / how the founder wants things done? → [`instructions/`](instructions/README.md)
   - Need a design (what we decided to build + how)? → [`designs/`](designs/README.md)
   - Need a decision + its rationale, or open questions? → [`discussions/`](discussions/README.md)
   - Need the architecture (principles, gates, contracts, stack)? → [`architectures/`](architectures/README.md)
3. **[`../../ONBOARDING.md`](../../ONBOARDING.md)** — the narrative full-context onboarding (repo root).
4. **[`AUDIT_LOG.md`](AUDIT_LOG.md)** — the append-only conversation/decision log. **Fallback only** —
   consult it when the targeted docs don't answer your question, or you need the exact history of an ask.

**Anti-hallucination rule:** answer from these docs (cite the file) or say you don't know and check the
audit log / the code. Never invent project history or decisions.

---

## Current state (update this section every session)

> **Canonical current state now lives in [`STATE.md`](STATE.md)** (single-writer). Quick summary below.

- **Phase:** research + design; **NO implementation yet** (explicit founder instruction — dense,
  gap-free docs first; other agents implement from them).
- **Done (2026-07-02):** ALL nine strategy docs written — `modular-platform-plan`, `agentic-platform-design`,
  `ai-native-core`, `yc-rfs-fit`, `agentic-operations` (859 ln), `platform-omniscience`,
  `stack-sufficiency`, `knowledge-brain`, `ecosystem-ar-protocol`, `agentify-and-policing`. See
  [`designs/README.md`](designs/README.md) for statuses.
- **Design phase COMPLETE (2026-07-02):** all nine strategy docs written AND adversarially red-teamed.
  The master synthesis is [`../strategy/red-team-consolidated.md`](../strategy/red-team-consolidated.md)
  — **read it before any implementation** (16-item fix-before-build list, "build FIRST" slice, "do NOT
  build until X" table). Decisions D18/D19/D20 capture the safe build sequence.
- **BUILD STARTED (T14, 2026-07-02).** The keystone — the **authz-bound tool-registry generator** — is
  built and prototyped GREEN: metadata stamping in `service-core` (`route-metadata.ts`; `authorize()`
  and `validate()` now stamp permission + schema) + the new **`libs/ai-core`** lib
  (`generateToolRegistry` + dependency-free Joi→JSON-Schema). `nx test ai-core` 6/6; 147 existing lib
  tests still pass; strict typecheck clean. Proves self-sustainability (D15) — a new guarded route
  becomes an agent tool with zero wiring. This is the read-only slice of D18; touches none of the
  D19-gated write planes.
- **Next increments (open):** (a) `filterToolsForPrincipal` — entitlement+permission pre-filter of the
  registry; (b) wire the generator into a service bootstrap to expose the registry (diagnostic endpoint /
  MCP server — MCP SDK needs `npm i`); (c) tool descriptions from the module manifest; (d) brain Phase-0
  scaffolding (STATE.md/RESOLVER.md/log/). Write-autonomy on money remains GATED per D19; sell-the-
  substrate products per D20.
- **Known blockers:** session usage limits interrupt long workflows (resume via cached
  `resumeFromRunId`); founder decisions pending in [`discussions/README.md`](discussions/README.md)
  (O1–O8), esp. O4 "when do we flip to build?".

## Folder layout

```
docs/brain/
├── README.md            ← you are here — the memory map
├── RESOLVER.md          ← "if you need X, go here" routing table (start here when unsure)
├── STATE.md             ← canonical current state (what's done / in progress / next)
├── AUDIT_LOG.md         ← append-only log of every working session/ask/outcome (fallback source)
├── instructions/        ← standing founder directives — the project "constitution"
├── designs/             ← index of all design docs + their status
├── discussions/         ← decisions made (with rationale) + open questions
└── architectures/       ← the architecture atlas — principles, gates, contracts, stack picks
```

**New here?** The exhaustive master is [`/CONTEXT.md`](../../CONTEXT.md); when unsure where to look, use
[`RESOLVER.md`](RESOLVER.md); for current status read [`STATE.md`](STATE.md).

The heavy design content lives in [`../strategy/`](../strategy/) — this brain is the **navigation +
decision-capture layer** over it, so agents find the right doc instead of re-deriving or hallucinating.

## Update protocol (every agent MUST follow)

1. **At session end (or major milestone):** append an entry to `AUDIT_LOG.md` — date, the ask (near
   verbatim), what was done, conclusions, artifacts (paths), open items. Never rewrite old entries.
2. **New decision made?** Add a row to `discussions/README.md` (decision, rationale, date, audit ref).
3. **New design doc?** Add a row to `designs/README.md` with status (draft / red-teamed / final).
4. **New standing instruction from the founder?** Add it to `instructions/README.md`.
5. **Architecture changed?** Update `architectures/README.md` and the affected strategy doc.
6. **Always refresh the "Current state" section above** — it's the first thing the next agent reads.
7. Keep `../../ONBOARDING.md` consistent (it links here; it is the narrative twin of this map).
