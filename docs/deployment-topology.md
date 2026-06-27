# Deployment Topology

How Aegis is packaged and run. The whole platform ships as **one image** whose
runtime role is chosen entirely by environment variables — `SERVICE_NAME`
(which app's bundle to run) and `PROCESS_TYPE` (api / worker / migration). This
document is grounded in `Dockerfile`, `scripts/start.sh`, `docker-compose.all.yml`,
and the per-app `apps/*/src/bootstrap.ts` composition roots.

## 1. One image, many roles

`Dockerfile` builds a single multi-stage image (`aegis:local`):

- **build stage** — `npx nx run-many -t build --all --prod` compiles every app
  into `dist/apps/<service>/main.js`.
- **release stage** — copies `dist/`, `node_modules`, `package.json`, and
  `scripts/start.sh`; runs as the non-root `aegis` user under `tini` (PID 1 for
  correct signal forwarding); `EXPOSE 4000`; `CMD ["./scripts/start.sh"]`.

Because api / worker / migration all run from the **same** artifact, they are
byte-identical versions of the code — there is no per-role build skew.

The image's behaviour is selected by `scripts/start.sh`, which switches on
`PROCESS_TYPE` (default `api`) and `SERVICE_NAME` (default `user-management`):

| `PROCESS_TYPE` | What start.sh does | HTTP? |
| --- | --- | --- |
| `api` (default) | `exec node ./dist/apps/$SERVICE_NAME/main.js` — the app bootstrap builds the Express service and listens | yes |
| `worker` | `exec node ./dist/apps/$SERVICE_NAME/main.js` — **same entry file**; the app's `bootstrap.ts` forks on `PROCESS_TYPE=worker` to register Kafka consumers and run them with no HTTP listener | no |
| `migration` | `node ./dist/apps/cli/main.js migrate --auto-confirm` then `migrate-seeders --auto-confirm`, then exits | one-shot |

> The api and worker rows run the *identical* command. The split is **inside**
> the app: each `bootstrap.ts` checks `Config.get('PROCESS_TYPE') === 'worker'`
> and takes the consumer-only branch, otherwise builds the HTTP service. See
> `apps/workflow/src/bootstrap.ts` and `apps/notification/src/bootstrap.ts`.

### The `relay` role

Code comments (`libs/events/src/init-relay.ts`, `libs/events/src/outbox.ts`,
`apps/cli/src/migrations/0011_event_outbox.ts`) describe a dedicated
`PROCESS_TYPE=relay` process for draining the transactional outbox to Kafka in a
distributed deployment. **That role is not yet a case in `scripts/start.sh`** —
today the outbox relay runs **in-process** inside each producer pod (see §4). The
dedicated relay process is a documented scaling option, not a wired entrypoint.

## 2. The pod matrix (docker-compose.all.yml)

`docker-compose.all.yml` materialises every role from the shared `x-app` anchor
(same image, same Postgres/Redis/Kafka deps, same network). Infrastructure:
`postgres` (15-alpine, RLS), `redis` (7-alpine, cache-only), `kafka`
(bitnami 3.7, single-broker KRaft, no ZooKeeper).

| Pod | `SERVICE_NAME` | `PROCESS_TYPE` | Exposed port | Role |
| --- | --- | --- | --- | --- |
| `gateway` | gateway | api | **4000** | Edge reverse-proxy (mints correlation id, validates context headers) |
| `user-management` | user-management | api | **4001** | Identity / Casbin PAP |
| `expense` | expense | api | **4002** | Expense + approvals + ERP connectors |
| `payroll` | payroll | api | **4003** | Payroll |
| `reporting` | reporting | api | **4004** | Reporting / exports |
| `workflow` | workflow | api | **4005** | Rules-as-data HTTP surface |
| `workflow-worker` | workflow | **worker** | *none* | Kafka consumer: `record.created/updated` → run rules |
| `notification` | notification | api | **4006** | In-app inbox read / mark-read surface |
| `notification-worker` | notification | **worker** | *none* | Kafka consumer: event-only notification write path |
| `invoice` | invoice | api | **4007** | Invoice |
| `migrate` | cli | **migration** | *none* | One-shot migrations + seeders (`profiles: ["tools"]`, `restart: "no"`) |

### Pods that expose ports vs pods that do not

- **Expose a port (HTTP):** `gateway` and all `*-api` services
  (`user-management`, `expense`, `payroll`, `reporting`, `workflow`,
  `notification`, `invoice`). These build their Express app via the shared
  `createService(...)` helper and `service.start(PORT)`.
- **Expose no port:** `workflow-worker`, `notification-worker`, the one-shot
  `migrate` task, and (when run as its own process) the **outbox relay**. The
  worker bootstraps take the `PROCESS_TYPE=worker` branch, which registers
  consumers and `start()`s the Kafka consumer loop but **never calls
  `service.start()`** — there is no listener to bind. They install
  `installSignalHandlers()` explicitly (the api role gets signal handlers for
  free via `startServer`).

## 3. Producer-on-every-pod invariant

**Every pod connects the event-bus producer at startup**, regardless of role:

- Every api `bootstrap.ts` calls `initEventBus()` (see `expense`, `payroll`,
  `invoice`, `user-management`, and the api branch of `workflow`).
- Both worker bootstraps call `initEventBus()` before `registerConsumers()`.

`initEventBus()` returns a `KafkaBus` when `KAFKA_BROKERS` is set (otherwise an
in-process bus for single-process dev). The `KafkaBus` is "activated on every pod
(producer-on-every-pod)" — `libs/events/src/kafka-bus.ts`.

Why every pod, not just the "publishers"?

1. **There is no separate publisher tier.** Any pod that handles a request or a
   consumed event may itself emit a downstream domain event (e.g. the workflow
   *worker* runs engine actions that publish; the workflow *api* publishes on
   HTTP-driven actions). A consumer is also a producer.
2. **The producer is the same shared singleton** the outbox relay drains to and
   that handlers publish through. Connecting it once at bootstrap means any code
   path reaching `getBus()` has a live, connected producer — no lazy-connect race
   on the first publish.
3. **Symmetric, uniform shutdown.** Because the producer exists on every pod, the
   teardown hook is identical everywhere: `onShutdown({ name: 'bus.stop', ... })`
   when `isKafkaBus()`. Shutdown order is LIFO so the DB pool closes **last**,
   after the producer has flushed and stopped.

The cost is one idle Kafka producer connection on pods that rarely publish —
cheap, and it removes an entire class of "first-publish-from-a-cold-producer"
bugs.

## 4. Worker consumers, the outbox relay, and at-least-once delivery

### Worker consumers

- **workflow-worker** (`apps/workflow/src/consumers`) — subscribes to the domain
  trigger topics (`record.created` / `record.updated`, connector-sync) and
  auto-runs workflow rules. It binds the **durable** (Postgres-backed,
  RLS-scoped) connector sync-state store *before* consuming so idempotency and
  attempt accounting survive restarts and replica fan-out.
- **notification-worker** (`apps/notification/src/consumers/notification.consumer.ts`)
  — the **event-only write path**: notifications are produced across processes
  from already-authorized domain events. The notification *api* pod only serves
  the in-app inbox read / mark-read surface; it does **not** consume events.

Both workers `Config.requireAll([... 'KAFKA_BROKERS'])` — a worker must have a
real broker to consume from.

### Outbox relay (transactional outbox)

Producers don't dual-write (commit-then-publish, which loses events on a crash
between the two). Instead `stageOutboxEvent(env, t)` inserts the full event
envelope into `event_outbox` **inside the same `withTenantTransaction`** as the
business write, so the event commits or rolls back atomically with the work.

