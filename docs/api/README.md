# Aegis API reference

This directory holds the generated OpenAPI contract for the whole platform.

| File | What it is |
|---|---|
| [`openapi.yaml`](./openapi.yaml) | The source-of-truth OpenAPI 3.0 spec (covers every route across all services). |
| [`index.html`](./index.html) | **Static viewer** — open in a browser to read the spec offline (no running stack). |
| `.generate-openapi.mjs` | Regenerates `openapi.yaml` + `index.html` from the service contracts. |

## Live, interactive UI

The same `openapi.yaml` is also served **live** by the gateway as an interactive Swagger UI once the
stack is up (`bash scripts/setup.sh`):

- **<http://localhost:4000/api-docs>** — interactive Swagger UI. Use the **Authorize** button to paste
  a Bearer JWT (it persists across requests), then **Try it out** to call the gateway directly.
- **<http://localhost:4000/api-docs.json>** — the raw parsed spec, for tooling/codegen.

The live UI mirrors this static viewer — both render the same `openapi.yaml`. The static `index.html`
is the offline path; `/api-docs` is the executable one. Both stay public (no auth wall).
