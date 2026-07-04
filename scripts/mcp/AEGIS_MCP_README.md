# Aegis MCP stdio server

Make the Aegis governed tool registry driveable by a **real MCP client** (Claude Desktop, an IDE,
another agent) over **stdio**. The server (`aegis-mcp-stdio.ts`) exposes the auto-generated,
authz-bound tools via `tools/list` and routes every `tools/call` through the **same guarded HTTP
route a human hits**:

```
context → authenticate → authorize(PEP) → validate → RLS → handler → audit
```

**MCP is a discovery + invocation surface only — it grants no authority.** The MCP client is just
another principal wielding a delegated bearer token. There is no bypass: the load-bearing gates
(the PEP for authz, `validate()` for input) run at execution time inside the governed core, exactly
as for a human caller. See `scripts/mcp/aegis-mcp-stdio.ts` and
`libs/ai-core/src/mcp/mcp-tool-server.ts`.

---

## Two modes (chosen from env)

The same binary works live and offline, selected purely by environment variables.

| Mode        | Trigger                        | What it does                                                                                   |
|-------------|--------------------------------|------------------------------------------------------------------------------------------------|
| **LIVE**    | `AEGIS_SERVICE_BASE_URL` set   | Targets an already-running governed service. `tools/call` is forwarded to that base URL.       |
| **OFFLINE** | `AEGIS_SERVICE_BASE_URL` unset | Stands up the same in-process governed expense-like app the demo uses (Casbin PEP + JWT), mints a locally-signed dev token. Zero external deps, no keys, no network. |

### Environment variables

| Var                       | Mode        | Meaning                                                                                          |
|---------------------------|-------------|--------------------------------------------------------------------------------------------------|
| `AEGIS_SERVICE_BASE_URL`  | LIVE        | Base URL of the running governed service, e.g. `http://127.0.0.1:4002`. Presence selects LIVE.   |
| `AEGIS_AGENT_TOKEN`       | LIVE (req.) | Delegated bearer JWT the agent calls as. **Required** in LIVE mode. Optional in OFFLINE (else a dev token is minted). |
| `AEGIS_TENANT_ID`         | both        | Tenant (UUID) all calls run in. Defaults to the demo tenant `00000000-0000-4000-8000-000000000001`. |
| `AUTH_JWT_SECRET`         | OFFLINE     | Secret used to sign/verify the offline dev token. Defaults to `demo-secret`.                     |

In LIVE mode the token is never minted for you: you must supply `AEGIS_AGENT_TOKEN`. If it is
missing while `AEGIS_SERVICE_BASE_URL` is set, the server refuses to start (a delegated principal is
mandatory — no anonymous bypass).

---

## Running the stdio server

The repo has only `tsconfig.base.json` (no root `tsconfig.json`), so `ts-node` must be pointed at it
and at `tsconfig-paths` so the `@aegis/*` aliases resolve. From the repo root:

**Offline (no keys, no network — local dev / smoke):**

```bash
cd /Users/ankurpandey/Documents/GitHub/aegis
TS_NODE_PROJECT=tsconfig.base.json TS_NODE_TRANSPILE_ONLY=true \
TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' \
  node -r ts-node/register -r tsconfig-paths/register scripts/mcp/aegis-mcp-stdio.ts
```

**Live (against a running governed service):**

```bash
cd /Users/ankurpandey/Documents/GitHub/aegis
AEGIS_SERVICE_BASE_URL=http://127.0.0.1:4002 \
AEGIS_AGENT_TOKEN=eyJhbGciOi... \
AEGIS_TENANT_ID=00000000-0000-4000-8000-000000000001 \
TS_NODE_PROJECT=tsconfig.base.json TS_NODE_TRANSPILE_ONLY=true \
TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' \
  node -r ts-node/register -r tsconfig-paths/register scripts/mcp/aegis-mcp-stdio.ts
```

All human-readable status (mode, base URL, tenant, advertised tool list) goes to **STDERR** —
STDOUT carries only the MCP protocol frames, as the transport requires.

---

## Claude Desktop configuration

