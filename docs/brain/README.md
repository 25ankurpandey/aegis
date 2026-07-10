# 🧠 The Aegis Dev Brain — Memory Map

> **This folder is the second memory of the Aegis project.** Any new or parallel agent (or human)
> gets full context here with **zero re-explanation**: what we're building, every decision made, what
> happened in every working session, where we are now, and what's next.
>
> **Last updated:** 2026-07-10 (T32) · Maintained by every agent that works on this repo (see Update Protocol).

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

> ⚠️ This is only a pointer — **the authoritative, always-current state is [`STATE.md`](STATE.md).**
> Read that, not this summary. This blurb is refreshed occasionally; STATE is refreshed every session.

- **Phase:** design COMPLETE; **BUILD well underway** on branch `feat/agentic-platform` (pushed to the
  founder's personal GitHub), on **real infra** (live pgvector Postgres + Redis).
- **Built & green (through T32):** the full read-only/propose/human-supervised agentic layer — the
  authz-bound tool-registry generator, per-principal filter, tool-server + MCP transport, orchestrator +
  **multi-LLM gateway**, the **danger/HITL layer** and **independent-verifier / hardened Trust Rule**
  (the D19 supervised-write milestone), the running propose→confirm broker, **conversation + agent
  memory** (the Wayfinder port: supersede/soft-invalidation/tiered recall/mem0 extraction, per-user
  scoped), the **pgvector app-brain** (self-knowledge RAG, indexed online), the **module entitlement**
  loop (`tenant_modules` + Chargebee ingestion), **ABAC Phase 0/1** (persisted-policy mapper + ports +
  DB loader), the **RECONCILIATION** capability (deterministic checks → verified propose-only findings →
  app-brain; runner + `--all` sweep + HTTP surface), and the **generative-UI renderer + interactive host**
  (T31/T32 — the agent loop is visible AND clickable in a browser, wired to the governed `/_ai/act` flow).
  Totals: ai-core 201/201, db 99/99 (live), access-control 126/126; ~870 across 9 projects; strict typechecks clean.
- **Security audited + FULLY remediated (T25→T28):** the RBAC/ABAC/scope/RLS/agent/memory fence was
  adversarially audited → [`../strategy/security-model.md`](../strategy/security-model.md) +
  [`../strategy/security-findings.md`](../strategy/security-findings.md). Tenant isolation is a hard,
  live-verified guarantee; **all 16 within-tenant findings are now remediated + regression-gated**
  (`row-scope-gate.spec.ts`) — the user/team fence enforces off the signed scope claim, fail-closed; the
  amount-cap enforces; memory is per-user isolated.
- **Still GATED:** fully-autonomous (no-human) money writes per D19; products/AR/omniscience per D20;
  founder decisions in [`discussions/README.md`](discussions/README.md) (O1–O8).
- **Known blocker:** session usage limits interrupt long workflows — resume via cached `resumeFromRunId`.

## Folder layout

```
docs/brain/
├── README.md            ← you are here — the memory map
├── RESOLVER.md          ← "if you need X, go here" routing table (start here when unsure)
├── STATE.md             ← canonical current state (what's done / in progress / next)
├── PROGRESS.md          ← the standing morning-briefing (narrative: everything imagined/built/left)
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