The `OutboxRelay` (`libs/events/src/outbox.ts`) drains pending rows to the bus
**at-least-once**:

1. opens a transaction and sets the relay-bypass RLS marker
   (`SELECT set_config(app.outbox_relay, 'on', true)`) so it can see **every**
   tenant's pending rows;
2. selects pending rows oldest-first with `FOR UPDATE SKIP LOCKED` (so multiple
   relay instances never double-publish the same row);
3. publishes each to the bus, then marks it `published` only **after**
   `bus.publish` resolves — a crash mid-pass re-drains it next pass (consumers
   are idempotent via the envelope id);
4. increments `attempts` on failure and parks a row as `failed` after
   `maxAttempts` (default 5) for operator inspection.

**Where it runs today:** the relay is started **in-process** inside each producer
pod via `initOutboxRelay()` — wired in `expense`, `payroll`, and `invoice`
bootstraps. This keeps single-image / in-process-bus dev working (staged events
still reach same-process consumers) and works in production because
`SKIP LOCKED` makes concurrent relays safe. Opt a pod out with
`OUTBOX_RELAY_ENABLED=false`. A dedicated `PROCESS_TYPE=relay` process (so exactly
one role drains to Kafka) is the documented next step but is **not** yet a
`start.sh` case (see §1).

### Dead-letter handling

