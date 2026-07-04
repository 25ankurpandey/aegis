# Aegis agentic-loop demo (`agent-loop-demo.ts`)

> Distinct from the curl walkthrough suite documented in [`README.md`](./README.md) (which drives the
> *running* stack). This one is a **self-contained in-process** demo of the governed agent loop — it
> needs no stack, no keys, and no network.

A runnable demo of the **whole governed agent loop** in one process:

```
user message (English)
  -> the LLM (real gateway OR a deterministic offline stub) picks among the FILTERED tools
    -> runAgentTurn invokes the chosen tool through the SAME guarded HTTP route a human hits
       (context -> authenticate -> authorize(Casbin PEP) -> validate -> handler -> errorMiddleware)
      -> the governed result (HTTP status + body) is pretty-printed
```

It spins up a small in-process, **governed** expense-like Express app (identical in shape to
`libs/ai-core/test/tool-loop.spec.ts`), an in-memory Casbin PEP (`createInMemoryEnforcer`/`setEnforcer`),
and signed JWTs, then runs `runAgentTurn` for several English messages.

## What it demonstrates

- **The agent reasons; the governed core acts.** The model only ever *chooses*; every actual call goes
  through `invokeTool`, i.e. the real guarded route.
- **Per-principal tool filtering.** A manager is offered both tools; a viewer is offered only the read
  tool — the model is never shown a tool the principal may not use.
- **No bypass — governance is at the route, not the model.** One scenario shows the create tool *offered*
  to the model, but the request runs as a *viewer*: the PEP denies it at execution time (**403**).
- **Refuse-on-unknown.** The orchestrator never invents a tool; anything outside the filtered offer is a
  natural-language reply / refusal with no HTTP call made.

Scenarios and expected governed outcomes:

| # | Message | Principal | Governed result |
|---|---------|-----------|-----------------|
| 1 | "file an expense for $1500" | manager | **201** created |
| 2 | "show me expense <uuid>" | manager | **200** read |
| 3 | "file an expense for $999" | viewer | reply — create tool not offered, no HTTP |
| 4 | "file an expense for $2000" (runs as viewer) | manager offer | **403** PEP denies at the route |
| 5 | "what is the capital of France?" | manager | reply, no tool call |

## Run it offline (zero external deps, no keys, no network)

The offline stub `LlmClient` deterministically maps the example prompts to a tool choice, so the demo
runs with no gateway. From the repo root. The repo ships only `tsconfig.base.json` (no root
`tsconfig.json`), so point ts-node at it and load `tsconfig-paths` so the `@aegis/*` aliases resolve:

```bash
TS_NODE_PROJECT=tsconfig.base.json \
TS_NODE_TRANSPILE_ONLY=true \
TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' \
node -r ts-node/register -r tsconfig-paths/register scripts/demo/agent-loop-demo.ts
```

You should see step 1 print `Governed HTTP: 201`, step 2 `200`, and step 4 `403`.

### Or run it as a test (also verifies it)

`libs/ai-core/test/demo.spec.ts` imports the exported `runDemo()` and asserts the governed statuses:

```bash
npx nx test ai-core --skip-nx-cache --testPathPattern demo.spec
```

## Point it at a real LiteLLM / OpenAI gateway

Set these env vars and the harness swaps the stub for `OpenAiCompatibleLlmClient` — this single adapter
covers OpenAI itself and every OpenAI-compatible gateway (LiteLLM, OpenRouter, vLLM, ...):

| Env var | Meaning | Default |
|---------|---------|---------|
| `AEGIS_LLM_BASE_URL` | Gateway base URL, e.g. `https://api.openai.com/v1` or a LiteLLM proxy `http://localhost:4000` | — (unset ⇒ offline stub) |
| `AEGIS_LLM_API_KEY` | Gateway API key (sent as `Authorization: Bearer`) | — (unset ⇒ offline stub) |
| `AEGIS_LLM_MODEL` | Model id / LiteLLM route name | `gpt-4o-mini` |

```bash
AEGIS_LLM_BASE_URL=https://api.openai.com/v1 \
AEGIS_LLM_API_KEY=sk-... \
AEGIS_LLM_MODEL=gpt-4o-mini \
TS_NODE_PROJECT=tsconfig.base.json \
TS_NODE_TRANSPILE_ONLY=true \
TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' \
  node -r ts-node/register -r tsconfig-paths/register scripts/demo/agent-loop-demo.ts
```

The governance is identical in both modes — only tool *selection* differs. Even with a real model, the
core still enforces authz/validation at the route, so an unauthorized or malformed call is denied
regardless of what the model chose.
