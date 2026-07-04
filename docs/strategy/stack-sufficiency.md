# Stack Sufficiency — Languages, Frameworks, Complex Algorithms

**Track 2 of the Aegis platform-design research series.**
Companion docs: `agentic-platform-design.md` (substrate), `ai-native-core.md` (§0.5 minimal viable contract, §8 red-team).

**Status:** Research complete, verdict issued. Implementation-ready. Refreshed against mid-2026 sources.
**Date:** 2026-07-02 (revised).

---

## 0. The founder's question, answered directly

> *Is TypeScript/Node + our current frameworks ENOUGH for everything we want (agent runtime, RAG over the entire app, heavy algorithms, high-scale), or do we need other languages/frameworks for specific functionality? We should not shy away from complex algorithms wherever needed.*

**Direct answer: Yes for ~90% of the platform — including the entire agent runtime, the governed core, RAG retrieval/orchestration, text-to-SQL, diff/patch auto-fix, and streaming rule-based detection. TS/Node is the spine and stays the spine.**

**The honest 10%:** four algorithm families are materially better served by Python today — (1) probabilistic entity resolution at scale (Splink), (2) statistical/ML forecasting (Nixtla statsforecast), (3) online-learning anomaly/fraud *model training and drift adaptation* (River/scikit-learn), (4) GraphRAG *indexing* pipelines (Microsoft graphrag / LightRAG). These plug in as **stateless sidecar workers behind Kafka/HTTP seams that never touch the governed core** — they receive pre-scoped data and return scores/artifacts; authz, tenancy, and writes stay in TS. No Go/Rust service is justified today; Rust enters only as **napi-rs native modules inside Node** (tokenizers, ast-grep, local ONNX inference) — a dependency choice, not an architecture change.

**Never rewrite. Never let a non-TS process hold a DB connection or a permission decision.**

The rest of this doc is the evidence, the per-algorithm decision table, the polyglot integration architecture, and the migration triggers.

---

## 1. Research findings (internet-first, with sources)

### 1.1 The TS/Node AI ecosystem is no longer second-class for *agents* (2025–26)

The historical "AI = Python" rule has split into two halves. **Agent orchestration, tool-calling, and LLM-edge work reached full TS parity in 2025. Model *training* and classical-ML *fitting* did not.**

Evidence:

- **Claude Agent SDK** ships TypeScript and Python as equal first-class SDKs — same agent loop, MCP support, subagents, hooks, permissions ([Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview), [TS reference](https://platform.claude.com/docs/en/agent-sdk/typescript)). The TS package (`@anthropic-ai/claude-agent-sdk`) bundles a native binary; capability parity is explicit ([Morph comparison](https://www.morphllm.com/claude-agent-sdk)).
- **OpenAI Agents SDK for TypeScript** is a production release, not a port-in-progress: function tools with Zod schema generation, MCP integration, sessions, guardrails, handoffs, human-in-the-loop, tracing, and Realtime voice agents ([openai-agents-js](https://github.com/openai/openai-agents-js), [docs](https://openai.github.io/openai-agents-js/), [OpenAI announcement](https://openai.com/index/the-next-evolution-of-the-agents-sdk/)).
- **LangGraph.js** reached **core-feature parity** with Python (StateGraph, conditional edges, checkpointing, streaming, human-in-the-loop), and a `@langgraphjs/toolkit` layer adds agent templates (`createReactAgent`), long-term memory, token budgets and structured logging on top ([LangGraph.js guide 2026](https://langgraphjs.guide/), [Speakeasy agent-framework comparison](https://www.speakeasy.com/blog/ai-agent-framework-comparison)). **Honest caveat, unchanged in 2026:** the Python runtime remains *more mature* — the JS runtime is comparatively new, the long-tail integration catalog and multi-agent libraries (e.g. `langgraph-swarm`) are Python-first, and R&D examples skew Python ([Medium: stack choice Python vs JS](https://techwithibrahim.medium.com/choosing-your-stack-langchain-langgraph-in-python-vs-js-tyscript-0552256883d8)). This is a *depth* gap, not a *capability* gap, and it is the reason we lean on the Claude Agent SDK + our own thin orchestration rather than deep LangGraph coupling.
- **Mastra** (TS-native agent framework: durable workflows, pluggable Postgres memory, evals as primitives, built on Vercel AI SDK streaming) scores at/above the Python incumbents on developer-experience benchmarks and works in serverless where LangGraph Platform does not ([Particula comparison](https://particula.tech/blog/mastra-vs-langgraph-vs-vercel-ai-sdk-typescript-agents), [Speakeasy framework comparison](https://www.speakeasy.com/blog/ai-agent-framework-comparison)).
- **Local inference in Node is real now.** Transformers.js v4 (Hugging Face, npm) runs ONNX models in Node/Bun/Deno with a new WebGPU backend and broader model support (8B+ params); the `com.microsoft.MultiHeadAttention` operator gave ~4x speedup on BERT-class embedding models, and v4 cut bundle size 53% and build time from 2s to 200ms ([Transformers.js v4 announcement](https://huggingface.co/blog/transformersjs-v4), [repo](https://github.com/huggingface/transformers.js/)). **fastembed-js** runs BGE embedding *and* cross-encoder reranker models (`BAAI/bge-reranker-base`) locally via ONNX Runtime ([npm](https://www.npmjs.com/package/fastembed), [Qdrant fastembed rerankers](https://qdrant.tech/documentation/fastembed/fastembed-rerankers/)). **The hard limit to know:** Transformers.js is **inference-only** — you *fit/fine-tune in Python, convert to ONNX via Optimum, and load in Node* ([PkgPulse: Transformers.js vs ONNX Runtime 2026](https://www.pkgpulse.com/guides/transformersjs-vs-onnx-runtime-web-2026)). This is exactly the train-in-Python / score-in-Node seam we standardize on below.
- **MCP has a first-class TypeScript SDK, production-usable today.** `@modelcontextprotocol/sdk` v1.x is the supported production line and keeps getting fixes/security updates; the v2 SDK is in **beta** implementing the `2026-07-28` spec, with a stable v2 expected alongside that spec release and v1.x supported for ≥6 months after ([typescript-sdk repo](https://github.com/modelcontextprotocol/typescript-sdk), [2026-07-28 spec RC](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/), [npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk)). TS is a **Tier-1 SDK** expected to ship spec support within the release window. **Implication:** our planned MCP surface (wrapping route-derived tools) is native TS with no Python pull — but pin v1.x for now and treat v2 as a fast-follow once the spec stabilizes on 2026-07-28.

**Implication for Aegis:** the agent runtime — the thing closest to our core IP (four-gate enforcement, tool registry, audit-traced tool calls) — has zero Python pull. Building it in TS keeps it in-process with Casbin PEP, the route-walked tool registry, and the audit ledger, which is exactly what "the agent reasons; the governed core acts" requires.

### 1.2 Where Python remains genuinely stronger, and how teams bridge it

- **Classical ML fitting/statistics:** scikit-learn, statsmodels, Numba-accelerated libraries have no TS equivalents of comparable quality. Nixtla's statsforecast fits millions of series with AutoARIMA/AutoETS/MSTL, 20x faster than pmdarima, explicitly positioned as a Prophet replacement ([statsforecast](https://github.com/Nixtla/statsforecast)). Nothing in npm approaches this.
- **Probabilistic record linkage:** Splink (UK Ministry of Justice, MIT license) links ~1M records on a laptop in ~1 minute via DuckDB, scales to 100M+ on Spark/Athena ([splink](https://github.com/moj-analytical-services/splink), [Tilores library survey](https://tilores.io/content/best-open-source-entity-resolution-and-record-linkage-libraries-splink-zingg-dedupe-and-when-to-move-beyond-them/)). JS has building blocks (Talisman — [JOSS paper](https://joss.theoj.org/papers/10.21105/joss.02405), fast-fuzzy, Fuse.js) but no Fellegi–Sunter EM-trained linkage engine.
- **Online / streaming ML:** River and CapyMOA implement Online Isolation Forest and drift-adaptive stream learners ([Online-iForest, arXiv 2025](https://arxiv.org/html/2505.09593v1)); no maintained Node equivalent.
- **The standard bridge pattern** (industry consensus): Node stays the orchestration layer; Python services sit behind **gRPC for synchronous inference** and **Kafka for asynchronous scoring/batch** ([Confluent: event-driven microservices with Python and Kafka](https://www.confluent.io/blog/event-driven-microservices-with-python-and-kafka/), [gRPC microservices patterns](https://realpython.com/python-microservices-grpc/)). Fraud pipelines in production 2025 typically run Kafka → stream processor → Python scoring service with Redis as feature store ([Conduktor: real-time fraud detection](https://www.conduktor.io/glossary/real-time-fraud-detection-with-streaming), [IJERT Flink+Kafka fraud pipeline](https://www.ijert.org/from-streams-to-security-architecting-a-production-ready-fraud-pipeline-with-flink-and-kafka-ijertv15is030725)).

### 1.3 Where Go/Rust actually pay off — and why none of it applies to Aegis yet

The credible evidence for Go/Rust wins clusters in three places:

1. **LLM gateways at high RPS.** Bifrost (Go, Apache-2.0, Maxim AI) posts ~11µs gateway overhead and stable P99 ~1.6–1.7s at 5,000 RPS; in a 500-RPS EC2 t3.medium test it hit 424 req/s vs LiteLLM's 44.8 req/s (9.5x throughput), P99 1.68s vs 90.7s (54x), and 68% less peak memory (120MB vs 372MB) — and LiteLLM exhausted memory and crashed at 1,000 RPS in the published run ([Maxim benchmarks](https://www.getmaxim.ai/bifrost/resources/benchmarks), [LiteLLM vs Bifrost](https://dev.to/hadil/litellm-vs-bifrost-comparing-python-and-go-for-production-llm-gateways-4dg5), [bifrost repo](https://github.com/maximhq/bifrost)). **These are vendor (Maxim) benchmarks — treat the multiples as directional, not gospel (see §8 benchmark bias).** Portkey's gateway is also fully open-source Apache-2.0 with guardrails/PII redaction built in ([gateway rankings 2026](https://techsy.io/en/blog/best-llm-gateway-tools)). **Relevance to us: LiteLLM is a fine start; Bifrost is the drop-in self-hosted upgrade WHEN gateway P99 becomes a *measured* problem on our own traffic (see §5 triggers). This swaps a self-hosted component — it adds zero Go code to our codebase.**
2. **Vector search engines.** Qdrant's Rust core wins via SIMD distance calculations and purpose-built memory-mapped storage — but benchmarks show pgvector/pgvectorscale matching or beating dedicated DBs up to ~5M vectors, and pgvectorscale hitting 471 QPS @ 99% recall on 50M vectors (11.4x Qdrant's 41 QPS in that test) ([TigerData pgvector vs Qdrant](https://www.tigerdata.com/blog/pgvector-vs-qdrant), [Encore comparison](https://encore.dev/articles/pgvector-vs-qdrant), [2026 vector DB survey](https://www.kalviumlabs.ai/blog/vector-databases-compared-pgvector-pinecone-qdrant-weaviate/)). **Our per-tenant RAG corpora will sit in the thousands-to-low-millions of vectors for years. pgvector + RLS keeps tenant isolation in one enforcement plane — a governance win no dedicated vector DB offers. Stay.**
3. **Sustained CPU-bound hot paths.** For genuinely CPU-bound work (crypto, parsing, image processing) Rust runs ~5–10x faster than Node — no GC, zero-cost abstractions, direct memory ([mgsoftware: Rust vs Node 2026](https://www.mgsoftware.nl/en/vergelijking/rust-vs-nodejs)). But the honest migration write-ups concede the root causes were usually architecture, IO patterns, and sync-code traps, not the language ([kurrent.io: 2x read perf via Rust in a Node client](https://www.kurrent.io/blog/how-we-increased-the-read-performance-of-our-nodejs-client-by-2x-using-rust/), ["JavaScript wasn't the problem"](https://shivanjalispritualguidance.medium.com/we-migrated-from-node-js-to-rust-turns-out-javascript-wasnt-the-problem-36a6195da22e)). The winning pattern for Node shops is **Rust *inside* Node via napi-rs** — used by SWC, HF tokenizers, Cursor, LanceDB, Chroma ([NAPI-RS v3](https://napi.rs/blog/announce-v3)). The seam matters: **napi-rs has no JSON/message-passing boundary** — JS calls straight into compiled Rust and gets structured values back, unlike `worker_threads` where each worker is a full V8 isolate (~10MB overhead, tens-of-ms startup) ([Medium: 12x faster Node parser in Rust, Feb 2026](https://medium.com/@talhadotjs/building-a-12x-faster-parser-for-node-using-rust-108ef1bb5402)). So the decision rule is: **worker threads first** for embarrassingly-parallel CPU units (ONNX inference, large diffs); **napi-rs only** when the per-call overhead of a worker dominates or a tight inner loop survives algorithmic fixes. napi-rs v3 auto-generates TS definitions and can target WASM.

### 1.4 Node performance ceilings and mitigations for an agent-heavy platform

Key facts:

- Node's event loop is superb for I/O-heavy work — and **an agent platform is overwhelmingly I/O-bound**: LLM calls (hundreds of ms to tens of s), DB queries, HTTP tool calls, Kafka. The LLM's latency dominates everything; gateway/orchestrator CPU is noise.
- The failure mode is **event-loop blocking** by accidental CPU work: >100ms lag = something is blocking, >500ms = incident ([event-loop monitoring in production](https://dev.to/iwtxokhtd83/detecting-event-loop-blocking-in-production-nodejs-without-touching-your-code-32bo)). Known Aegis-relevant blockers: large JSON.parse/stringify of tool payloads, synchronous crypto for hash-chaining audit entries, local ONNX inference, big diff computations, Joi validation of huge bodies.
- Mitigations, in order: (1) `worker_threads` pools (via `piscina`) for CPU-bound units — this is what local embedding/rerank inference and large diffs should run on; worker threads are for CPU-bound work, *not* a general scaling strategy ([production checklist 2026](https://workforcenext.in/blog/nodejs-performance-scaling-production-checklist-2026/), [worker threads for CPU-bound tasks](https://dev.to/godofgeeks/nodejs-worker-threads-for-cpu-bound-tasks-j52)); (2) horizontal scaling — stateless Node services behind a load balancer (we have Kafka+outbox, so state lives in Postgres/Kafka anyway); (3) napi-rs native modules for hot inner loops; (4) extract a service only when a trigger in §5 fires.
- **Mandatory instrumentation from day one:** event-loop-lag histogram per service (`perf_hooks.monitorEventLoopDelay`), exported to metrics, alert at p99 > 100ms. This single metric is the tripwire for every migration trigger below.

---

## 2. The algorithm portfolio — per-capability decision table

For each complex algorithm Aegis needs: the TS-native option, the Python-needed option, the external-service option, and the pick. "Sidecar" = stateless Python worker per §4.

| # | Capability | TS-native | Python | External service | **Pick + rationale** |
|---|---|---|---|---|---|
| A1 | **Hybrid retrieval (BM25 + vector + RRF)** | Postgres-native: pgvector HNSW + BM25 extension (`pg_search`/ParadeDB, or `pg_textsearch`/TigerData, or fallback `ts_rank`) + RRF (`1/(k+rank)`, k=60) in SQL/TS. Fully expressible from Node. | Unneeded | Elasticsearch (rejected: second store, second tenancy model) | **TS + Postgres.** Hybrid search in Postgres is now mainstream ([ParadeDB hybrid-search manual](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual), [TigerData BM25+vector+RRF](https://www.tigerdata.com/blog/elasticsearchs-hybrid-search-now-in-postgres-bm25-vector-rrf), [100-line BM25+pgvector+RRF](https://dev.to/gabrielanhaia/hybrid-search-in-100-lines-bm25-pgvector-with-rrf-merge-58cn)). RLS applies to both legs — tenant isolation preserved in one plane. Start with `tsvector`/`ts_rank` if extension licensing (pg_search is AGPL-3.0 — verify) is a concern; RRF hides the ranker choice. |
| A2 | **Reranking (cross-encoder)** | fastembed-js or Transformers.js running `bge-reranker-base/v2-m3` ONNX in a worker thread ([fastembed npm](https://www.npmjs.com/package/fastembed), [Transformers.js v4](https://huggingface.co/blog/transformersjs-v4)) | sentence-transformers (no advantage for inference) | Cohere Rerank API — strongest quality, per-call cost ([Cohere rerank in Anthropic's tests](https://www.anthropic.com/news/contextual-retrieval)) | **TS-local ONNX first, Cohere as a per-tenant entitled upgrade.** Reranking is pure inference — Python adds nothing. Run in piscina worker pool; cap candidate set at ~50 docs. |
| A3 | **Contextual retrieval (Anthropic technique)** | Pure LLM-gateway calls at index time: prepend LLM-generated chunk context before embedding + BM25 indexing. 100% TS. | — | — | **TS.** Reranked contextual embeddings + contextual BM25 cut top-20 retrieval failure 67% (5.7%→1.9%) ([Anthropic](https://www.anthropic.com/news/contextual-retrieval)). This is our biggest cheap RAG win; it's prompt engineering + pipeline code, our home turf. Use prompt caching to keep indexing cost sane. |
| A4 | **Chunking strategies** | TS: semantic/recursive/markdown-aware chunkers exist in LangChain.js and are trivially hand-rolled; code-aware chunking via tree-sitter WASM or ast-grep bindings | Unneeded | Unstructured.io for gnarly PDF/Office parsing (optional) | **TS.** Chunking is deterministic text/AST manipulation. For document *parsing* (OCR, layout), buy (Unstructured/Azure Doc Intelligence) rather than build in any language. |
| A5 | **GraphRAG** | TypeGraph — TS-native, Postgres-backed, ships MCP server; early-stage, thin community ([TypeGraph survey](https://typegraph.ai/blog/best-open-source-graph-rag-tools)) | Microsoft graphrag (Leiden community detection + hierarchical summaries; expensive indexing) or LightRAG ([microsoft/graphrag](https://github.com/microsoft/graphrag)) | Neo4j+GDS (heavy) | **Defer, then Python sidecar for *indexing only*.** A systematic 2026 eval settles the "when": **GraphRAG's win is concentrated in multi-hop reasoning and grows with hop count (largest at 4-hop); vanilla/hybrid RAG is consistently as good or better for single-hop, detail-precise queries** ([RAG vs GraphRAG systematic eval, arXiv 2502.11371](https://arxiv.org/html/2502.11371v3)). Reranking + iterative retrieval lift *every* method, with the biggest absolute gains on multi-hop benchmarks — so exhaust rerank+contextual before adding a graph. WHEN multi-hop "explain this policy chain across modules" queries measurably fail (>20% of eval set) *after* rerank+contextual, run graphrag/LightRAG as a batch sidecar that *reads via scoped API, writes graph artifacts back through a TS ingestion endpoint* into Postgres; query-time traversal stays TS+SQL (recursive CTEs). LightRAG specifically merges graph structure with vector efficiency and exposes Naive/Local(multi-hop)/Global/Hybrid modes ([TDG: Vector vs Graph vs LightRAG](https://tdg-global.net/blog/analytics/vector-rag-vs-graph-rag-vs-lightrag/kenan-agyel/)). Re-evaluate TypeGraph in 6–12 months. |
| A6 | **Embeddings** | Transformers.js v4 / fastembed-js local ONNX (bge-small/base) in worker threads; or provider APIs via LiteLLM | Unneeded for inference | OpenAI/Voyage/Cohere embed APIs | **TS.** Local for cost-sensitive bulk indexing, API for quality-sensitive. Both from Node. |
| A7 | **Entity resolution / duplicate invoices** | Deterministic layer in TS+SQL: normalization, blocking keys (vendor_id + amount band + date window), exact/fuzzy compare via Talisman/fast-fuzzy, plus **embedding similarity via pgvector** (cheap, surprisingly strong) | **Splink** (MIT) — probabilistic Fellegi–Sunter linkage, EM-trained match weights, 1M records/min on DuckDB ([repo](https://github.com/moj-analytical-services/splink)); Zingg (ML-based, Spark-heavy, AGPL — pass) | Tilores et al. (SaaS — data-residency friction) | **Two-tier: TS rules+embeddings first (catches the easy 80% of duplicate invoices with explainable reasons — governance likes explainable), Splink sidecar WHEN probabilistic linkage across messy vendor masters is a sold module feature.** Splink runs batch: consumes candidate CSV/Parquet handed to it by a TS job via object storage, returns match scores; TS writes results through the governed core with audit entries. |
| A8 | **Anomaly/fraud detection on event streams** | Tier 1 (TS): rules-as-data engine we already have + streaming stats (Welford mean/variance, EWMA, percentile sketches like t-digest — all trivial in TS) over Kafka consumers. Covers threshold/velocity/SoD-violation detection with explainable outputs. | Tier 2 (Python sidecar): **River / CapyMOA Online Isolation Forest / EILOF** for drift-adaptive unsupervised scoring ([Online-iForest arXiv](https://arxiv.org/html/2505.09593v1)); scikit-learn IsolationForest batch-trained, exported to **ONNX and scored in Node** (train-in-Python/score-in-TS is the sweet spot) | Flink ML (operationally heavy — reject until stream volume demands it) | **TS rules first (they're auditable and map to our approvals engine), then batch-train Isolation Forest in a Python job → ONNX → score in Node consumers.** Full online learning (River sidecar consuming Kafka directly) only WHEN drift makes weekly retraining insufficient. This is the documented production shape: Kafka + River behind a FastAPI scorer sustains >500 tx/s at <250ms with ~94% precision / ~92% recall, and Kafka Streams beats Spark/Flink micro-batch on latency for this job ([Conduktor](https://www.conduktor.io/glossary/real-time-fraud-detection-with-streaming), [streaming online-learning fraud framework, 2026](https://theusajournals.com/index.php/ajast/article/view/8204)). |
| A9 | **Forecasting (FinOps: spend, budget burn, usage)** | TS has only toy options (simple ETS/Holt-Winters ports). Fine for sparklines, not for shipped forecasts. | **Nixtla statsforecast** (Apache-2.0): AutoARIMA/AutoETS/MSTL/Theta, millions of series, Numba-fast ([repo](https://github.com/Nixtla/statsforecast)); neuralforecast/TimeGPT for the fancy tier | Nixtla TimeGPT API (foundation model, zero infra) | **Python sidecar — the clearest Python win in the portfolio.** Batch/queue shape fits perfectly: nightly or on-demand Kafka job, input = tenant-scoped aggregates handed over by TS, output = forecast rows written back via governed API. Consider TimeGPT API as the zero-ops v1. |
| A10 | **Text-to-SQL (analytics agent)** | Build on our own substrate: schema+**semantic-layer** RAG (pgvector) + LLM via gateway + **validation loop** (EXPLAIN parse-check, `pg_query`/libpg_query WASM AST inspection, read-only role, RLS still applies!) — Vanna's architecture, reimplemented thin in TS. Many TS text-to-SQL projects exist but none dominant ([Vanna](https://github.com/vanna-ai/vanna), [NL2SQL dissection](https://sudiptapathak.com/blog/dissecting-open-source-nl2sql/)) | Vanna (MIT, agentic retrieval, 2.0 rewrite) — adoptable as sidecar but drags Python into a *core UX* path | WrenAI (semantic-layer MDL approach — inspiration for our semantic layer, not adoption) | **TS-native build.** The 2026 evidence hardens two design calls. **(1) A semantic layer is the single biggest accuracy lever** — Claude Sonnet 4.6 jumps 90.0%→98.2% and GPT-5.3-Codex 84.1%→100% when queries hit a governed semantic layer instead of raw text-to-SQL ([dbt: Semantic Layer vs Text-to-SQL 2026](https://docs.getdbt.com/blog/semantic-layer-vs-text-to-sql-2026), [MotherDuck: your data model is the semantic layer](https://motherduck.com/blog/bird-bench-and-data-models/)). **(2) Context strategy beats model choice** — the strongest BIRD systems (AskData ~82%) win via DB-profiling + query-log mining + SQL-to-text metadata and *dual-retrieval of schema + knowledge docs* (the DRAG paradigm), not a bigger model ([BIRD-bench](https://bird-bench.github.io/), [DRAG/enterprise text-to-SQL, OpenReview](https://openreview.net/forum?id=gXkIkSN2Ha)). **So build the semantic layer first, then a thin TS retrieval+validation loop over it.** Our self-knowledge RAG + governance makes this a differentiator: generated SQL executes under the requesting principal's RLS context through a read-only pool — a guarantee a Python-side Vanna can't give without violating our DB-access rule. Enterprise accuracy still hits a cliff on ambiguous questions ([BIRD-Interact, ICLR 2026](https://bird-bench.github.io/)), so gate every generated query behind EXPLAIN + read-only + human-visible SQL. |
| A11 | **Diff/patch for auto-fix** | **jsdiff** (BSD-3, Myers diff, types since v8 — [repo](https://github.com/kpdecker/jsdiff)); **@sanity/diff-match-patch** (TS fork of Google DMP for fuzzy patching — [npm](https://www.npmjs.com/package/@sanity/diff-match-patch)); **ast-grep** (MIT, Rust core with first-class Node bindings; structural search/rewrite; jssg gives jscodeshift-style typed codemods — [announcement](https://codemod.com/blog/jssg)) | Unneeded | — | **TS (with Rust inside via ast-grep's napi bindings).** Line diffs: jsdiff. Fuzzy application of LLM-generated patches: diff-match-patch's fuzzy patch with match tolerance. Structural rule-driven rewrites (config auto-fix, codemods on tenant workflow definitions): ast-grep. All auto-fix output flows through @aegis/approvals as a proposed change — never direct apply. |
| A12 | **Agent runtime / orchestration** | Claude Agent SDK TS + our four-gate wrapper; Mastra patterns for durable workflows; LangGraph.js if graph-shaped orchestration needed | Parity exists but no advantage; splitting runtime from governed core would be an architecture failure | — | **TS, non-negotiable.** The runtime must sit in-process with PEP, tool registry, and audit ledger. §1.1 shows zero capability gap. |

---

## 3. THE VERDICT — decision table

| Decision | Ruling | Why |
|---|---|---|
| **TS/Node as the spine** | **KEEP — permanent** | (1) The governed core (RLS, Casbin, audit ledger, approvals, workflow engine, connectors, entitlement) is TS and is the moat; splitting authz across languages multiplies attack surface. (2) Agent SDKs, MCP TS SDK, local ONNX inference all first-class in TS (§1.1). (3) Agent workloads are I/O-bound — Node's home game. (4) One language = one CI, one type system end-to-end (Zod/Joi → tool schemas → UI), faster for a small team. |
| **Python sidecar workers** | **ADD for: forecasting (statsforecast), probabilistic entity resolution (Splink), anomaly-model training (scikit-learn/River), GraphRAG indexing (graphrag/LightRAG)** | Each is a genuine ecosystem gap (§2 A5/A7/A8/A9). All four are batch/queue-shaped — no sidecar sits on a user-facing latency path. Integration per §4: Kafka jobs + scoped HTTP, service tokens, no DB access. Prefer train-in-Python → export ONNX → score-in-Node wherever the algorithm allows (Isolation Forest: yes; ARIMA: no, keep in sidecar). |
| **Go/Rust services** | **NOT NOW — one contingency** | No Aegis workload shows the sustained-CPU or extreme-RPS profile where Go/Rust wins are real (§1.3). Contingency: swap LiteLLM for **Bifrost (Go, self-hosted binary)** when gateway triggers fire — that's an infra component swap, zero Go authored by us. |
| **Rust inside Node (napi-rs)** | **YES, opportunistically, as dependencies** | Already implicitly adopted: ast-grep, HF tokenizers, ONNX runtime bindings are Rust under TS APIs. Author our own napi-rs module only if a profiled hot loop survives worker-thread + algorithmic optimization (unlikely before Series-B scale). |
| **Rewrites** | **NEVER** | Every credible post-mortem attributes most "Node was slow" wins to fixed architecture, not language (§1.3). Rewrites of the governed core would forfeit the audit/authz maturity that is the product. |
| **Complex algorithms** | **ADOPT AGGRESSIVELY — in whichever language §2 says** | The founder's instinct is right: hybrid+rerank+contextual RAG, Isolation Forest scoring, Splink linkage, statsforecast, structural diff — all named, all sourced, all integrated without compromising the core. The stack question and the algorithm-ambition question are independent; the seams below make them so. |

---

## 4. Polyglot integration architecture — how non-TS workers plug in without breaking the governed core

### 4.1 The iron rules

1. **No non-TS process ever holds a Postgres connection.** RLS tenancy is enforced by the TS data layer; a Python worker with a DB string is a tenancy bypass waiting to happen.
2. **No non-TS process ever makes an authz decision or carries a principal.** Sidecars are *calculators*: data in, scores/artifacts out. The TS caller resolves tenant, permission, and purpose *before* dispatch and stamps the job envelope.
3. **Every sidecar invocation is an audited tool call.** Dispatch and result-ingestion both write audit-ledger entries (job id, tenant, input hash, model/library version, output hash) — same hash chain as agent tool calls. Model version in the audit record makes ML outputs reproducible/contestable — a governance selling point.
4. **Results re-enter only through governed TS endpoints.** A sidecar cannot "write back"; it returns a payload the TS job validates (Zod), authorizes, and persists. High-impact outputs (e.g., "block this invoice as duplicate") route through @aegis/approvals like any risky agent action.

### 4.2 The four seams (all language-agnostic)

| Seam | Use for | Contract | Notes |
|---|---|---|---|
| **Kafka (primary)** | Batch scoring, forecasting runs, ER jobs, GraphRAG indexing | `aegis.jobs.<capability>.request` / `.result` topics; envelope: `{job_id, tenant_id, capability, input_ref, params, service_token, schema_version}`; CloudEvents-style, versioned JSON Schema | Reuses our outbox + retry + DLQ machinery. Big inputs passed as `input_ref` = pre-signed object-storage URL of a tenant-scoped extract produced by TS (sidecar never queries anything). |
| **HTTP (sync, internal)** | Low-latency scoring if ever needed (e.g., per-event fraud score <50ms) | OpenAPI-specced FastAPI service; mTLS + short-lived service token (JWT, `svc:` principal, capability-scoped); called only by TS services | Keep stateless; deploy as separate container with its own resource limits so Python GIL/memory issues can't starve Node. |
| **gRPC** | Same as HTTP when payloads are large/streamy | Protobuf schemas in the monorepo (`libs/contracts/proto`), codegen for TS+Python | Adopt only if HTTP+JSON measurably hurts; don't pay the tooling tax speculatively ([gRPC vs Kafka guidance](https://tsh.io/blog/grpc-tutorial)). |
| **MCP** | Exposing a sidecar's capability *to agents* | Sidecar is NOT an MCP server. The TS core wraps the sidecar behind a normal registry tool (`forecast.spend_projection`), so it inherits authz-binding, four-gate checks, entitlement, and audit like every route-derived tool | This keeps the tool registry the single source of agent capability — no side-channel tools. |

### 4.3 Nx monorepo placement

```
apps/
  workers-py/            # one Python uv-managed project, one container image
    forecasting/         # statsforecast job handlers
    entity_resolution/   # splink job handlers
    anomaly_train/       # sklearn/river training jobs → ONNX artifacts
    graphrag_indexer/    # ms-graphrag/lightrag batch indexer
libs/
  contracts/jobs/        # JSON Schemas + generated TS (Zod) & Python (pydantic) types
  contracts/proto/       # if/when gRPC
```

One image, one deploy unit, handlers registered per capability — sidecars stay operationally boring. Nx can orchestrate Python targets via `@nxlv/python` or plain run-commands; CI runs pytest + schema-compat checks against `contracts/jobs`.

### 4.4 Tenancy & security checklist for any new sidecar (copy into PR template)

- [ ] Consumes only `input_ref` extracts produced by a TS job under the tenant's RLS context
- [ ] Service token is capability- and tenant-scoped, TTL ≤ 15 min, minted per job
- [ ] No DB creds, no LLM keys (LLM calls, if any, go through the gateway with the job's budget tag)
- [ ] Output validated by Zod schema; risky effects routed through @aegis/approvals
- [ ] Audit entries on dispatch + ingestion incl. library/model version
- [ ] Per-tenant job quotas + cost metering (entitlement check before dispatch)

---

## 5. Migration triggers — "move it WHEN metric X"

Do not migrate on vibes. Each row names the tripwire metric, measured by the day-one instrumentation from §1.4.

| Component | Move to | Trigger (sustained ≥1 week, after profiling rules out app bugs) |
|---|---|---|
| LLM gateway (LiteLLM) | Bifrost (Go, self-hosted) or Portkey OSS | Gateway-added P99 latency > 150ms, OR gateway CPU-bound below 500 RPS, OR gateway instance count > 4 just for throughput |
| Local ONNX inference in worker threads | Dedicated inference service (Python/Triton or TEI) | Embedding/rerank queue wait p95 > 2s during indexing bursts, OR inference workers evict Node heap (RSS pressure alerts), OR need GPU batching |
| pgvector | pgvectorscale first; Qdrant only after | > ~5M vectors per active search surface with p95 > 100ms after HNSW tuning; Qdrant only past ~50M+ vectors or QPS pgvectorscale can't hold ([benchmarks](https://www.tigerdata.com/blog/pgvector-vs-qdrant)) |
| TS rules-based anomaly detection | ONNX-scored Isolation Forest (already planned Tier 2) → River online-learning sidecar | Rule precision < 80% on labeled feedback, OR analysts report drift faster than weekly retrain cadence |
| TS deterministic entity resolution | Splink sidecar | Duplicate-invoice recall < target (say 90%) on eval set, OR a customer's vendor master > 1M rows needs probabilistic linkage |
| Hybrid RAG (no graph) | GraphRAG indexing sidecar | > 20% failure rate on multi-hop questions in the retrieval eval set (Langfuse/Promptfoo), AND rerank+contextual already deployed |
| Any Node service | Split/optimize (not rewrite) | Event-loop lag p99 > 100ms sustained; first response is always: find the blocking code, move it to a worker thread |
| Text-to-SQL TS build | Vanna sidecar | Execution-accuracy on our eval set < 75% after 2 iterations of context-strategy improvement (unlikely per research — context beats framework) |
| Kafka consumers (KafkaJS/confluent-js) | Flink or Go consumer | Single-partition consumer CPU-bound > 10k events/s with worker offload exhausted — far beyond near-term volumes |

---

## 6. Honest limits — where TS is genuinely weaker (do not paper over these)

1. **No credible training/statistics ecosystem.** Anything that *fits* a model — ARIMA, EM match weights, Isolation Forest training, fine-tuning — is Python or bust. Our pattern (train in Python, score via ONNX in Node) covers inference but not the training loop itself.
2. **Data-wrangling ergonomics.** pandas/polars-python for exploratory feature work has no TS peer (nodejs-polars exists but is thin ecosystem-wise). Sidecar notebooks will be Python; accept it.
3. **The long tail of AI research code ships Python-first.** New paper implementations (rerankers, ER models, graph algorithms) land on PyPI months before npm, if ever. Our sidecar seam is the standing answer; budget for it rather than fighting it.
4. **GC pauses & single-threaded hot paths** put a real ceiling on any future sustained-CPU feature (heavy crypto, massive graph traversal in-process). Mitigations exist (§1.4) but a team that ignores event-loop hygiene will hit them; the p99-lag alert is non-optional.
5. **LangGraph.js community depth** trails Python — fewer examples, integrations, Stack Overflow answers ([forum thread](https://forum.langchain.com/t/is-langgraph-js-a-first-class-citizen/478)). Mitigated by leaning on Claude Agent SDK + our own thin orchestration rather than deep LangGraph coupling.
6. **TypeGraph (TS GraphRAG) is not battle-tested** — early stage, small community ([survey](https://typegraph.ai/blog/best-open-source-graph-rag-tools)). Hence the defer-then-Python call in §2 A5.

---

## 7. Adoption candidates (repo / license / fit / verdict)

| Project | Lang | License | Fit | Verdict |
|---|---|---|---|---|
| [@anthropic-ai/claude-agent-sdk](https://platform.claude.com/docs/en/agent-sdk/typescript) | TS | Anthropic SDK license | Agent runtime loop, subagents, hooks, MCP | **ADOPT** (already planned) |
| [openai-agents-js](https://github.com/openai/openai-agents-js) | TS | MIT | Fallback/secondary provider agent loop, guardrail patterns | **WATCH** — steal guardrail/handoff patterns |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | TS | MIT | Graph orchestration if workflows outgrow rules-as-data engine | **WATCH** — don't couple deeply |
| [Mastra](https://github.com/mastra-ai/mastra) | TS | verify (Apache-2.0/ELv2 history) | Durable-workflow + evals-as-primitive *patterns* | **INSPIRE** — copy patterns, keep our engine |
| [Transformers.js v4](https://github.com/huggingface/transformers.js/) | TS (Rust/ONNX inside) | Apache-2.0 | Local embeddings, rerankers, small classifiers in Node | **ADOPT** |
| [fastembed-js](https://www.npmjs.com/package/fastembed) | TS | Apache-2.0 | Lean BGE embed + bge-reranker local inference | **ADOPT** (pick one of Transformers.js/fastembed after a bake-off) |
| [pgvector](https://github.com/pgvector/pgvector) + pgvectorscale | C/Rust ext | PostgreSQL/ Timescale | Vector leg of hybrid search under RLS | **ADOPT** (already planned) |
| [ParadeDB pg_search](https://github.com/paradedb/paradedb) (Tantivy/Rust BM25) or [pg_textsearch](https://www.tigerdata.com/blog/introducing-pg_textsearch-true-bm25-ranking-hybrid-retrieval-postgres) | Postgres ext | **AGPL-3.0** (+ commercial) — confirmed | True BM25 leg of hybrid search | **TRIAL** — fallback `tsvector`/`ts_rank` day one; pg_search is AGPL-3.0 so a self-hosted managed-Postgres deployment needs **legal sign-off or a commercial license** before adoption ([license](https://github.com/paradedb/paradedb)). RRF hides which lexical ranker we use, so this swap is non-disruptive. |
| [Splink](https://github.com/moj-analytical-services/splink) | Python | MIT | Probabilistic dedup/linkage (invoices, vendors, counterparties) | **ADOPT (sidecar, phase 2)** |
| [Zingg](https://www.zingg.ai/) | Python/Spark | AGPL-3.0 | Same space, Spark-heavy | **REJECT** — license + infra weight |
| [statsforecast](https://github.com/Nixtla/statsforecast) | Python | Apache-2.0 | FinOps forecasting sidecar | **ADOPT (sidecar)**; TimeGPT API as zero-ops v1 |
| [River](https://riverml.xyz) / [CapyMOA Online-iForest](https://arxiv.org/html/2505.09593v1) | Python | BSD-3 | Drift-adaptive stream anomaly models | **ADOPT (phase 3, training-side)** |
| [Vanna](https://github.com/vanna-ai/vanna) | Python | MIT | Text-to-SQL reference architecture | **INSPIRE** — rebuild thin in TS (§2 A10) |
| [WrenAI MDL](https://www.getwren.ai/post/wren-ai-vs-vanna-the-enterprise-guide-to-choosing-a-text-to-sql-solution) | — | AGPL-3.0 | Semantic-layer design for analytics agent | **INSPIRE** |
| [Microsoft graphrag](https://github.com/microsoft/graphrag) / LightRAG | Python | MIT | Graph indexing sidecar (deferred) | **WATCH → ADOPT on trigger** |
| [TypeGraph](https://typegraph.ai/blog/best-open-source-graph-rag-tools) | TS | verify | TS-native GraphRAG on Postgres + MCP | **WATCH** (re-check H1 2027) |
| [jsdiff](https://github.com/kpdecker/jsdiff) | TS | BSD-3 | Line/word diffs for auto-fix proposals | **ADOPT** |
| [@sanity/diff-match-patch](https://www.npmjs.com/package/@sanity/diff-match-patch) | TS | Apache-2.0 | Fuzzy application of LLM patches | **ADOPT** |
| [ast-grep + jssg](https://codemod.com/blog/jssg) | Rust (napi) | MIT | Structural search/rewrite, typed codemods | **ADOPT** |
| [Bifrost](https://www.truefoundry.com/blog/bifrost-vs-litellm) | Go | Apache-2.0 | LiteLLM replacement on perf trigger | **CONTINGENCY** |
| [napi-rs](https://github.com/napi-rs/napi-rs) | Rust | MIT | Author own native modules (last resort) | **CONTINGENCY** |
| [Talisman](https://joss.theoj.org/papers/10.21105/joss.02405) / fast-fuzzy | JS | MIT | Fuzzy-compare primitives for TS ER tier | **ADOPT (small)** |

---

## 8. Risks

- **Sidecar scope creep.** The #1 failure mode: Python workers accreting business logic until there are two half-governed backends. Enforcement: §4.1 rules in CI (lint: no `psycopg`/`sqlalchemy`/DB env vars in `workers-py`), the §4.4 checklist as a required PR gate, and a standing rule that a sidecar > ~1.5k LOC of non-glue logic triggers an architecture review.
- **License traps.** pg_search (AGPL), Zingg (AGPL), WrenAI (AGPL) — AGPL server-side extensions in a multi-tenant SaaS need explicit legal review before adoption; the doc marks fallbacks for each.
- **ONNX model-ops immaturity in Node.** Version pinning, model download at boot, memory sizing of ONNX sessions in worker threads — less-trodden than Python. Mitigate: bake models into images, health-check inference at startup, RSS alerts.
- **Benchmark literature bias.** Vendor benchmarks (Bifrost by Maxim, pgvectorscale by Timescale) flatter their authors; every §5 trigger requires reproducing the bottleneck on *our* workload before acting.
- **Single-language hiring optics.** "TS for ML-adjacent work" occasionally costs credibility with ML hires; the sidecar lane doubles as the place ML specialists are productive on day one.
- **Two runtimes = two supply chains.** npm + PyPI both need audit/scanning (socket/dependabot + pip-audit) and SBOM coverage; budget it in phase 1, not later.

---

## 9. Phased build outline

**Phase 1 — Spine hardening + RAG v1 (now → +6 weeks)**
- Event-loop-lag + gateway-latency instrumentation & alerts (§1.4) across all Node services.
- Hybrid retrieval in Postgres: pgvector HNSW + `tsvector` + RRF; contextual-retrieval indexing pipeline via LLM gateway with prompt caching (A1, A3).
- Local rerank/embed in piscina worker pool; bake-off Transformers.js v4 vs fastembed-js (A2, A6). Retrieval eval set in Promptfoo/Langfuse (this eval set later powers the §5 GraphRAG/ER triggers).
- Adopt jsdiff + diff-match-patch + ast-grep in the auto-fix path, all outputs routed through @aegis/approvals (A11).
- CI guards: `workers-py` lint rules, `contracts/jobs` schema-compat check, pip-audit/SBOM.

**Phase 2 — First sidecars, batch-shaped (+6 → +14 weeks)**
- `apps/workers-py` skeleton + Kafka job envelope + service-token minting + audit-on-dispatch/ingest (§4).
- Forecasting sidecar: statsforecast (or TimeGPT API first) for FinOps module (A9).
- Entity-resolution tier 1 in TS (blocking + fuzzy + pgvector similarity) for duplicate invoices; measure recall on labeled set (A7).
- Anomaly tier 1: TS streaming stats + rules over Kafka; start collecting labeled feedback (A8).
- Text-to-SQL v1 in TS: **semantic layer first** (the dominant accuracy lever per 2026 benchmarks), then schema+knowledge dual-retrieval + validation loop + read-only RLS execution, with generated SQL shown to the user (A10).

**Phase 3 — Trigger-driven upgrades (+14 weeks →, each item only if its §5 trigger fires)**
- Splink sidecar behind the same job seam (A7 tier 2).
- Isolation Forest: Python training job → ONNX artifact → Node consumer scoring (A8 tier 2); River online learning only on drift evidence.
- GraphRAG indexing sidecar (Microsoft graphrag or LightRAG) writing graph artifacts through TS ingestion; TS/SQL query-time traversal (A5).
- Gateway swap LiteLLM → Bifrost if perf trigger fires; pgvector → pgvectorscale on vector-scale trigger.
- Re-evaluate TypeGraph and TS-ecosystem gaps; retire this doc's "honest limits" entries that have closed.

---

*Sources are linked inline throughout; primary references: [Anthropic contextual retrieval](https://www.anthropic.com/news/contextual-retrieval), [ParadeDB hybrid search manual](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual), [TigerData pgvector vs Qdrant](https://www.tigerdata.com/blog/pgvector-vs-qdrant), [Splink](https://github.com/moj-analytical-services/splink), [statsforecast](https://github.com/Nixtla/statsforecast), [Transformers.js v4](https://huggingface.co/blog/transformersjs-v4), [LiteLLM vs Bifrost](https://dev.to/hadil/litellm-vs-bifrost-comparing-python-and-go-for-production-llm-gateways-4dg5), [NAPI-RS v3](https://napi.rs/blog/announce-v3), [openai-agents-js](https://github.com/openai/openai-agents-js), [LangGraph JS/Python parity changelog](https://changelog.langchain.com/announcements/langgraph-workflow-updates-python-js).*

---

## Red-team correction (READ BEFORE IMPLEMENTING)

**Verdict:** The core call is *sound and the "TS for ~90%" claim is honest* — the four Python sidecars are real ecosystem gaps and the "never rewrite / never let non-TS hold DB or authz" rule is the right spine. But the doc's **integration boundary is the actual risk surface and it is under-specified**, and two "no sidecar is on a latency path" / hop-count claims are over-stated. Fix the boundary before writing a line of `workers-py`; the language debate is settled, the *data-egress and lifecycle* debate is not.

**Ranked top fixes**
1. **Specify the `input_ref` extract as a first-class governed artifact, not a footnote.** The instant TS writes a "tenant-scoped extract" to object storage behind a pre-signed URL, tenant isolation no longer rests on RLS — it rests on (a) the extract query being correct, (b) bucket/prefix ACLs, (c) URL TTL, (d) server-side encryption + per-tenant key scoping. That is a *second, weaker isolation plane* the doc does not admit. Required: per-tenant bucket prefixes, extract query generated by the same `withTenantTransaction` path (never hand-written), TTL ≤ job SLA, encryption-at-rest with tenant-scoped keys, and an audit entry binding `input_ref → tenant_id → row-count → content hash`.
2. **Answer GDPR erasure / retention / residency for every derived copy.** Extracts, ONNX training corpora, GraphRAG graph artifacts, forecast input aggregates, and the audit rows that hash them are all *new copies of tenant data outside the RLS plane*. The founder mandate flags erasure-vs-immutable-ledger as a known conflict; this doc silently *multiplies* the copies with zero retention/erasure/residency policy. Minimum: TTL + hard-delete on all extracts, a documented stance on whether an erasure request must purge training corpora and retrain, and residency pinning of the object store + sidecar compute to the tenant's region.
3. **Delete or scope the false blanket claim "no sidecar sits on a user-facing latency path" (§3).** The doc contradicts itself: §4.2 HTTP seam is explicitly for "per-event fraud score <50ms" and A2/A6 put ONNX rerank/embed *inline on the RAG query path* in worker pools. Restate as: *the four Python sidecars are batch-shaped; local ONNX inference is on the latency path but stays in-process (worker threads), not in a Python sidecar.* As written it's an over-claim.
4. **Add the missing failure-mode section: what happens when a sidecar is wrong, slow, or down.** No SLA, timeout, circuit-breaker, poison-message/DLQ-replay, or model-rollback story. A stale/mis-trained Isolation Forest or forecast that flows back through `@aegis/approvals` is a *governance* failure, not just an ops one. Every sidecar result needs a confidence/version stamp, a staleness bound, and a defined degraded-mode (fall back to TS Tier-1 rules).
5. **Apply the vendor-bias caveat consistently.** The doc rightly flags Bifrost (Maxim) and pgvectorscale (Timescale) as vendor benchmarks — then quotes **Splink "1M records/min on a laptop", statsforecast "20x faster than pmdarima", and the "Kafka+River >500 tx/s @ <250ms, 94%/92%" fraud figure** as if neutral. Same disclaimer, or drop the multiples.
6. **Correct the GraphRAG citation.** arXiv 2502.11371 supports "GraphRAG wins multi-hop, RAG wins single-hop, rerank/iterative lifts all methods." It does **not** support "the win grows with hop count, largest at 4-hop" — the paper analyzes categorical task types, not a hop-count gradient. Remove "(largest at 4-hop)" or cite a source that measures it.

**Key holes (security / feasibility / gaps)**
- *Security:* the extract/object-store egress path is the real tenancy attack surface, not the DB (which RLS covers). Pre-signed URL leakage, cross-tenant prefix misconfig, or an over-broad extract query each bypass RLS entirely. Untrusted connector data flowing into extracts → sidecars → back through TS is also a prompt-injection / data-poisoning vector for the ML training path (a mis-labeled feedback stream silently degrades the fraud model).
- *Feasibility:* "one Python image, one deploy unit, operationally boring" undersells ONNX/model-ops (versioning, drift, rollback, GPU batching), two-supply-chain security (npm+PyPI SBOM/scanning is named but not resourced), and the fact that River-online-learning-consuming-Kafka *does* hold state and *does* sit closer to real-time than "batch" implies.
- *Gaps:* no sidecar failure/timeout/degraded-mode; no data-lifecycle for derived copies; no cost ceiling on contextual-retrieval indexing (LLM call per chunk at index time can dominate spend — flagged only as "keep sane"); MCP SDK v1→v2 migration is a real dependency risk parked as a "fast-follow."

**Where a human or a different approach is genuinely needed**
- **Legal/DPO human, not the engineer:** AGPL sign-off (pg_search/Zingg/WrenAI — correctly flagged) *and* the erasure-vs-audit-ledger + derived-copy retention/residency decision. These are policy calls, not architecture calls.
- **A security review of the extract seam specifically** before Phase 2 — treat the object-store egress path as its own threat model, separate from RLS.
- **Different approach for the single-human SMB tenant:** any sidecar output that routes "block this invoice as duplicate / flag this as fraud" through `@aegis/approvals` assumes a second human to approve. In a one-person tenant the proposer *is* the approver — the ML sidecar becomes an unchecked autonomous actor unless the propose-only/read-only default holds and the human explicitly self-approves with the SQL/score visible.
- **Different approach for ML correctness:** identity/SoD controls do not make a model *right*. A wrong-but-confident forecast or ER match is deterministic and audited yet still wrong; verification of ML outputs needs an independent, environment-grounded check (labeled eval gates, not just "audit the version").