The `KafkaBus` applies bounded retry with exponential backoff and, on retry
exhaustion, republishes the envelope to a dead-letter topic `<topic>.dlq` (with
error + attempt metadata) **before** the consumer offset advances — failures are
recoverable, never silently dropped (`libs/events/src/kafka-bus.ts`). The
in-process bus mirrors this with a `DeadLetterSink` so dev has the same
retry-then-DLQ semantics (`libs/events/src/bus.ts`).

## 5. Healthchecks

- **Infrastructure deps** declare compose `healthcheck`s and the app anchor
  `depends_on: { condition: service_healthy }`, so app pods only start once
  Postgres / Redis / Kafka are ready:
  - postgres — `pg_isready -U aegis_owner -d aegis`
  - redis — `redis-cli ping`
  - kafka — `kafka-broker-api-versions.sh --bootstrap-server localhost:9092`
- **Application pods** expose an HTTP **`/health`** endpoint that bypasses the
  context/auth middleware band (gateway returns `{ service, status: 'ok',
  uptime }`; other services exclude `/health` from context + auth in
  `createService`). This is the readiness/liveness probe target for an
  orchestrator. (The app services do not declare a compose-level `healthcheck`;
  in production the probe is wired against `/health` by the platform.)
- **Workers** have no HTTP server, so liveness is process-based: they install
  SIGTERM/SIGINT handlers (`installSignalHandlers()`) that drain and `stop()` the
  Kafka consumers (`bus.stop`) before closing the cache and DB.

## 6. Scaling notes

- **API pods scale horizontally.** Every `*-api` pod is stateless behind the
  gateway — add replicas freely. Each connects its own producer (§3) and, where
  applicable, runs the in-process outbox relay (safe to run many: `SKIP LOCKED`).
- **Single database, RLS-isolated.** All services share one Postgres connection
  target; tenant isolation is enforced by Row-Level Security
  (`withTenantTransaction` sets the tenant context per transaction), not by
  per-tenant databases. Migrations run once as the `migration` role against that
  single DB. Vertical scale + read replicas are the DB scaling levers; there is
  no app-level sharding.
- **Kafka partitioning is keyed by tenant.** Domain events partition by tenant id,
  which preserves per-tenant ordering and lets workers scale out (more consumer
  instances → more partitions consumed in parallel) without cross-tenant
  reordering. Workers in the same consumer group divide partitions; the outbox
  relay's `SKIP LOCKED` drain and the idempotent envelope ids keep delivery
  correct under fan-out.
- **Workers scale by partition count.** `workflow-worker` and
  `notification-worker` add throughput by adding replicas up to the topic's
  partition count; beyond that, raise partitions.
