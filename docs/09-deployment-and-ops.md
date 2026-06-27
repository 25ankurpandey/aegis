# 09 — Deployment & Operations

> **Scope.** How Aegis is packaged, shipped, promoted across environments, migrated, observed,
> and — first and foremost for any contributor — **run locally in one step**. The model is the
> de-branded "single image, many roles" deployment locked in [`../SPEC.md`](../SPEC.md) §1 and §7.
> Where this doc and `SPEC.md` disagree, **`SPEC.md` wins** (and §10 wins over §0–§9).

Related reading: [`01-architecture.md`](01-architecture.md) (the `apps/*` deployables vs `libs/*`
split), [`04-multi-tenancy.md`](04-multi-tenancy.md) (the RLS non-owner role this doc provisions),
[`06-service-to-service.md`](06-service-to-service.md) (the context/header propagation that the
correlation-id logging here depends on), and [`research/terraform-iac.md`](research/terraform-iac.md)
(the showcase cloud IaC that schedules the artifacts described below).

---

## 0. TL;DR — the operating model in seven lines

1. **One image.** A single multi-stage `Dockerfile` builds the whole monorepo into one image.
2. **Many roles.** `scripts/start.sh` switches on `PROCESS_TYPE` → `api` | `worker` | `migration`,
   and on `SERVICE_NAME` for *which* app — so the same bits run every service, the worker, and the
   migration task.
3. **Build once, promote by re-tag.** The image is tagged `:$GIT_SHA` once and then *promoted* to
   `dev` → `staging` → `production` by adding a moving tag to the **same** manifest — never rebuilt.
4. **Migrations are a one-shot task** using that same image (`PROCESS_TYPE=migration`), run before
   services roll, so schema and code versions can never drift.
5. **Runtime secrets** come from a parameter store keyed by env prefix (`/aegis/<env>/…`); no
   secret is ever baked into an image or CI log.
6. **Health is real.** `/health` (and `/health?details=true`) probes Postgres + Redis + the event
   bus; **readiness gates traffic** until dependencies are actually reachable.
