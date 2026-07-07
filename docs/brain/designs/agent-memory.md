# Agent Memory — the Wayfinder port (T24)

> How Aegis got its agent memory: what Wayfinder (the founder's Android/VR assistant) already had,
> what we ported, what we deliberately dropped server-side, and where each piece landed.
> Source of truth for the semantics: Wayfinder `docs/architecture/adr/ADR-0001-cross-device-memory-pgvector.md`
> and `voice/memory/MemoryStore.kt`; Aegis implementation in `libs/db/src/brain/` + `libs/ai-core/src/agent-memory/`.

## What Wayfinder has (and why it's relevant)

Wayfinder's ADR-0001 already **rejected the markdown-vault model and chose Postgres + pgvector** for
assistant memory — the same store Aegis built in T23. On top of it, Wayfinder runs a disciplined
memory architecture shaped by voice-latency + on-device constraints:

- **One durable fact per row**, with **supersede-by-subject**: "my car is on level 5" *replaces*
  "…level 3" (same subject ⇒ tombstone the old row before inserting), so facts never accumulate
  stale duplicates.
- **Soft-invalidation** (tombstones / `valid_to`), never hard deletes — forgets replicate safely and
  history stays inspectable.
- **Embedder-space tagging**: every row records which encoder produced its vector; recall only ever
  compares same-space rows (vector spaces must never be mixed).
- **Tiered retrieval (Letta pattern)**: Tier-0 = a core profile block *always* in the prompt
  (≤ ~40 items); Tier-1 = recency/salience scan; Tier-2 = vector search **only when the LLM calls
  `memory_recall`** — semantic search stays off the latency-critical path.
- **Three tools**: `memory_remember` / `memory_recall` / `memory_forget`.
- **mem0-style write path**: async post-turn extraction where the LLM proposes
  ADD / UPDATE / DELETE / NOOP ops, applied only above a confidence threshold; explicit remembers
  write immediately.
- **Fail-soft doctrine**: a memory failure never crashes a turn.

## The mapping (Wayfinder → Aegis)

| Wayfinder concept | Aegis home | Notes |
|---|---|---|
| `MemoryStore` supersede-by-subject | `AppBrainService.remember({subject})` → `libs/db/src/brain/app-brain.{service,repository}.ts` | Supersede + insert run in ONE `withTenantTransaction` (atomic, RLS-scoped); `lower(subject)` match |
| Tombstones / soft-delete | `valid_to TIMESTAMPTZ` (migration `0034_app_brain_memory_v2`) | `forget`/`forgetBySubject` soft-invalidate; every read path filters `valid_to IS NULL` |
| Embedder-space tag | `embedder` column + `EmbeddingClient.embedderId` (`fnv1a-bow-384/v1`) | Recall compares only same-space rows; provider swap = new space id + migration |
| `minScore` recall threshold | `recall(query, k, {minScore})` — SQL `distance <= 1 - minScore` | pgvector `<=>` is cosine *distance*; minScore is similarity in [0,1] |
| `profile()` / `salient()` tiers | `AppBrainService.profile(40)` / `.salient(10)` | Deterministic `updated_at DESC, created_at DESC, id ASC` ordering |
| Tier-0/1 prompt blocks (`MemoryContextProvider`) | `buildMemoryContext()` → `libs/ai-core/src/agent-memory/memory-context.ts` | `[MEMORY]` preamble injected by `runConversation({agentMemory})`; `""` on empty/error (fail-soft) |
| The 3 memory tools (`LocalMemoryService`) | `makeMemoryTools(store)` → `agent-memory/memory-tools.ts` | Built-in tools with declared danger facts; decisions journal = `kind: "decision"` |
| mem0 post-turn extraction | `extractMemoryOps` + `applyMemoryOps` → `agent-memory/post-turn-extractor.ts` | Strict-JSON ops, malformed ⇒ `[]`; default `minConfidence` 0.7; UPDATE is natural via supersede |
| Owner voice-gating of memory tools | The **danger gate**: built-in tools carry `dangerFacts` and run through `evaluateActionGate` before executing | Same gate as route tools; a high-risk builtin returns `needs_ceremony`, never auto-executes |

The ai-core side is coupled to the db side ONLY through the structural `AgentMemoryStore` seam
(`agent-memory/types.ts`) — `AppBrainService` satisfies it without either lib importing the other
(same decoupling trick as the entitlement tool-filter).

## Deliberately dropped server-side (and why)

Wayfinder is **local-first with a cloud replica**; Aegis is **Postgres-authoritative multi-tenant**.
That kills a whole layer of machinery we did NOT port:

- **`MemorySyncEngine` / LWW merge / sync cursors / unsynced push queues** — there is exactly one
  store and it is the source of truth; no device replicas to reconcile.
- **Brute-force cosine scans** — right for tens→thousands of personal rows on a phone; Aegis tenants
  share one table with an **HNSW index** (`vector_cosine_ops`), so recall scales past that.
- **Single-user assumption** — replaced by **FORCE + RESTRICTIVE RLS**: isolation is in the
  database, not the key-space convention.
- **On-device model provisioning** (`MemoryModelProvisioner`, ONNX under Android constraints) — the
  server can call any provider behind the `EmbeddingClient` seam; no performance ceiling.

## What a real embedding provider changes

Today the default is the offline deterministic `HashingEmbeddingClient` (lexical-overlap similarity —
honest for tests, weak for semantics). Dropping in a real provider (e.g. `text-embedding-3-small`)
means: implement `EmbeddingClient` (fetch + API key), give it a new `embedderId`, add a migration for
the new `vector(N)` dimension, and re-embed (or dual-write) rows. Nothing above the seam changes —
tools, tiers, extraction, supersede, and RLS are all dimension- and provider-agnostic.
