# Aegis Knowledge Brain — the Dev-Process Brain and the App/Platform Brain

> **Status:** Design, implementation-ready. **Date:** 2026-07-02 (validated + refined on a later same-day pass: reconciled with the now-existing `docs/brain/` skeleton §3.1.1; added GBrain reference architecture + hybrid pgvector/BM25/RRF retrieval §1.2.1, §4.5). **Track:** 3 (Second Brain / Knowledge Infrastructure).
> **Companions:** [`agentic-platform-design.md`](agentic-platform-design.md) (§C.4 self-knowledge, §C.7 conversation memory),
> [`ai-native-core.md`](ai-native-core.md) (§0.5 minimal viable contract, Facet 8 knowledge contribution, §8 red-team).
> Where this doc and those disagree on substrate (RLS, PDP, audit), those docs win; where they are silent on knowledge
> layout, this doc is authoritative.

---

## 0. TL;DR — the decisions

| Question | Decision |
|---|---|
| How many brains? | **Two, deliberately separate.** Dev-Process Brain (for agents *building* Aegis) and App/Platform Brain (for agents *running inside* Aegis). Different trust models, different storage, different update cadence. They share one discipline: **targeted docs first, fallback second, cite-or-abstain always.** |
| Where does the Dev Brain live? | **In the repo, committed to git**, at `docs/brain/`. Plain markdown + YAML frontmatter + wikilinks. Git *is* the version history, the multi-writer merge engine, and the audit trail. No Notion, no external SaaS. |
| Where does the App Brain live? | **Two tiers.** Platform tier: files in the repo (curated runbooks/skills + **generated** capability manifests), embedded into pgvector at deploy. Tenant tier: rows in Postgres (`knowledge_items` + pgvector), **RLS-scoped by `tenant_id`**, versioned, written only through governed tools. |
| Format? | Markdown + YAML frontmatter + `[[wikilinks]]` for both brains' file-shaped knowledge; `SKILL.md`-style progressive disclosure (Anthropic Agent Skills spec) for executable runtime knowledge; JSON only for machine-generated manifests. |
| How kept current? | Dev Brain: a mandatory **session-close protocol** enforced by Claude Code `SessionEnd`/`Stop` hooks + a CI **link-and-freshness audit** (Tan's `check-resolvable` pattern). App Brain: **generated from live registries** (route-walk tool registry + `CapabilityManifest`), re-embedded on merge via content-hash diff — the Wayfinder drift-proof pattern, so it *cannot* be stale by construction. |
| How do agents query? | **Deterministic first, probabilistic second.** Grep/read targeted docs (Dev) or manifest/skill lookup (App) → only then **hybrid retrieval** (pgvector + BM25 merged via reciprocal rank fusion — the GBrain technique, §1.2.1, ~+31pt P@5 vs vector-only, pure SQL) → if neither yields a citable source, **abstain and say so**. |
| Concurrency? | Blackboard rules: append-only per-session log files (no shared-file contention), one single-writer `STATE.md` per repo updated only at session close, git merge as the arbiter, `flock` on the log index. |
| "Blackboard.io RCLE"? | **Does not exist as a product** (verified by multiple searches, §1.3). The founder almost certainly means the **blackboard architectural pattern**. The real, adoptable artifacts are the pattern itself, the bMAS/arXiv work, and open-source repos like `claudioed/agent-blackboard`. |

---

## 1. Research findings (internet-first, with sources)

### 1.1 The Obsidian + Claude Code "second brain" pattern

Fetched and analyzed: <https://www.mindstudio.ai/blog/build-ai-second-brain-claude-code-obsidian>.

What the pattern actually is:

- **A local markdown vault as the substrate**, seven folders: `Inbox/` (raw capture), `Projects/`, `Areas/`, `Resources/`, `Archive/`, `AI/` (agent outputs + session logs), `Templates/`. This is PARA (Projects/Areas/Resources/Archive) plus two agent-specific folders.
- **Claude Code run *inside* the vault directory** — no plugin, no server. The agent reads/writes markdown directly. Filesystem access is the integration.
- **YAML frontmatter on every note** (`created`, `tags`, `status`, `related`) and **Obsidian `[[wikilinks]]`** in a `related` field so the agent can *follow links* instead of searching blindly.
- **A `CLAUDE.md` "constitution" at vault root**: personal context, vault map, session protocols.
- **Continuity via session logs**: every session ends by writing a summary to `/AI/sessions/` ("what was discussed, decisions made, outstanding items"); every session starts by reading recent logs. This is exactly the founder's "know what we did yesterday" requirement, proven in the wild.
- Key workflows: inbox processing, weekly review (synthesize completed work / open loops / stale projects), research synthesis into `Resources/` with links to existing notes.

**Verdict: adopt the pattern wholesale for the Dev Brain, drop Obsidian-the-app.** Aegis agents don't need a GUI; they need the *conventions* (markdown + frontmatter + wikilinks + session logs + constitution). The vault is just a git-committed folder. Obsidian remains optionally usable by the human founder on the same folder for free — wikilinks render, graph view works — which is a nice zero-cost bonus, not a dependency.

### 1.2 Agent memory systems — what to adopt vs build

Surveyed (sources: [Mem0 vs Letta, vectorize.io](https://vectorize.io/articles/mem0-vs-letta); [5-system comparison, Medium/Wasowski](https://medium.com/@wasowski.jarek/i-compared-5-ai-agent-memory-systems-across-6-dimensions-none-wins-6a658335ed0a); [AgentMarketCap vendor landscape 2026](https://agentmarketcap.ai/blog/2026/04/10/agent-memory-vendor-landscape-2026-letta-zep-mem0-langmem); [particula.tech benchmarks](https://particula.tech/blog/agent-memory-frameworks-tested-mem0-zep-letta-cognee-2026)):

| System | What it is | Fit for Aegis |
|---|---|---|
| **Letta (MemGPT)** — <https://github.com/letta-ai/letta>, Apache-2.0 | Full agent *runtime* with OS-inspired memory tiers: core memory (in-context, "RAM"), recall memory (searchable history), archival memory (cold store). | ❌ **Reject as dependency.** It's a competing runtime, not a library — adopting it means running agents *inside Letta*, which breaks "the governed core acts" (memory writes would bypass our PEP/audit). ✅ **Adopt the tier model conceptually**: Aegis conversation state (§C.7) = core; audit ledger = recall; pgvector knowledge = archival. |
| **Mem0** — <https://github.com/mem0ai/mem0>, Apache-2.0, largest community (~47k stars) | Framework-agnostic memory layer: LLM-based extraction of facts from conversations into vector+graph+KV stores, with `add/search` API. | ⚠️ **Partial adopt.** The *extraction* idea (LLM distills durable facts from conversations, deduplicates, updates) is worth borrowing for tenant memory. But Mem0 wants to own storage; Aegis must own storage (RLS, audit, residency). Verdict: **build a thin governed equivalent on pgvector** (~500 LOC: extract-candidate-facts prompt + upsert through a governed tool), optionally vendoring Mem0's extraction prompts. Re-evaluate Mem0-as-library (self-hosted, Postgres backend) at Phase 3 if extraction quality disappoints. |
| **Zep / Graphiti** — <https://github.com/getzep/graphiti>, Apache-2.0 | Temporal knowledge graph: every fact edge carries `valid_at`/`invalid_at`; best-in-class on temporal reasoning (94.8% DMR per their benchmarks). | ⚠️ **Not now.** Temporal facts matter for Aegis ("who was the approver *in March*?") — but the **hash-chained audit ledger already is our temporal ground truth**, and it's deterministic, which beats a probabilistic KG for a governance platform. Revisit Graphiti if/when we need cross-entity inference over history. |
| **LangMem** — LangChain, MIT | Episodic/semantic/procedural memory for LangGraph; notable for *procedural* memory (agents updating their own instructions). | ❌ Framework-locked to LangGraph. The **procedural-memory idea** (agent proposes edits to its own runbooks, human approves) is adopted in §4.6 — through maker-checker, naturally. |
| **Claude Code CLAUDE.md / auto-memory** — <https://code.claude.com/docs/en/memory> | Hierarchical instruction files (enterprise → user → project; nearest file wins; child-dir files load on demand), `@path` imports, agent-written auto-memory. Best practice: files ≤ ~200 lines, don't duplicate rules vs learned notes. | ✅ **Adopt directly for the Dev Brain** — this is the loading mechanism our dev agents already have. `CLAUDE.md`/`AGENTS.md` at root stays thin and *points into* `docs/brain/`. |
| **AGENTS.md standard** — <https://agents.md/>, [Linux Foundation-stewarded, 20k+ repos](https://www.infoq.com/news/2025/08/agents-md/) | Open "README for agents" format; monorepo-aware (nearest-file precedence per package). | ✅ **Adopt.** Aegis already has a root `AGENTS.md`. Extend the pattern: per-service `AGENTS.md` stubs in `apps/*` that point into the brain. Keeps us compatible with Codex/Cursor/Devin/Jules, not just Claude. |
| **llms.txt** — <https://llmstxt.org/> | `/llms.txt` markdown index telling LLMs where the important docs are on a website. | ✅ **Adopt for the App Brain's public face**: serve a generated `/llms.txt` (and `/.well-known/`) from the gateway listing module capabilities/docs — cheap, standard, and doubles as the agent-facing sitemap for external MCP clients. |

#### 1.2.1 GBrain — the production reference implementation of exactly this architecture (new, 2026)

Discovered on a later research pass and worth calling out separately because it is the single closest external validation of the App Brain design: **GBrain** by Garry Tan (YC president), open-sourced ~April–May 2026, **MIT** — repo <https://github.com/garrytan/gbrain>, docs [GBRAIN_V0](https://github.com/garrytan/gbrain/blob/master/docs/GBRAIN_V0.md) + [company-brain tutorial](https://github.com/garrytan/gbrain/blob/master/docs/tutorials/company-brain.md); analyses: [vectorize.io "What is GBrain"](https://vectorize.io/articles/what-is-gbrain), [DeepWiki](https://deepwiki.com/garrytan/gbrain), [MarkTechPost tutorial](https://www.marktechpost.com/2026/05/22/a-step-by-step-coding-tutorial-to-implement-gbrain-the-self-wiring-memory-layer-built-by-y-combinators-garry-tan-for-ai-agents/).

What it is, and why it matters here:

- **Architecture = this doc's App Brain, shipped:** knowledge lives in a **git repo of markdown files** (the "brain repo") that the operator owns and the agent reads/writes; GBrain **syncs the repo into Postgres for retrieval**; **git deletes become soft-deletes in the DB.** That is precisely §4's "files as the authoring/build format, Postgres+pgvector as the retrieval index, versioned (`is_current=false`) not hard-deleted" — independently arrived at by YC's president for his own production agents. Strong signal the design is right.
- **Retrieval = hybrid, and better than plain vector:** Postgres + pgvector (or zero-config PGLite) with **hybrid search — vector similarity (HNSW) + keyword (BM25) merged via reciprocal rank fusion (RRF)** — plus an **auto-wired typed knowledge graph built with zero LLM calls** (deterministic entity extraction). Their BrainBench numbers: P@5 49.1% / R@5 97.9%, a **+31.4-point P@5 lead from the graph layer** over the same code with the graph off. **Adopt the hybrid+RRF retrieval and the deterministic auto-linking** into our query path (§4.5) — it is a concrete, measured upgrade over vector-only RAG, and RRF over pgvector+BM25 is a few dozen lines of SQL, no new dependency. The zero-LLM graph extraction also sidesteps the injection/cost concerns of LLM-based graph building.
- **Scale proof:** the production brain behind Tan's agents holds ~146k pages / 24.5k people / 5.3k companies / 66 cron jobs — evidence a git-markdown-over-Postgres brain scales to real corpora, answering the founder's "how do they scale" directly with a live datapoint.
- **Verdict:** ✅ **Adopt as the reference architecture and vendor the retrieval technique** (hybrid pgvector+BM25+RRF, git→soft-delete sync). ❌ **Do not adopt GBrain as a running service** — it owns its own Postgres and sync loop, which would bypass our RLS/PEP/audit for tenant-tier writes (same reason we reject Letta-as-runtime, §1.2). We reimplement its *technique* on our governed Postgres so every write still passes the four gates. Related open-source siblings for reference: [agno-agi/scout](https://github.com/agno-agi/scout) (open-source "company brain") and [garrytan/gbrain] itself; both confirm the git-markdown-brain convergence.

### 1.3 The blackboard pattern — and the honest answer on "Blackboard.io RCLE"

**"Blackboard.io RCLE" does not exist.** Two targeted searches (`"Blackboard.io" RCLE agent knowledge product`; `"RCLE" blackboard agent memory recursive`) surface no such product, company, or paper. What exists under adjacent names: **Blackboard by Anthology** (the LMS — unrelated), the getguru.com SEO page "Blackboard AI Agent" (about the LMS), and the architectural pattern below. Most likely the founder heard a talk/thread describing the **blackboard architectural pattern for multi-agent systems** and a garbled acronym. If "RCLE" meant a loop like *Read-Contribute-Learn-Evaluate*, that is exactly the canonical blackboard control cycle. **Recommendation: build the pattern, stop looking for the product.**

The real pattern ([Wikipedia](https://en.wikipedia.org/wiki/Blackboard_system); [bMAS, arXiv:2507.01701](https://arxiv.org/abs/2507.01701); [Denis Petelin on MCP + blackboard](https://medium.com/@dp2580/building-intelligent-multi-agent-systems-with-mcps-and-the-blackboard-pattern-to-build-systems-a454705d5672); [muthu.co engineering notes](https://notes.muthu.co/2025/10/collaborative-problem-solving-in-multi-agent-systems-with-the-blackboard-architecture/); example repo [claudioed/agent-blackboard](https://github.com/claudioed/agent-blackboard)):

- A **shared workspace** (the blackboard) that specialist knowledge sources read from and write to; agents never talk to each other directly — **the blackboard is the only channel**.
- A **control component** selects which agent acts next based on current blackboard state; the loop repeats until consensus/solution.
- arXiv:2507.01701 shows LLM-agent blackboards reach SOTA-competitive quality **with fewer tokens** than message-passing swarms, because shared state replaces N×N re-explanation — precisely the founder's "zero re-explanation" goal.

**Application here:** the Dev Brain **is** a blackboard — a git-versioned one. `STATE.md` is the control surface (what's in flight, what's next), session logs are agent contributions, and git merge is the consistency mechanism. §3.6 gives the concrete write rules.

### 1.4 Anthropic Agent Skills + the YC "Company Brain"

- **Agent Skills / SKILL.md** ([Anthropic engineering](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills); [platform docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview); [open spec](https://agentskills.io/home)): a skill = a directory with `SKILL.md` (YAML frontmatter: `name`, `description`; markdown body; optional `scripts/`, `references/`, `assets/`). The load model is **progressive disclosure** in three stages — (1) at startup only name+description are in context, (2) full SKILL.md loads when the task matches, (3) referenced files/scripts load only during execution. This is the single most important scaling idea in this doc: **context is the scarce resource; knowledge stays on disk until provably needed.**
- **YC "Company Brain" RFS** (Summer 2026, entry by Tom Blomfield — <https://www.ycombinator.com/rfs>): the ask is *not* "chatbot over documents" but an **executable skills file** — "a living map of how the company works… structured knowledge an AI agent can act on, not just retrieve." Analysis of the builders converging on this ([alexlockey.com](https://www.alexlockey.com/writing/the-company-brain-four-builders-one-architecture/); [colrows.com](https://colrows.com/blogs/yc-company-brain-rfs/)) shows five shared elements, all adopted below: **(a)** plain markdown in git, portable by design; **(b)** skills as the unit of work; **(c)** the Karpathy discipline — *"the answer is the most refined data in the system; it would be insane to throw it away"* — every solved question gets filed back; **(d)** a **`RESOLVER.md` routing layer** mapping natural-language questions to file locations, each entry with an owner; **(e)** weekly **`check-resolvable` audits** (one builder found 15% of capabilities unreachable — drift compounds silently).
- Strategic note: Aegis's App Brain (§4) *is* a per-tenant Company Brain for regulated operations — it's the same YC RFS shape, but governed. That's a positioning asset, not just infrastructure.

### 1.5 Docs-as-code vs Notion vs custom

- **Git-committed markdown wins for both brains' file tier.** Reasons: (1) agents already have filesystem+grep — zero integration; (2) atomic co-change with code in the same PR (a capability change and its doc change land together or not at all); (3) branching/merging solves multi-agent concurrent writes for free; (4) diffable, hash-chainable, auditable; (5) portable across agent vendors (the AGENTS.md ecosystem, §1.2). CLAUDE.md hierarchy docs confirm on-demand loading of child-directory files — the repo layout *is* the progressive-disclosure mechanism.
- **Notion: rejected.** API-gated (rate limits, auth, no grep), non-atomic with code, weak merge semantics, vendor lock-in — and Aegis's own memory files note Notion MCP exists but adds a hop. Fine for human-facing marketing docs; wrong substrate for agent knowledge.
- **Custom knowledge graph: rejected for now.** pgvector + wikilinks + the audit ledger cover retrieval, linkage, and temporality. A dedicated graph DB is Phase-4+ territory, only if cross-entity inference demands it (§1.2 Graphiti note).

---

## 2. Direct answers to the founder's questions

**Q: Where do the two brains live?**
Dev Brain: `docs/brain/` in the Aegis repo, committed to git — nowhere else. App Brain: platform tier in-repo under `libs/*/knowledge/` + `docs/brain/runbooks/` (embedded to pgvector at deploy); tenant tier in Postgres (`knowledge_items` table + pgvector index), RLS-scoped, written only via governed tools.

**Q: In what format?**
Markdown + YAML frontmatter + `[[wikilinks]]` for prose knowledge (schema in §3.2). `SKILL.md` directories (Agent Skills spec) for executable runtime knowledge. Generated JSON manifests for machine facts (tool registry, capability manifest) — generated, never hand-edited, so they cannot drift.

**Q: How do they scale?**
Three mechanisms: **progressive disclosure** (only index files load by default; everything else loads on match — context cost is O(1) in repo size); **generation over curation** (machine facts derive from live code, so freshness cost is O(0) human effort); **append-only + single-writer partitioning** for concurrent agents (no write contention by construction). Hard numbers and limits in §6.

**Q: How does a new/parallel agent get full context with zero re-explanation?**
It reads, in order: `docs/brain/README.md` (the map, <100 lines) → `docs/brain/STATE.md` (where we are, what's next, <150 lines) → the targeted readme for its task area → falls back to grepping `docs/brain/log/` only if targeted docs lack the answer. Total mandatory read: <400 lines. Protocol in §3.3; enforcement in §3.5.

---

## 3. Design — the Dev-Process Brain

> **Note on the skeleton (reconciled 2026-07-02, later pass):** the skeleton now **exists** at `docs/brain/` — it was created after the first draft of this section. It ships with `README.md` (map + navigation + update protocol + a live "Current state" section), a flat **`AUDIT_LOG.md`** (append-only, entries `T1…T9`, format ask→done→concluded→artifacts→open), and the four targeted dirs `instructions/ designs/ discussions/ architectures/` each with a `README.md` index. This section still *defines the target shape*; the delta between what exists and what this design prescribes is tracked in §3.1.1 (Reconciliation) — **do not treat the two as in conflict; the skeleton is the MVP of this design and the items below are its planned hardening.** Root docs to reconcile remain: `AGENTS.md`, `ONBOARDING.md`, `HANDOFF.md`, `SPEC.md`, `DESIGN.md`, `BUGLOG.md`, `IMPLEMENTATION_PLAN.md` — see §3.7.

### 3.1 Folder/file structure

```
docs/brain/
├── README.md               # THE MAP. What the brain is, read order, the update protocol (§10 verbatim).
├── STATE.md                # SINGLE-WRITER. Current position: last session, in-flight work, next 3 actions,
│                           #   open blockers. ≤150 lines. Updated at every session close. The blackboard's
│                           #   control surface.
├── RESOLVER.md             # Question → file routing table ("Where is X decided?" → path + owner).
│                           #   Every instructions/designs/discussions/architectures file MUST have a row.
├── instructions/           # HOW to do things (imperative, checklist-style)
│   ├── README.md           #   index with one-line description per file
│   ├── dev-workflow.md     #   branch/test/PR/merge rules, Nx commands, local run
│   ├── doc-discipline.md   #   which doc to update when (absorbs AGENTS.md "documentation discipline")
│   └── <task>.md           #   one file per repeatable task (add-a-module, add-a-migration, …)
├── designs/                # WHAT we decided to build (one design = one file, immutable once Accepted)
│   ├── README.md
│   └── NNNN-<slug>.md      #   ADR-style: Context / Decision / Consequences / Status
├── discussions/            # WHY — distilled conversation outcomes (not transcripts)
│   ├── README.md
│   └── YYYY-MM-DD-<slug>.md
├── architectures/          # WHERE things live in the code (maps, not narratives)
│   ├── README.md
│   ├── module-map.md       #   service → owns → talks-to (links into docs/architecture/*)
│   └── data-map.md         #   table → owner service → RLS policy
└── log/                    # APPEND-ONLY AUDIT LOG (the fallback, never the first read)
    ├── INDEX.md            #   one line per session: date | agent | branch | 1-line summary | files touched
    └── YYYY-MM-DD-HHMM-<agent>-<slug>.md   # one file PER SESSION (no shared-file appends)
```

#### 3.1.1 Reconciliation — existing skeleton → target shape

The skeleton that exists today is a valid **Phase-0 MVP** of this design. The gaps to close (each cheap, none a rewrite):

| Exists today | Target (this design) | Migration |
|---|---|---|
| Flat `AUDIT_LOG.md` (single append-only file, `T1…Tn` entries) | `log/` dir: one file per session + `INDEX.md` | **Keep `AUDIT_LOG.md` as-is** — it is the human-readable narrative index. Introduce `log/` for *new* per-session detail files (avoids the multi-writer append-conflict problem for parallel branches, §3.6); `AUDIT_LOG.md` becomes the curated one-paragraph-per-session summary that links into `log/` files. Both can coexist: `AUDIT_LOG.md` = `INDEX.md`'s prose cousin. |
| No `STATE.md` | `STATE.md` single-writer control surface | The skeleton put "Current state" *inside* `README.md`. Split it out into `STATE.md` so the map stays stable and the volatile position has its own ≤150-line single-writer file (README shouldn't churn every session). |
| No `RESOLVER.md` | Question→file routing table | Add it; seed rows from the existing four `*/README.md` indexes. |
| Targeted dirs hold only `README.md` indexes | ADR-numbered design files, per-task instruction files, etc. | Fill incrementally as real content lands; the indexes already exist to point at them. |
| No frontmatter on brain files | YAML frontmatter (§3.2) | Add on next edit of each file; CI schema-check (§3.5) starts non-blocking. |

**Bottom line:** the skeleton is not wrong — it is this design at t=0. An implementing agent hardens it in the order above; nothing here requires deleting or rewriting what exists.

Design rationale, point by point:

- **Targeted dirs first, log last** — exactly the founder's spec. The four targeted dirs answer 95% of questions in one `grep -r` + one read; the log exists so nothing is ever *lost*, not so it's ever *scanned routinely*. This mirrors Letta's tier split (§1.2): STATE.md = core memory, targeted dirs = recall, log/ = archival.
- **One log file per session, plus an INDEX.md** — append-only is achieved by *file creation*, not file appending, so parallel agents on parallel branches can never produce a merge conflict in the log body. Only `INDEX.md` and `STATE.md` can conflict, and both have single-writer rules (§3.6).
- **`RESOLVER.md`** is lifted from the Company Brain builders (§1.4): it is the routing layer that makes "check targeted docs FIRST" executable rather than aspirational, and it is what the CI audit checks for reachability.
- **`designs/` uses ADR numbering** (`0001-…`) — immutable once `status: accepted`; superseding requires a new ADR linking back. This is the standard docs-as-code decision-record practice and gives the "decision audit log" the founder wants in *queryable* form, with `log/` as the raw form.

### 3.2 File format — markdown + frontmatter + wikilinks, and why

Every file in `docs/brain/` (except generated ones) carries this frontmatter:

```yaml
---
title: Casbin model choice for multi-tenant RBAC
type: design            # instruction | design | discussion | architecture | log | state
status: accepted        # draft | accepted | superseded | archived   (designs only)
created: 2026-07-02
updated: 2026-07-02
author: agent:claude/track-3          # or human:ankur
supersedes: null                       # e.g. "[[0007-first-casbin-attempt]]"
related: ["[[module-map]]", "[[0004-rls-policy-shape]]"]
tags: [authz, casbin, multi-tenant]
verify: "libs/access-control/src/model.conf"   # code path that proves this doc true (freshness anchor)
---
```

Why this exact shape:

- **Markdown**: greppable, diffable, renders everywhere, native to every coding agent (§1.5).
- **YAML frontmatter**: machine-parseable metadata without a database — the CI audit (§3.5) and the embedding pipeline (§4.4) both key off it. Identical convention to the Obsidian pattern (§1.1) and the Agent Skills spec (§1.4).
- **`[[wikilinks]]`**: agents *follow links* instead of re-searching (the mindstudio pattern's core retrieval trick); CI resolves them to relative paths and fails on dangling links — the same "a card that dangles fails Validate()" discipline Wayfinder's CapabilityManifest already enforces.
- **`verify:`** is the anti-drift anchor unique to this design: a doc that claims a fact about code names the code path that proves it. The CI audit flags any doc whose `verify` target changed more recently than the doc's `updated` field → "possibly stale" report. Cheap (git log comparison), catches the classic lie-by-staleness failure.
- **≤200 lines per file** (Claude Code memory guidance, §1.2). Longer content splits into linked files — which is also what makes progressive disclosure work.

### 3.3 The read protocol (what every agent does at session start)

```
1. Read docs/brain/README.md            (the map — includes this protocol)
2. Read docs/brain/STATE.md             (yesterday / today / next / blockers)
3. Read root AGENTS.md if not already loaded (harness usually auto-loads it)
4. For the task at hand: consult RESOLVER.md → read the targeted file(s) it routes to
5. ONLY IF the targeted docs lack the answer:
     grep -ri "<terms>" docs/brain/log/  → read matching session files
6. ONLY IF the log lacks it: state explicitly "not in the brain", ask or decide,
     and FILE THE ANSWER BACK (Karpathy rule — the answer is the most refined data).
```

Wiring: root `CLAUDE.md`/`AGENTS.md` gets a 5-line pointer ("Before any work, run the brain read protocol: docs/brain/README.md"). The nearest-file-wins hierarchy (§1.2) means per-service `AGENTS.md` stubs in `apps/*` add service-local pointers without bloating global context.

### 3.4 The write/update protocol (session close — mandatory)

At the end of every working session (or every merged PR, whichever comes first), the agent MUST:

1. **Create** `docs/brain/log/YYYY-MM-DD-HHMM-<agent>-<slug>.md` containing: goal, what was done (files/commits), decisions made (with links to any new/updated `designs/` ADRs), dead ends hit (so the next agent doesn't repeat them), open questions, and explicit next steps.
2. **Append one line** to `log/INDEX.md` (under flock or as part of the same commit — §3.6).
3. **Rewrite** `STATE.md` (full rewrite, not append: it describes *now*, and ≤150 lines).
4. **Promote** any durable outcome to the right targeted dir: a decision → `designs/` ADR; a new how-to → `instructions/`; a distilled debate → `discussions/`; a structural change → `architectures/` + `RESOLVER.md` row.
5. **Commit** all of it *in the same PR as the code it describes* (atomic doc+code — §1.5).

Rule of thumb encoded in `README.md`: **log = always; promote = when someone would need it again; STATE = the last writer wins and writes the whole truth.**

### 3.5 Keeping it current automatically — hooks + CI

**Claude Code hooks** (in `.claude/settings.json`):

```jsonc
{
  "hooks": {
    "SessionEnd": [{ "hooks": [{ "type": "command",
      "command": "node scripts/brain/check-session-logged.js" }] }],   // warn if no log file created this session
    "Stop": [{ "hooks": [{ "type": "command",
      "command": "node scripts/brain/state-freshness.js" }] }]          // warn if STATE.md older than newest log entry
  }
}
```

Plus a `/brain-close` project skill that *performs* §3.4 (template-fills the session log from `git diff --stat` + conversation summary, rewrites STATE.md, updates INDEX.md) — the hook nags, the skill does. Agents that aren't Claude Code follow the same protocol via `AGENTS.md` prose; CI is the backstop for all of them.

**CI job `brain-audit` (blocking on PRs that touch `docs/brain/` or `apps|libs`):**

- every wikilink resolves (dangling → fail);
- every file in the four targeted dirs has a `RESOLVER.md` row (`check-resolvable`, §1.4 — the 15%-unreachable lesson);
- frontmatter schema-valid (zod/Joi);
- any doc whose `verify:` path has newer commits than `updated:` → stale-warning report (non-blocking comment);
- a PR changing `apps/` or `libs/` with zero `docs/brain/` changes gets an automated PR comment asking "no brain update needed? say why" (soft gate, avoids doc-theater);
- `STATE.md` ≤150 lines; log files never modified after merge (append-only enforced: CI fails any diff to an existing `log/*.md`).

### 3.6 Blackboard rules for parallel agents (concurrency)

Applying §1.3 to a git-backed blackboard:

1. **Log body: create-only, never edit.** Per-session filenames include timestamp+agent → no two writers ever touch the same file. Post-merge edits to `log/` are CI-rejected.
2. **`STATE.md`: single-writer, last-merge-wins, full-rewrite.** On merge conflict, the later merger re-reads both versions and writes a reconciled whole (it's ≤150 lines; reconciliation is a 2-minute LLM task). Never resolved by picking one side blindly — the file's header says so.
3. **`INDEX.md`: append-at-end only**; conflicts are trivial unions (git `merge.union` driver is set for this one file via `.gitattributes`: `docs/brain/log/INDEX.md merge=union`).
4. **Targeted dirs: ownership via `RESOLVER.md`'s owner column.** An agent editing a doc it doesn't own flags the owner in the PR. Designs are immutable-once-accepted, so concurrent design edits can't happen — you supersede instead.
5. **The control loop** (blackboard's "control component") is `STATE.md`'s `## Next` section: parallel agents claim a next-item by moving it to `## In flight — <agent> — <branch>` in their branch's STATE rewrite. Two agents claiming the same item is discovered at merge — cheap, and rarer than it sounds because claims are pushed early.
6. **No cross-agent chatter outside the blackboard.** If agent A needs agent B to know something, it goes in a log file + STATE, not in an ephemeral channel. (This is the bMAS finding: shared state beats message passing on tokens *and* coherence.)

### 3.7 Reconciling with the existing root docs

The repo already has strong root docs; the brain **absorbs their *roles* without deleting them** (external agents and the AGENTS.md ecosystem expect root files):

| Existing file | Disposition |
|---|---|
| `AGENTS.md` | Stays root, slimmed: identity + provenance + the 5-line brain pointer. Its "documentation discipline" section moves to `instructions/doc-discipline.md`. |
| `ONBOARDING.md` | Stays (it's also shared externally via the onboarding-guide tool) but becomes generated-in-spirit: its "current state / what's next" section must defer to `STATE.md` — CI stale-warns if they diverge. |
| `HANDOFF.md` | Frozen as a snapshot; new handoffs are just "read the brain". Add a banner pointing to `docs/brain/README.md`. |
| `SPEC.md`, `IMPLEMENTATION_PLAN.md`, `DESIGN.md` | Unchanged (SPEC stays the single source of truth for product scope). `RESOLVER.md` routes to them; `designs/` ADRs link to the SPEC sections they refine. |
| `BUGLOG.md` | Migrates to `docs/brain/log/` convention over time; new bugs logged as session-log entries tagged `bug`. |
| `docs/architecture/*`, numbered `docs/0N-*.md` | Unchanged; `architectures/module-map.md` is a thin map *into* them, not a copy. |

---

## 4. Design — the App/Platform Brain

The runtime agents' knowledge problem is different in kind: the reader is untrusted-adjacent (it acts for tenants), the content is partly tenant private, and the cost of a hallucinated "how" is a wrong financial action. Hence: **generated + governed + RLS-scoped**, files only as the authoring/build format.

### 4.1 Two tiers

- **Platform tier** (same for all tenants): module capability manifests (generated), `SKILL.md` runbooks per agent-facing task ("close the books", "onboard an employee", "reconcile connector X"), policy/guardrail descriptions, "how Aegis works" self-explanation corpus (feeds §C.4's "the app explains every bit of its functionality"). Authored/generated in-repo → embedded at deploy.
- **Tenant tier** (RLS-scoped): tenant configuration knowledge ("our expense policy tiers", "our fiscal calendar", connector account mappings), governed memories (Facet 8's `remember/recall/forget`, OFF by default), and distilled operational facts (Mem0-style extraction, §1.2 — but written only through a governed tool with audit).

### 4.2 Storage schema (tenant tier + embedded platform tier)

```sql
CREATE TABLE knowledge_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,            -- platform tier uses the reserved platform tenant id
  module        text NOT NULL,            -- 'expense' | 'payroll' | 'platform' | ...
  kind          text NOT NULL,            -- 'manifest' | 'skill' | 'runbook' | 'tenant_config' | 'memory' | 'doc'
  slug          text NOT NULL,
  version       int  NOT NULL DEFAULT 1,  -- superseded rows kept (is_current=false) → versioned brain
  is_current    boolean NOT NULL DEFAULT true,
  content       text NOT NULL,            -- markdown body
  frontmatter   jsonb NOT NULL,           -- same schema as §3.2 + source_hash
  source_hash   text NOT NULL,            -- sha256 of generating source (manifest json / file) → re-embed diffing
  embedding     vector(1536),
  created_by    text NOT NULL,            -- principal (agent or human) — audited like any write
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module, kind, slug, version)
);
-- RLS: USING (tenant_id = current_setting('app.tenant_id')::uuid OR tenant_id = platform_tenant())
-- pgvector: partitioned/partial indexes by tenant_id per agentic-platform-design.md §E.7
```

Every write goes through a governed tool (`knowledge.write`, Tier 2) → PEP → audit ledger. **The LLM never writes this table directly** — same rule as every other state change.

### 4.3 Skill files for runtime agents — the executable knowledge unit

Adopt the Agent Skills format (§1.4) verbatim as the authoring format, with an Aegis governance extension in frontmatter:

```
libs/expense/knowledge/skills/approve-expense-batch/
├── SKILL.md
└── references/edge-cases.md
```

```yaml
---
name: approve-expense-batch
description: Review and approve a batch of pending expenses within policy. Use when a user asks to clear their approval queue.
module: expense
tools_required: [expense.list_pending, expense.approve]   # must exist in the generated tool registry
max_risk_tier: 4                                          # highest tier this skill may invoke
tenant_overridable: [policy_thresholds]                   # which sections a tenant-tier doc may override
---
# Approve expense batch
1. Call `expense.list_pending` ...
2. For each item over the tenant threshold, DO NOT approve — route to human via approvals ...
```

Load model = progressive disclosure exactly as Anthropic specifies: the orchestrator's system context carries only name+description lines (cheap, fixed cost per skill); the full body loads on task match; `references/` load on demand. **CI validation** (extends `validateAiManifest()`, ai-native-core §0.5): every `tools_required` entry must resolve against the live route-walk tool registry, every tool's actual tier must be ≤ `max_risk_tier`, and a skill referencing a removed tool **fails the build** — the CapabilityManifest drift-proof pattern applied to prose. This is the "hallucination-proof HOW": the skill can't describe a tool that doesn't exist, because the build won't let it.

### 4.4 Generation pipeline (freshness by construction)

```
route stack (Express routers + Joi + Permission decorators)
   └─ route-walk ⇒ tool registry JSON            (already designed, §C.2)
        └─ manifest-to-markdown generator ⇒ per-module capability doc (kind='manifest')
docs/brain/runbooks/*, libs/*/knowledge/**       (curated, PR-reviewed)
        └─ collected at build
                       ⇓  deploy step
   chunk (by heading, ~500 tokens, 15% overlap) → embed → upsert knowledge_items
   WHERE source_hash changed (content-addressed: unchanged docs are not re-embedded)
   old versions: is_current=false (kept — versioned, auditable brain)
```

- Embeddings via the LiteLLM gateway (per-tenant budgets don't apply to platform-tier embedding; tenant-tier embedding bills to the tenant).
- **Freshness SLO:** platform tier is exactly as fresh as the deployed build (impossible to drift); tenant tier re-embeds on write (synchronous, single doc, cheap).
- Tenant-tier config knowledge is (re)generated from actual tenant settings rows where possible (same generation-over-curation rule), with curated prose only for genuinely free-text policy.

### 4.5 Query path for runtime agents — deterministic first, RAG second

1. **Tool/manifest lookup** (exact): "can I do X?" answers from the entitlement-filtered tool registry — never from RAG.
2. **Skill match** (name+description in context): task-shaped questions route to a skill body load.
3. **Hybrid retrieval over `knowledge_items`** (RLS-scoped, module-filtered when the intent router knows the module): for "how/why/what-is" questions. **Hybrid, not vector-only** — run pgvector similarity (HNSW) *and* Postgres BM25/`ts_rank` keyword search in parallel, merge with **reciprocal rank fusion (RRF)** — the GBrain technique (§1.2.1), a measured +31pt P@5 over vector-only, implementable as SQL with no new dependency. Optional deterministic **auto-linking** (zero-LLM entity extraction) adds a graph edge set that can be unioned into the candidate pool later if recall demands. Retrieved chunks carry `{slug, version, source_hash}`.
4. **Audit-ledger query** (deterministic, via the existing "why" agent, Facet 8 `auditContribution`): "why did X happen" answers from the hash-chained ledger, *not* from vector search.
5. **Abstain**: if steps 1–4 return nothing above the relevance floor, the agent says "I don't have grounded knowledge for that" and offers escalation. **Answers must carry citations** (`slug@version`); the generative-UI answer card renders them. Uncited generation about platform behavior is a guardrail violation (Facet 9 output rail).

### 4.6 Tenant/user memory (the governed Mem0-shaped piece)

Per Facet 8: `remember/recall/forget` tools, OFF by default per tenant, RLS-scoped, audited. Build (not adopt, §1.2): an extraction pass (borrowing Mem0's distill-facts prompt shape) runs post-conversation, *proposes* memory writes; Tier-2 governed tool persists them; `forget` is a real delete + audit entry (GDPR). LangMem's procedural-memory idea enters as: an agent may **propose an edit to a skill/runbook** (a PR or a maker-checker approval item) — it never self-modifies live knowledge. Prompt-injection note (ai-native-core §8): tenant-authored content (invoice memos, expense notes) entering RAG chunks is untrusted — chunks are rendered into context inside a delimited, "data not instructions" frame, and Facet-9 input rails run on retrieval output too, not just user input.

---

## 5. Anti-hallucination discipline (both brains — the shared constitution)

1. **Targeted first, fallback second** — RESOLVER/skill-match before grep-the-log/RAG (structure beats search).
2. **Cite or abstain** — every knowledge-derived claim names its file/`slug@version`; no citation ⇒ say "not in the brain" and file the eventual answer back.
3. **Generate what can be generated** — machine facts (tools, routes, schemas, capabilities) are never hand-written; prose may *reference* them, and CI verifies the references resolve (§3.5, §4.3).
4. **Freshness anchors** — `verify:` paths (dev) and `source_hash` (app) make staleness detectable mechanically.
5. **The reasoning plane never treats retrieved text as authority for authz/tiers** — knowledge informs *how*, the PDP decides *whether* (ai-native-core §0.5 hard rules).
6. **The answer is the most refined data in the system** — Karpathy rule; every solved question becomes a brain entry, closing the loop.

---

## 6. Scaling analysis

| Axis | Mechanism & limit |
|---|---|
| Context cost vs repo size | O(1): mandatory reads are README+STATE+task file (<400 lines ≈ <6k tokens). Skill discovery is ~30 tokens/skill (name+description); at 200 skills that's ~6k tokens — cap per-turn skill lines via the intent router before then (the "too many tools" problem, agentic-platform-design §C.3, applies to skills identically). |
| Repo growth | `log/` grows ~1 file/session; at 10 sessions/day ≈ 3.6k files/yr ≈ trivial for git. Quarterly compaction skill: distill quarter-old logs into a `log/ARCHIVE-YYYY-Qn.md` summary + move originals to `log/archive/` (still greppable, out of INDEX). Targeted dirs stay small because designs are immutable and instructions are per-task. |
| Index freshness | Platform tier: freshness = deploy (drift impossible). Tenant tier: embed-on-write. Dev brain isn't embedded at all in Phase 1 (grep suffices at repo scale); add a pgvector mirror of `docs/brain/` only when grep hit-rates degrade (measurable via the abstain-rate metric). |
| Embedding cost | Content-hash diffing (§4.4) makes re-embeds proportional to change, not corpus. ~500-token chunks ⇒ a full 2k-chunk platform corpus is ~1M tokens ≈ dollars, and incremental after that. |
| Concurrent writes | Dev: §3.6 (create-only logs, union-merge INDEX, single-writer STATE). App: ordinary Postgres row versioning (`is_current` flip in one transaction); no file contention exists at runtime. |
| Multi-tenant blast radius | RLS partitioning per §E.7; platform tier read-shared via the platform tenant id; a tenant can never retrieve another tenant's chunks by construction. |
| Honest limit | STATE.md as single control surface degrades beyond ~5 truly-parallel dev agents (merge-reconcile churn). At that point promote the claims mechanism to a tiny table/Kafka topic — the design anticipates but does not build it. |

---

## 7. Adoption candidates (summary table)

| Candidate | License | Fit | Verdict |
|---|---|---|---|
| Obsidian+Claude vault pattern ([mindstudio](https://www.mindstudio.ai/blog/build-ai-second-brain-claude-code-obsidian)) | pattern | Dev brain conventions | **Adopt pattern**, not the app |
| Agent Skills / SKILL.md ([spec](https://agentskills.io/home), [Anthropic](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)) | open spec | Runtime executable knowledge | **Adopt** + governance frontmatter extension |
| AGENTS.md ([agents.md](https://agents.md/), Linux Foundation) | open spec | Cross-vendor dev-agent entry point | **Adopt** (already present; extend per-service) |
| llms.txt ([llmstxt.org](https://llmstxt.org/)) | open spec | Gateway-served capability index | **Adopt**, generated |
| Claude Code memory hierarchy ([docs](https://code.claude.com/docs/en/memory)) | product feature | Loading mechanism for dev brain | **Adopt** conventions (thin root, ≤200-line files, nearest-file) |
| **GBrain** ([repo](https://github.com/garrytan/gbrain), [v0 doc](https://github.com/garrytan/gbrain/blob/master/docs/GBRAIN_V0.md)) | **MIT** | **Reference architecture for the App Brain** (git-markdown → Postgres+pgvector, hybrid vector+BM25+RRF, zero-LLM auto-linked graph, git-delete→soft-delete) | **Adopt architecture + vendor the retrieval technique** (hybrid+RRF into §4.5); **do NOT run as a service** (owns its own Postgres → bypasses RLS/PEP/audit). Reimplement on governed Postgres. |
| scout ([repo](https://github.com/agno-agi/scout)) | open-source | Open "company brain" sibling | **Reference only** — confirms the git-markdown-brain convergence; no direct dependency |
| Mem0 ([repo](https://github.com/mem0ai/mem0)) | Apache-2.0 | Tenant memory extraction | **Borrow prompts, build thin governed layer**; re-evaluate as self-hosted lib in Phase 3 (verify license/backends at adoption) |
| Letta/MemGPT ([letta](https://github.com/letta-ai/letta)) | Apache-2.0 | Memory tier *model* | **Concept only** — runtime conflicts with governed core |
| Zep Graphiti ([repo](https://github.com/getzep/graphiti)) | Apache-2.0 | Temporal KG | **Defer** — audit ledger is our temporal truth |
| LangMem | MIT | Procedural memory idea | **Concept only** (maker-checker'd self-edits) |
| Blackboard pattern ([bMAS arXiv:2507.01701](https://arxiv.org/abs/2507.01701), [agent-blackboard](https://github.com/claudioed/agent-blackboard)) | pattern / MIT-ish repos | Multi-agent shared state | **Adopt pattern** on git (dev) — "Blackboard.io RCLE" **does not exist** |
| RESOLVER.md + check-resolvable ([Company Brain builders](https://www.alexlockey.com/writing/the-company-brain-four-builders-one-architecture/)) | pattern | Routing + drift audit | **Adopt** in both brains' CI |

---

## 8. Risks and honest limits

- **Doc-theater risk**: mandatory session logs can degrade into noise. Mitigations: the soft CI gate asks "why no update" rather than blocking; the promote-vs-log rule keeps targeted dirs curated; quarterly compaction. Accept: some log entries will be low-value — that's fine, they're the archive tier.
- **Protocol compliance is behavioral**, not mechanical, for non-Claude agents (hooks only fire in Claude Code). CI is the real enforcement; anything CI can't check (quality of a session log) stays human/reviewer-audited.
- **RAG over tenant text is an injection surface** — mitigated (§4.6) but not eliminated; keep retrieved-chunk framing + output rails in the eval suite (Promptfoo cases for "chunk contains instructions").
- **Two brains means two disciplines** — deliberate, but it doubles the protocol surface. The shared constitution (§5) is one page precisely so it can live in both README.md and the platform system prompt.
- **Embedding-model migration** re-embeds everything (version the model name in `frontmatter`; budgeted, not free).
- **Search-verified negative**: no product named "Blackboard.io RCLE" was found; if the founder has a specific link, drop it in `discussions/` and this section gets amended — the design does not depend on it either way.
- **STATE.md single-writer ceiling** (~5 parallel dev agents) — see §6 honest limit.

---

## 9. Phased build outline

**Phase 0 — Bootstrap the Dev Brain (½ day, do first):**
`mkdir -p docs/brain/{instructions,designs,discussions,architectures,log}`; write `README.md` (map + §3.3/§3.4 protocol + §5 constitution), initial `STATE.md`, `RESOLVER.md`, `log/INDEX.md` + `.gitattributes` union rule; backfill `log/2026-07-02-…-bootstrap.md` summarizing current position from ONBOARDING/HANDOFF; add the 5-line pointer to root `AGENTS.md`/`CLAUDE.md`; banner HANDOFF.md.

**Phase 1 — Enforcement (1–2 days):**
`scripts/brain/` (frontmatter zod schema, wikilink resolver, check-resolvable, verify-staleness); CI job `brain-audit`; Claude Code hooks + `/brain-close` skill; migrate AGENTS.md doc-discipline section into `instructions/doc-discipline.md`; write the first 3 instructions files (dev-workflow, add-a-module, add-a-migration) and `architectures/module-map.md`.

**Phase 2 — App Brain platform tier (1 week, alongside the tool-registry work it depends on):**
`knowledge_items` migration + RLS policy; manifest→markdown generator off the route-walk registry; chunk/embed/upsert deploy step with `source_hash` diffing; **hybrid retrieval (pgvector HNSW + Postgres BM25/`ts_rank`, merged via RRF — the GBrain technique, §1.2.1)** behind the RLS-scoped query path; extend `validateAiManifest()` with skill-file validation (§4.3); author first 2 SKILL.md runbooks for the highest-value module; wire query path steps 1–3 + citations into the orchestrator; serve generated `/llms.txt`.

**Phase 3 — Tenant tier + memory (1 week, after approvals/agent-principal plumbing):**
tenant-config knowledge generation; governed `knowledge.write` + `remember/recall/forget` (default OFF); Mem0-shaped extraction pass behind maker-checker; audit-ledger "why" integration (step 4); abstain-rate + citation-rate metrics in Langfuse; Promptfoo injection cases for retrieved chunks.

**Phase 4 — Scale hardening (as needed):**
dev-brain pgvector mirror if grep degrades; quarterly log compaction skill; claims table if parallel-agent count exceeds the STATE.md ceiling; Graphiti re-evaluation only if temporal cross-entity queries demand it.

---

## 10. The Agent Update Protocol (verbatim — paste into `docs/brain/README.md`)

```
EVERY SESSION, EVERY AGENT — NO EXCEPTIONS

ON START
 1. Read docs/brain/README.md, then docs/brain/STATE.md.
 2. Route your task through docs/brain/RESOLVER.md; read the targeted doc(s).
 3. Fallback ONLY if targeted docs lack the answer: grep docs/brain/log/, read matches.
 4. Still unanswered → say "not in the brain", resolve it, and file the answer back.

ON CLOSE (or per merged PR)
 5. CREATE docs/brain/log/<date-time>-<agent>-<slug>.md
    (goal, done, decisions→ADR links, dead ends, open questions, next steps).
 6. APPEND one line to log/INDEX.md.
 7. REWRITE STATE.md in full (≤150 lines): position, in-flight, next 3, blockers.
 8. PROMOTE durable outcomes: decision→designs/ ADR · how-to→instructions/ ·
    debate→discussions/ · structure→architectures/ + RESOLVER.md row.
 9. COMMIT docs with the code they describe, same PR.

ALWAYS
 - Cite the brain file for any claim about prior decisions; no citation → abstain.
 - Never edit a merged log file. Never hand-edit generated files.
 - ≤200 lines per file; split and wikilink instead.
```

---

## Red-team correction (READ BEFORE IMPLEMENTING)

**Verdict:** Architecturally sound and unusually well-researched — the two-brain split, generate-over-curate, cite-or-abstain, and GBrain-technique-not-service calls are all correct. But it ships **live protocol/reality drift today** and **under-specifies the two controls that actually carry the platform's safety weight** (RLS on the tenant brain, and the RAG-gloss-vs-ledger-truth trust boundary). Fix those before writing a line of enforcement code; the rest is polish.

### Ranked top fixes

1. **The mandated read protocol points at files that do not exist.** §3.3 and §10 order every agent to read `docs/brain/STATE.md` and route through `RESOLVER.md`; neither exists on disk (verified: `docs/brain/` has `AUDIT_LOG.md`, `README.md`, and the four dirs — no `STATE.md`, no `RESOLVER.md`, no `log/`). §3.1.1 admits this but the *authoritative protocol* still commands the non-existent path. An agent following §10 verbatim hits a missing file on step 1–2 and either errors or silently skips — the exact "zero re-explanation" promise, broken at t=0. **Fix:** make Phase 0 (§9) a hard prerequisite of publishing §3.3/§10, OR rewrite the protocol to read `README.md`'s "Current state" section until `STATE.md` exists. Do not ship a protocol whose first two steps 404.

2. **RLS is asserted, not designed — and the platform-tenant OR-clause is a cross-tenant read hole waiting to happen.** The whole tenant-brain safety case rests on one commented line (§4.2): `USING (tenant_id = current_setting('app.tenant_id')::uuid OR tenant_id = platform_tenant())`. Three unaddressed failure modes: (a) `current_setting('app.tenant_id')` unset (connection-pool reuse, a missed `SET LOCAL`, a background job) → `NULL` → the predicate collapses and, depending on `current_setting`'s missing-key behavior, either errors or matches nothing/everything; this must use the two-arg `current_setting(name, true)` + explicit null-guard, and the migration must state it. (b) The `OR platform_tenant()` branch means **every tenant query also scans platform rows** — fine for read, but if any write path reuses this predicate a tenant could write `tenant_id=platform` rows and poison the *shared* platform brain for all tenants. The doc never says the write policy differs from the read policy. (c) pgvector similarity search + RLS: HNSW indexes don't compose with row-level filters the way btree does — a `WHERE tenant_id=...` post-filter on an ANN scan can silently return fewer-than-k results or leak timing. **Fix:** write the actual `CREATE POLICY` (separate SELECT vs INSERT/UPDATE policies; platform rows read-only to tenants; deny-by-default on unset GUC), and specify the RLS-aware retrieval (partial indexes per §E.7 are named but the ANN-under-RLS correctness argument is missing). This is the single most load-bearing under-specification in the doc.

3. **GDPR `forget` vs the immutable brain is hand-waved.** §4.6 says "`forget` is a real delete + audit entry (GDPR)" — but §4.2's whole value prop is `is_current=false` **versioning that keeps superseded rows**, and every write lands in the hash-chained audit ledger. So: does `forget` hard-delete all versions (breaking the "versioned, auditable brain" invariant and leaving dangling audit references), or soft-delete (not GDPR erasure)? And the *embeddings* derived from erased PII are themselves PII — deleting the row but leaving the vector, or leaving the extracted "distilled operational fact" that Mem0-style extraction wrote elsewhere, is a partial-erasure failure. GBrain's model (git-delete→soft-delete) is explicitly **the wrong answer for erasure**. This collides head-on with the founder mandate's known GDPR-vs-ledger tension and gets one sentence. **Fix:** specify crypto-shredding (per-tenant or per-subject key; erase key, not rows) or a documented tombstone+embedding-purge path, and reconcile with the ledger's immutability (audit the erasure event, not the erased content).

4. **The poisoned-brain / RAG-gloss-vs-ledger-truth boundary is stated but not enforced.** §5 rule 5 ("reasoning plane never treats retrieved text as authority for authz/tiers") is exactly right and is the most important sentence in the doc — but nothing *mechanically prevents* it. A skill body or a tenant-tier `knowledge_item` can contain the string "expenses under $10,000 are auto-approved, no human needed"; a runtime agent retrieves it, and it reads as instruction. The `max_risk_tier`/`tools_required` CI check (§4.3) validates *tool existence*, not *semantic safety of prose*. Tenant-authored memory (§4.6) is attacker-controllable (invoice memos → extraction → knowledge_item → future context). The "delimited data-not-instructions frame" + input rails are named but that defense is known-porous. **Fix:** state the invariant as a hard architectural rule — retrieved knowledge can *never* widen authorization, tier, or autonomy; the PDP/entitlement decision is computed from the governed core *before and independent of* any retrieved text, and a skill's `max_risk_tier` is a **ceiling the PEP enforces**, not a hint the LLM reads. Add adversarial evals where a poisoned chunk *tries* to escalate and the gate holds regardless.

5. **The git-blackboard concurrency proof is weaker than claimed and depends on unconfigured plumbing.** (a) `merge=union` on `INDEX.md` (§3.6.3) is **not set** — no root `.gitattributes` exists — and union-merge is *unsafe* for content where order/dedup matters: it concatenates both sides, producing duplicate and interleaved lines, never conflicting even when it should. (b) The claim "parallel agents on parallel branches can never produce a merge conflict in the log body" is true for *file bodies* but the real contention is `STATE.md` (single control surface) — the doc admits a ~5-agent ceiling (§6, §8) but the "claim a next-item by moving it in your branch's rewrite" mechanism (§3.6.5) is a **last-writer-wins lost-update**: two agents claim different items, both full-rewrite STATE, the second merge silently clobbers the first's claim unless a human reconciles. "Discovered at merge, cheap" undersells a classic lost-update race. (c) "≤150 lines, reconciliation is a 2-minute LLM task" bakes an LLM call into the merge-conflict-resolution path — non-deterministic conflict resolution on the *control surface* of a governance platform is itself a smell. **Fix:** either accept the blackboard is single-writer-serialized (honest, simpler) or move claims to the "tiny table/Kafka topic" *now* if >2 concurrent agents is a real Phase-1 scenario; and commit the `.gitattributes` in Phase 0, not "someday."

6. **"Freshness by construction" over-claims.** Platform-tier "impossible to drift" (§4.4, §6) is true only for the *generated* manifest slice. The curated `SKILL.md` runbooks and the "how Aegis works" self-explanation corpus (§4.1) are **hand-authored prose** — they drift exactly like any doc, and the `verify:`-path staleness check is Dev-brain-only; the App brain has `source_hash` (detects *file* change, not *truth* change) but no equivalent "the code this runbook describes moved" check. A runbook saying "route over-threshold items to human" stays green while the threshold logic is refactored away. **Fix:** apply the `verify:`/code-path anchor to platform-tier skills too, and state plainly that only the manifest tier is drift-proof; curated skills are drift-*detectable* at best.

### Key holes (security / feasibility / gaps)

- **Security:** RLS write-policy vs read-policy conflation (fix #2b); embeddings-as-PII on erasure (#3); poisoned-knowledge authorization escalation not mechanically blocked (#4); tenant-authored text → extraction → shared context is an injection pipeline that §4.6 mitigates but does not gate.
- **Feasibility:** ANN-under-RLS correctness (HNSW + row filters returning <k or leaking) is unproven here (#2c); `merge=union` unconfigured and semantically wrong for an index (#5a); LLM-in-the-merge-path for STATE.md (#5c).
- **Gaps:** protocol references non-existent files (#1); no `forget` semantics reconciled with versioning+ledger (#3); no App-brain code-truth freshness anchor (#6); **cost/latency of hybrid retrieval unquantified** — RRF over pgvector-HNSW *and* a BM25/`ts_rank` scan per query, RLS-scoped, adds a second index and a fusion step to every "how/why" turn; §6 costs embeddings but never the *query-time* p95. **No eval baseline for abstain-rate/citation-rate** exists yet — the "measurable via abstain-rate" claims (§6, §8) reference a metric that isn't defined or instrumented. **GBrain's +31pt P@5** is cited as justification for adopting the *graph* layer, but §4.5 defers the graph ("unioned into the candidate pool later") — so the headline number does not apply to what's actually being built in Phase 2.

### Where a human — or a different approach — is genuinely needed

- **GDPR erasure design (#3) needs legal + a data-protection decision, not an engineering guess.** Crypto-shredding vs tombstoning changes the schema and the ledger contract; pick it with counsel before the `knowledge_items` migration lands. This is a human decision.
- **The single-human self-serve SMB tenant breaks §4.6's maker-checker for procedural memory** (agent proposes a runbook edit → who approves in a one-person tenant?). Same structural problem the operations red-team flagged for approvals. Needs an explicit "solo-tenant" fallback (self-approve-with-cooldown, or platform-tier-only skills for solo tenants) — not addressed here.
- **>2 truly-parallel dev agents:** the git-blackboard is the *wrong substrate* for the control surface (STATE claims). If that's a near-term reality, use a real coordination primitive (advisory lock / claims table) now; git is right for the *knowledge*, not the *scheduler*.
- **RLS-under-ANN correctness (#2c)** warrants a spike/benchmark by someone who has run pgvector HNSW with row-level security at scale — this is a known sharp edge, not a design-on-paper item.