7. **It runs locally in one step.** `bash scripts/dev-up.sh` (or VS Code **Cmd+Shift+B**, or "ask
   Claude to run it") builds every image, starts a pre-seeded Postgres + Redis, and brings all
   services up on one Docker network with **zero manual env setup**.

---

## 1. RUN IT LOCALLY IN ONE STEP

> This is the most important section for anyone touching Aegis. A fresh clone on a fresh machine
> goes from `git clone` to a fully wired, multi-service platform with **one command and no manual
> environment setup**. The only prerequisite is Docker (with Compose v2).

### 1.1 The one command

```bash
bash scripts/dev-up.sh
```

That script ([`../scripts/dev-up.sh`](../scripts/dev-up.sh)) is the single source of truth for local
bring-up. It:

1. `docker compose -f docker-compose.all.yml up -d --build` — builds the **one** Aegis image from
   [`../Dockerfile`](../Dockerfile) and starts **Postgres + Redis + all eight services** on one
   bridge network.
2. Waits for Postgres to report healthy (`pg_isready`).
3. Runs **migrations + seeders as a one-shot** task (`docker compose run --rm` with
   `PROCESS_TYPE=migration`) using the exact same image.
4. Prints the entry point: the gateway on `http://localhost:4000`, services on `4001–4007`.

```text
▶ Aegis local bring-up
▶ waiting for Postgres health...
▶ running migrations (one-shot)...
✅ Aegis is up. Gateway: http://localhost:4000  (services on 4001-4007)
```

### 1.2 The same thing, three other ways

| You want to… | Do this |
|---|---|
| Run from your editor | Press **Cmd+Shift+B** (the default *Build* task). `.vscode/tasks.json` binds the default build task to `scripts/dev-up.sh`, and `.vscode/launch.json` lets you attach a debugger to any single service. |
| Ask Claude / an agent | "Run Aegis locally" → the documented single command is `bash scripts/dev-up.sh`. No follow-up env questions are needed; everything required is committed. |
| Just the infra deps (run a service from your host) | `npm run compose:up` brings up only Postgres + Redis ([`../docker-compose.yml`](../docker-compose.yml)); then `SERVICE_NAME=expense npm run serve`. |

### 1.3 Why there is **zero manual env**

The reason a teammate never has to "set up a `.env`" is that **every service ships a committed
`.env` with internally consistent dummy values**, plus a root [`../.env`](../.env) for infra. These
are dummy-but-functional: the values across services agree, so `docker compose up` wires the whole
graph correctly out of the box.

- **Per-service** `apps/<svc>/.env` (e.g. [`../apps/expense/.env`](../apps/expense/.env)) carries the
  service's port, `SERVICE_NAME`, `DATABASE_URL`, `REDIS_URL`, JWKS URL, internal-S2S secret, and
  the **Docker-network hostnames** of its peers.
- **Root** [`../.env`](../.env) carries the Postgres owner/app credentials shared by the init script
  and the app role.

A representative `apps/expense/.env` (trimmed):

```dotenv
NODE_ENV=development
AEGIS_ENV=local
PROCESS_TYPE=api
SERVICE_NAME=expense
PORT=4002

# Postgres — runtime role is the NON-OWNER app role so RLS is enforced.
# Hostname = the compose service name "postgres", resolvable on the aegis network.
DATABASE_URL=postgres://aegis_app:aegis_app_pw@postgres:5432/aegis
REDIS_URL=redis://redis:6379

# Auth (dummy local secrets — overridden by the param store in real envs)
JWKS_URL=http://user-management:4001/.well-known/jwks.json
TOKEN_TTL_SECONDS=900

# Service-to-service (signed internal token + origin gate)
INTERNAL_JWT_SECRET=dev-only-internal-s2s-secret-change-me
INTERNAL_ORIGIN=aegis-internal
SOURCE_SERVICE=expense

# Internal service URLs — Docker-network hostnames, not localhost.
GATEWAY_URL=http://gateway:4000
USER_MANAGEMENT_URL=http://user-management:4001
PAYROLL_URL=http://payroll:4003
# …one entry per peer…
```

> **Security note.** These committed values are *dummy local secrets* (`dev-only-…-change-me`) and
> exist only to make local bring-up frictionless. They are **never** the values used in a real
> environment — real secrets are injected from the parameter store at runtime (§5) and take
> precedence over anything in `.env`.

### 1.4 The local topology (one network, fixed ports/hostnames)

Compose ([`../docker-compose.all.yml`](../docker-compose.all.yml)) puts every container on a single
user-defined bridge network named `aegis`, so each service resolves its peers by **service name**
(`http://user-management:4001`) — the same hostnames baked into the committed `.env` files. Host
port mappings let you reach any service directly from your machine.

| Container | Role | In-network host | Host port |
|---|---|---|---|
| `postgres` | Postgres 15 (pre-seeded; see §1.5) | `postgres:5432` | `5432` |
| `redis` | Redis 7 (cache + bus + BullMQ) | `redis:6379` | `6379` |
| `gateway` | Edge: JWT validation, routing, correlation-id minting | `gateway:4000` | `4000` |
| `user-management` | Identity + PAP + reference IdP (JWKS) | `user-management:4001` | `4001` |
| `expense` | Expense reports + approvals | `expense:4002` | `4002` |
| `payroll` | Payroll (field-encrypted PII) | `payroll:4003` | `4003` |
| `reporting` | CQRS-lite read models + export | `reporting:4004` | `4004` |
| `workflow` | Rules-as-data engine | `workflow:4005` | `4005` |
| `notification` | In-app + email | `notification:4006` | `4006` |
| `invoice` | Header-level invoice lifecycle | `invoice:4007` | `4007` |
| `migrate` | One-shot migrations (`profiles: [tools]`) | — | — |

All app containers share one YAML anchor (`x-app: &app`) — the same `image: aegis:local`, the same
`depends_on` gating on Postgres + Redis health, the same network — and differ only by `env_file` and
`SERVICE_NAME`. That is the local mirror of the production "one image, many roles" model.

```mermaid
flowchart LR
  subgraph host[Your machine]
    cli[scripts/dev-up.sh\nor Cmd+Shift+B]
  end
  subgraph net[Docker network: aegis]
    gw[gateway:4000]
    um[user-management:4001]
    ex[expense:4002]
    pr[payroll:4003]
    rp[reporting:4004]
    wf[workflow:4005]
    nt[notification:4006]
    inv[invoice:4007]
    pg[(postgres:5432\nRLS non-owner role)]
    rd[(redis:6379)]
    mig[[migrate\nPROCESS_TYPE=migration]]
  end
  cli -->|compose up --build| net
  gw --> um & ex & pr & rp & wf & nt & inv
  um & ex & pr & rp & wf & nt & inv --> pg
  um & ex & pr & rp & wf & nt & inv --> rd
  mig -.one-shot.-> pg
```

### 1.5 The Postgres image is pre-seeded for RLS

A local stack that doesn't enforce tenant isolation would be a lie. So the Postgres container is
seeded on first boot via `docker-entrypoint-initdb.d` ([`../scripts/db-init/01-init.sql`](../scripts/db-init/01-init.sql)),
which creates the **non-owner application role** the platform actually connects as:

```sql
-- aegis_owner owns the schema; aegis_app is the runtime role:
-- NON-OWNER, no BYPASSRLS — so Row-Level Security is genuinely enforced.
CREATE ROLE aegis_app LOGIN PASSWORD 'aegis_app_pw' NOBYPASSRLS;
GRANT CONNECT ON DATABASE aegis TO aegis_app;
\connect aegis
GRANT USAGE ON SCHEMA public TO aegis_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aegis_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aegis_app;
-- app.current_tenant / app.current_user are set per-transaction via SET LOCAL by @aegis/db.
```

The split matters: migrations run as the **owner** (`aegis_owner`, can `CREATE`/`ALTER`/own RLS
policies), while every service connects as `aegis_app` (a non-owner without `BYPASSRLS`). Because the
app role cannot bypass RLS, the per-transaction `SET LOCAL app.current_tenant` performed by
[`@aegis/db`] is load-bearing, not advisory — exactly as described in
[`04-multi-tenancy.md`](04-multi-tenancy.md). The local DB therefore behaves like production.

### 1.6 Tear down / reset

```bash
docker compose -f docker-compose.all.yml down          # stop everything
docker compose -f docker-compose.all.yml down -v       # …and wipe the aegis_pg volume (fresh DB)
```

---

## 2. One image, many roles (the packaging model)

### 2.1 The Dockerfile

[`../Dockerfile`](../Dockerfile) is a two-stage build. The **build** stage installs native toolchain
deps (for `pg`), runs `nx run-many -t build --all --prod` to emit `dist/`, and the **release** stage
copies only `dist/`, `node_modules`, `package.json`, and the entrypoint into a slim `node:22-alpine`
runtime that runs as a **non-root** `aegis` user under `tini`:

```dockerfile
# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /usr/src/app
RUN apk add --no-cache python3 make g++ libpq-dev
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npx nx run-many -t build --all --prod

# ---- release stage ----
FROM node:22-alpine AS release
WORKDIR /usr/src/app
RUN apk add --no-cache libpq tini
ENV NODE_ENV=production
COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/package.json ./package.json
COPY scripts/start.sh ./scripts/start.sh
RUN chmod +x ./scripts/start.sh && addgroup -S aegis && adduser -S aegis -G aegis \
    && chown -R aegis:aegis /usr/src/app
USER aegis
EXPOSE 4000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./scripts/start.sh"]
```

There is **one** Dockerfile for the whole platform — not one per service. The build artifact is a
single image that contains every app's `dist/`; *which* app runs is a runtime decision, not a
build-time one.

### 2.2 The PROCESS_TYPE entrypoint switch

[`../scripts/start.sh`](../scripts/start.sh) reads two env vars and dispatches:

```sh
PROCESS_TYPE="${PROCESS_TYPE:-api}"
SERVICE_NAME="${SERVICE_NAME:-user-management}"

case "$PROCESS_TYPE" in
  migration)
    node ./dist/apps/cli/main.js migrate --auto-confirm
    node ./dist/apps/cli/main.js migrate-seeders --auto-confirm
    ;;
  worker)
    exec node "./dist/apps/${SERVICE_NAME}/worker.js"
    ;;
  api|*)
    exec node "./dist/apps/${SERVICE_NAME}/main.js"
    ;;
esac
```

| `PROCESS_TYPE` | `SERVICE_NAME` | Runs | Used as |
|---|---|---|---|
| `api` | any service | `dist/apps/<svc>/main.js` (HTTP server) | The long-running service container |
| `worker` | any service | `dist/apps/<svc>/worker.js` (BullMQ consumers) | Async jobs: reporting exports, workflow actions, notification dispatch |
| `migration` | `cli` | `cli migrate` + `migrate-seeders`, then exits | The one-shot migration task |

**Why this matters.** The API for `expense`, its background worker, and the migration runner are
all the **same bytes** — they cannot disagree on schema, enum values, or business rules, because
they were built together and shipped as one manifest. As the platform grows from 8 to 18 apps, the
build surface stays *one* image, and the deployment matrix is just `(SERVICE_NAME × PROCESS_TYPE)`
env tuples rather than an image-per-service zoo.

---

## 3. Immutable SHA images, promoted by re-tag

### 3.1 Build once

CI builds the image exactly once per commit and tags it with the immutable commit SHA:

```bash
docker build -t $DOCKER_REGISTRY:$CI_COMMIT_SHA --build-arg GIT_SHA=$CI_COMMIT_SHA .
docker push  $DOCKER_REGISTRY:$CI_COMMIT_SHA
```

`:$CI_COMMIT_SHA` is the canonical, content-addressable identity of a build. It is never reused for
different bits and never overwritten.

### 3.2 Promote by adding a moving tag to the same manifest

An environment is just a **moving tag** (`dev`, `staging`, `production`) pointing at a SHA manifest.
Promotion adds that tag to the **already-built** manifest — there is **no rebuild**:

```bash
# Promote the exact bits that were tested — pull the SHA manifest and re-tag it.
aws ecr batch-get-image --repository-name "$IMAGE_NAME" \
  --image-ids imageTag="$CI_COMMIT_SHA" \
  --query 'images[0].imageManifest' --output text > /tmp/manifest
aws ecr put-image --repository-name "$IMAGE_NAME" \
  --image-tag "$ENV_TAG" --image-manifest "$(cat /tmp/manifest)"
```

```mermaid
flowchart LR
  c[commit abc123] -->|build once| img["registry/aegis:abc123\n(immutable SHA manifest)"]
  img -->|put-image tag: dev| dev[(dev)]
  img -->|put-image tag: staging| stg[(staging)]
  img -->|put-image tag: production| prod[(production)]
  classDef m fill:#eef,stroke:#669;
  class img m;
```

The bits running in production are **byte-identical** to what passed staging and dev — the only
thing that changed across environments is a tag and the runtime secrets resolved by env prefix (§5).
This is true build-once / deploy-everywhere; it eliminates "works in staging, breaks in prod" drift
caused by rebuilding from source per environment.

---

## 4. Migrations as a one-shot task

Migrations are **not** run on service container startup. They are an explicit, ordered, one-shot
task using the deploy image with `PROCESS_TYPE=migration`, run **before** services roll:

```bash
# CI deploy job (excerpt): migrate first, then force a new deployment per service.
./scripts/ci/run-migration-task.sh "$ECS_CLUSTER" "$CI_COMMIT_SHA"   # PROCESS_TYPE=migration
for svc in user-management expense payroll reporting workflow notification invoice gateway; do
  aws ecs update-service --cluster "$ECS_CLUSTER" --service "$svc" --force-new-deployment
done
```

Properties this buys:

- **Version parity.** The migration task runs the *same SHA image* as the services that will run
  against the new schema — schema and code can never disagree.
- **No startup races.** If migrations ran inside each service's startup, N replicas of M services
  would race to apply the same migration. As a single task, the schema change happens exactly once,
  observed, before any service serves traffic against it.
- **Ordering and gating.** Migrate-before-roll means readiness (§6) can safely assume the schema is
  current; a failed migration aborts the deploy *before* any service is replaced.

The migration system itself is **Umzug code-first numbered migrations** (`NNNN_subject.ts` exporting
`{ name, up, down }`), tracked in a `SequelizeMeta` table, driven by the `cli` app — see
[`07-data-models.md`](07-data-models.md) and [`02-patterns.md`](02-patterns.md). Seeders are a
parallel track (`migrate-seeders`, separate meta table). Locally, `npm run migrate:status` (alias
for `cli show-migrations`) reports executed vs pending.

---

## 5. Runtime secrets from a parameter store (env-prefixed)

No provider key, DB password, or signing secret ships inside an image or appears in a CI log. At
runtime each environment resolves its secrets from a **parameter store keyed by an env prefix**:

```
/aegis/<env>/database          # host, port, db name + a Secrets-Manager ARN for user/password
/aegis/<env>/redis             # cache/bus connection
/aegis/<env>/auth              # JWT signing keys / JWKS material
/aegis/<env>/internal          # internal-S2S signing secret, X-Internal-Origin value
/aegis/<env>/connectors/<name> # per-ERP-connector credentials (see docs/services/connectors.md)
```

The image is therefore **environment-agnostic**: the same SHA manifest becomes the dev, staging, or
production deployment purely by which `AEGIS_ENV` it boots with and which IAM role it assumes — the
prefix (`/aegis/dev/…` vs `/aegis/production/…`) selects the secret set. Consequences:

- **Rotating a DB credential requires no rebuild and no redeploy** — update the parameter, recycle
  the task.
- **CI never sees a runtime secret.** Registry creds and the param-store read role come from CI
  variables / OIDC, not from the repo (see the header of [`../.gitlab-ci.yml`](../.gitlab-ci.yml)).
- Secrets are resolved through the same config layer described in
  [`research/service-core.md`](research/service-core.md); committed `.env` dummy values (§1.3) are a
  *local-only* fallback that real env injection overrides.

This is the cloud-key-proxy posture in practice: keyed third-party APIs (Places, ERP connectors,
voice/HA, etc.) are reached with credentials pulled from the env-prefixed store, never from values
baked into the artifact.

---

## 6. Health, liveness & readiness

Every service exposes an unauthenticated `/health` endpoint (the only unauthenticated route besides
docs, per [`08-api-conventions.md`](08-api-conventions.md)). It comes in two depths:

| Request | Cost | Returns | Wired to |
|---|---|---|---|
| `GET /health` | cheap, no I/O | `200 {"status":"ok"}` | **liveness** probe |
| `GET /health?details=true` | probes deps | per-dependency status | **readiness** probe |

`?details=true` actively probes the three runtime dependencies and reports each:

```jsonc
// GET /health?details=true  → 200 when ready, 503 when any required dep is down
{
  "status": "ok",
  "service": "expense",
  "version": "abc123",          // the GIT_SHA the image was built from
  "uptimeSeconds": 421,
  "checks": {
    "database": { "status": "ok", "latencyMs": 3 },   // SELECT 1 as aegis_app
    "cache":    { "status": "ok", "latencyMs": 1 },    // Redis PING
    "bus":      { "status": "ok", "latencyMs": 2 }     // event-bus transport reachable
  }
}
```

```mermaid
sequenceDiagram
  participant LB as Load balancer / orchestrator
  participant Svc as Service
  participant PG as Postgres
  participant RD as Redis/Bus
  LB->>Svc: GET /health (liveness)
  Svc-->>LB: 200 ok (process alive)
  LB->>Svc: GET /health?details=true (readiness)
  Svc->>PG: SELECT 1
  Svc->>RD: PING / bus probe
  alt all deps reachable
    Svc-->>LB: 200 — add to rotation
  else any dep down
    Svc-->>LB: 503 — keep out of rotation
  end
```

- **Liveness** (`/health`) answers "is the process wedged?" — a failure triggers a restart, not a
  traffic decision. It deliberately does **no** I/O so a slow database can't cause restart storms.
- **Readiness** (`/health?details=true`) **gates traffic**: a service is added to the load-balancer
  rotation only once Postgres, Redis, and the bus are reachable. A service that boots before its DB
  is migrated/up stays out of rotation and returns `503` rather than accepting requests it cannot
  serve. (This is the deliberate improvement over donor systems that began listening before their
  dependencies were ready.)

---

## 7. CI/CD — DRY, with `nx affected` gating

[`../.gitlab-ci.yml`](../.gitlab-ci.yml) is a three-stage pipeline (`verify` → `build` → `deploy`)
kept DRY with **YAML anchors**: each reusable block is defined once (`&verify`, `&build_image`,
`&deploy`) and each environment job is a thin override that merges the anchor (`<<: *deploy`) and
sets only its variables + branch rule.

### 7.1 Verify — `nx affected` gating

```yaml
.verify: &verify
  stage: verify
  image: node:22-alpine
  script:
    - npm ci
    - npx nx affected -t lint --base=$CI_DEFAULT_BRANCH
    - npx nx affected -t test --base=$CI_DEFAULT_BRANCH
```

`nx affected` runs lint and tests **only for projects touched** by the change (computed against the
project graph), so a one-line edit to `invoice` does not re-test all eight services. Nx's build
cache (`targetDefaults … cache: true` in [`../nx.json`](../nx.json), with a `production` named-input
that excludes spec files) makes repeat runs near-instant.

### 7.2 Build — build once, push the SHA

```yaml
.build_image: &build_image
  stage: build
  image: docker:26
  services: ["docker:26-dind"]
  script:
    - docker build -t $DOCKER_REGISTRY:$CI_COMMIT_SHA --build-arg GIT_SHA=$CI_COMMIT_SHA .
    - docker push $DOCKER_REGISTRY:$CI_COMMIT_SHA
  rules:
    - if: '$CI_COMMIT_BRANCH == "develop" || $CI_COMMIT_BRANCH == "release" || $CI_COMMIT_BRANCH == "main"'
```

### 7.3 Deploy — promote, migrate, roll (one anchor, three envs)

```yaml
.deploy: &deploy
  stage: deploy
  image: alpine:3.20
  script:
    - apk add --no-cache aws-cli jq
    # promote: add the env moving tag to the same SHA manifest (no rebuild)
    - aws ecr batch-get-image ... --image-ids imageTag=$CI_COMMIT_SHA ... > /tmp/manifest
    - aws ecr put-image --image-tag $ENV_TAG --image-manifest "$(cat /tmp/manifest)" || true
    # migrate (one-shot) then roll each service
    - ./scripts/ci/run-migration-task.sh "$ECS_CLUSTER" "$CI_COMMIT_SHA"
    - for svc in user-management expense payroll reporting workflow notification invoice gateway; do
        aws ecs update-service --cluster "$ECS_CLUSTER" --service "$svc" --force-new-deployment; done

deploy:dev:        { <<: *deploy, variables: { ENV_TAG: dev,        ECS_CLUSTER: aegis-dev,     AEGIS_ENV: dev },        rules: [ { if: '$CI_COMMIT_BRANCH == "develop"' } ] }
deploy:staging:    { <<: *deploy, variables: { ENV_TAG: staging,    ECS_CLUSTER: aegis-staging, AEGIS_ENV: staging },    rules: [ { if: '$CI_COMMIT_BRANCH == "release"' } ] }
deploy:production: { <<: *deploy, variables: { ENV_TAG: production, ECS_CLUSTER: aegis-prod,    AEGIS_ENV: production }, rules: [ { if: '$CI_COMMIT_BRANCH == "main"', when: manual } ] }
```

Branch → environment is explicit and boring: `develop` → dev, `release` → staging, `main` →
production (**manual** gate). Each env job is ~3 lines because the logic lives in the anchor.

```mermaid
flowchart LR
  subgraph verify
    a[nx affected lint + test\nonly touched projects]
  end
  subgraph build
    b[docker build :SHA\npush once]
  end
  subgraph deploy
    c[ecr put-image\nadd env tag] --> d[migration one-shot task] --> e[ecs update-service\nper service]
  end
  a --> b --> c
```

### 7.4 Config / secret-checksum rolling restarts

A service must restart not only when its **image** changes but when its **config or secrets** change
under a stable image. The deploy layer (the Terraform task definitions in
[`research/terraform-iac.md`](research/terraform-iac.md)) injects a `CONFIG_CHECKSUM` env var = a hash
of the resolved param-store values + non-secret config for that env. When a secret rotates or config
changes, the checksum changes, which mutates the task definition, which triggers a rolling
replacement — even though the image tag is unchanged. This makes secret rotation a first-class,
zero-downtime operation rather than a "remember to bounce the service" footgun.

---

## 8. Autoscaling

Each `api` service and each `worker` scales independently because they are separate runtime roles of
the same image:

- **API services** scale on request-driven signals (CPU / in-flight request concurrency / p95
  latency), behind the load balancer, with readiness (§6) ensuring a scaled-up replica only takes
  traffic once its deps are reachable. Min ≥ 2 for availability; max bounded per env.
- **Workers** scale on **queue depth** (BullMQ backlog) — reporting exports and workflow actions are
  bursty, so the `worker` role scales out under load and back down when the queue drains,
  independently of API capacity.
- **Stateless by design.** Services hold no session state (tokens are JWTs validated per request,
  see [`05-authn-authz-flow.md`](05-authn-authz-flow.md); shared state is in Postgres/Redis), so
  horizontal scaling is safe and replicas are interchangeable.

The concrete min/max instance counts, the managed-instance-group / container-service target, and the
scaling policies live in the showcase IaC — [`research/terraform-iac.md`](research/terraform-iac.md).

---

## 9. Observability — OpenTelemetry + correlation-id logs

- **Tracing & metrics.** Services are instrumented with **OpenTelemetry** and export traces and
  metrics to a collector. Every inbound request and every downstream hop (HTTP and async message)
  participates in one trace; the OTel span id travels as `X-Trace-Id`.
- **Structured logs with a correlation id.** Logs are structured JSON (pino) and **every line carries
  `correlationId`** — the single business-request id minted at the gateway per inbound request and
  propagated **unchanged** through every service hop and async message
  (see [`06-service-to-service.md`](06-service-to-service.md)). This stitches all logs/traces/audit
  for one logical operation together across services. `X-Correlation-Id` (business request) is
  distinct from `X-Trace-Id` (OTel span); Aegis uses **no** `X-Trend`/`X-Tracker` header.

  ```jsonc
  {
    "level": "info", "time": "2026-06-26T10:00:00.123Z",
    "service": "expense", "version": "abc123",
    "correlationId": "01J…", "traceId": "4bf92f…", "tenantId": "t_…", "userId": "u_…",
    "msg": "expense.report.submitted", "reportId": "r_…"
  }
  ```

- **Audit.** Distinct from operational logs: writes emit tamper-evident, hash-chained audit entries
  capturing actor, tenant, intent, decision, and permissions-at-time-of-action — covered in
  [`10-auditability-and-compliance.md`](10-auditability-and-compliance.md).

The `version` field (the build's `GIT_SHA`) appears in both `/health?details=true` and every log
line, so an operator can read straight off a trace exactly which immutable image produced it.

---

## 10. Why single-image + tag-promotion + migration-as-task beats per-service Dockerfile + compose

A growing platform has two viable shapes. Aegis deliberately chose the first.

| Concern | **Aegis: one image, many roles, SHA-promotion** | Per-service Dockerfile + per-service compose |
|---|---|---|
| **Build surface** | **One** Dockerfile; `nx affected` decides what to test, but the artifact is a single image regardless of service count | One Dockerfile per service; the matrix grows linearly with services and rots unevenly |
| **Version parity** | API, worker, and migration runner are **byte-identical** — impossible to mismatch schema vs code | N images built at different times can drift; the worker can lag the API |
| **Promotion** | `dev→staging→prod` is a **tag** on the tested manifest — exact bits ship | Each env rebuilds from source → "rebuilt, therefore subtly different" risk |
| **Migrations** | Explicit one-shot task on the **same** image, run before roll, once | Often baked into per-service startup → N replicas race to migrate; ordering is implicit |
| **Local fidelity** | One compose file, one anchor, pre-seeded RLS role → prod-shaped stack in one command | Many compose files to keep in sync; easy for local to diverge from prod |
| **Secrets** | Env-prefixed param store; image is env-agnostic; rotation needs no rebuild | Per-service env files multiply; tempting to bake secrets into images |
| **New service onboarding** | Add `apps/<svc>` + an `.env` + a compose entry (one anchor reuse) + a CI loop entry | New Dockerfile, new build job, new image lifecycle, new compose service — more moving parts each time |

The single-image model trades a slightly larger image (it carries every app's `dist/`) for the
disappearance of an entire class of multi-artifact drift and operational complexity — a trade that
gets **better** as the platform adds services, which is exactly the trajectory Aegis is on.

---

## 11. Operational runbook (quick reference)

| Task | Command |
|---|---|
| Bring the whole platform up locally | `bash scripts/dev-up.sh` (or **Cmd+Shift+B**) |
| Bring up only infra deps | `npm run compose:up` |
| Apply migrations locally | `npm run migrate` then `npm run migrate:seed` |
| Migration status | `npm run migrate:status` |
| Tail one service's logs | `docker compose -f docker-compose.all.yml logs -f expense` |
| Check readiness of a service | `curl 'http://localhost:4002/health?details=true'` |
| Run migrations in a cloud env | one-shot task, `PROCESS_TYPE=migration` (CI does this pre-roll) |
| Promote a build to an env | re-tag the SHA manifest (`aws ecr put-image --image-tag <env>`) — no rebuild |
| Roll a service after promotion | `aws ecs update-service --service <svc> --force-new-deployment` |
| Rotate a secret | update `/aegis/<env>/…`; config-checksum change rolls the affected services |
| Reset local DB from scratch | `docker compose -f docker-compose.all.yml down -v && bash scripts/dev-up.sh` |

---

*See also:* [`01-architecture.md`](01-architecture.md) ·
[`04-multi-tenancy.md`](04-multi-tenancy.md) ·
[`06-service-to-service.md`](06-service-to-service.md) ·
[`research/terraform-iac.md`](research/terraform-iac.md) ·
[`research/service-core.md`](research/service-core.md) ·
[`../SPEC.md`](../SPEC.md) §7 & §10.