Add an entry to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`).

**Live (recommended for a real deployment):**

```json
{
  "mcpServers": {
    "aegis": {
      "command": "node",
      "args": [
        "-r", "ts-node/register",
        "-r", "tsconfig-paths/register",
        "/Users/ankurpandey/Documents/GitHub/aegis/scripts/mcp/aegis-mcp-stdio.ts"
      ],
      "env": {
        "TS_NODE_PROJECT": "/Users/ankurpandey/Documents/GitHub/aegis/tsconfig.base.json",
        "TS_NODE_TRANSPILE_ONLY": "true",
        "TS_NODE_COMPILER_OPTIONS": "{\"module\":\"commonjs\",\"esModuleInterop\":true}",
        "AEGIS_SERVICE_BASE_URL": "http://127.0.0.1:4002",
        "AEGIS_AGENT_TOKEN": "eyJhbGciOi...your-delegated-jwt...",
        "AEGIS_TENANT_ID": "00000000-0000-4000-8000-000000000001"
      }
    }
  }
}
```

**Offline (self-contained demo — drop the three `AEGIS_*` vars):**

```json
{
  "mcpServers": {
    "aegis-offline": {
      "command": "node",
      "args": [
        "-r", "ts-node/register",
        "-r", "tsconfig-paths/register",
        "/Users/ankurpandey/Documents/GitHub/aegis/scripts/mcp/aegis-mcp-stdio.ts"
      ],
      "env": {
        "TS_NODE_PROJECT": "/Users/ankurpandey/Documents/GitHub/aegis/tsconfig.base.json",
        "TS_NODE_TRANSPILE_ONLY": "true",
        "TS_NODE_COMPILER_OPTIONS": "{\"module\":\"commonjs\",\"esModuleInterop\":true}"
      }
    }
  }
}
```

After editing the config, fully restart Claude Desktop. The `aegis` server appears in the tools
menu; `tools/list` shows the governed expense tools (offline: a create `POST` and a read `GET`), and
every invocation traverses the governed core.

> **Governance note.** Even from Claude Desktop, a `tools/call` is *not* a shortcut. It becomes an
> HTTP request to the guarded route carrying the configured bearer token and `x-tenant-id`. The PEP
> re-checks authorization and `validate()` re-checks input at execution time. If the delegated token
> lacks the permission, the call is denied (403) and the model sees the governed failure body — the
> MCP layer cannot grant authority the principal does not already hold.

---

## Real LLM gateway path (orchestrator demo)

The MCP stdio server above lets an *external* MCP client drive the tools. If instead you want to run
the **in-process agentic loop** (`scripts/demo/agent-loop-demo.ts`, which uses `runAgentTurn` +
`OpenAiCompatibleLlmClient`) against a **real LLM gateway** rather than the deterministic offline
stub, set the LLM gateway env vars. Any OpenAI-compatible endpoint works — OpenAI, a LiteLLM proxy,
OpenRouter, vLLM, etc.

| Var                  | Meaning                                                                                   |
|----------------------|-------------------------------------------------------------------------------------------|
| `AEGIS_LLM_BASE_URL` | Gateway base URL, e.g. `https://api.openai.com/v1` or `http://localhost:4000` (LiteLLM).  |
| `AEGIS_LLM_API_KEY`  | Gateway API key.                                                                          |
| `AEGIS_LLM_MODEL`    | Optional; model id. Defaults to `gpt-4o-mini`.                                            |

When both `AEGIS_LLM_BASE_URL` and `AEGIS_LLM_API_KEY` are set, the demo swaps the offline stub for
`OpenAiCompatibleLlmClient`; with neither set it runs fully offline (deterministic stub, no network).

```bash
cd /Users/ankurpandey/Documents/GitHub/aegis
AEGIS_LLM_BASE_URL=https://api.openai.com/v1 \
AEGIS_LLM_API_KEY=sk-... \
AEGIS_LLM_MODEL=gpt-4o-mini \
TS_NODE_PROJECT=tsconfig.base.json TS_NODE_TRANSPILE_ONLY=true \
TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' \
  node -r ts-node/register -r tsconfig-paths/register scripts/demo/agent-loop-demo.ts
```

The real model still only ever chooses among the **filtered** tools the principal may use, and the
governed core still enforces authorization at execution time — the LLM never decides authorization
or danger; it only selects among already-permitted tools. See `scripts/demo/AGENT_LOOP_README.md`
for the full scenario/outcome table.

---

## Verifying offline (CI, no key, no MCP client)

`libs/ai-core/test/mcp-stdio.spec.ts` constructs `buildAegisMcpStdioServer({ env: {} })` in OFFLINE
mode and asserts it stands up the governed app, exposes the MCP server + a non-empty generated tools
list, and starts **no** stdio transport on import:

```bash
cd /Users/ankurpandey/Documents/GitHub/aegis
npx nx test ai-core --skip-nx-cache --testPathPattern mcp-stdio
```
