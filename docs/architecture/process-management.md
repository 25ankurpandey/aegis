# Process Management & Deployment Model

**Question (from the owner):** *Would PM2 be a better production approach than our current
single-image + `PROCESS_TYPE` + one-container-per-role model?*

**Short answer:**

- **Production → NO.** Keep the container + `PROCESS_TYPE` model. PM2 *inside* a container is an
  anti-pattern: the orchestrator (Docker Compose / Kubernetes) is already the supervisor, and PM2
  duplicates restart/health/signal handling while breaking the one-process-per-container contract.
- **Local dev without Docker → YES, optionally.** PM2 is genuinely useful for running all ten
  long-running Node roles in a single terminal with one command. We ship an **optional, dev-only**
  `ecosystem.config.js` for exactly that. It changes nothing about production.

---

## 1. What we run today

The whole Nx monorepo builds into **one Docker image** (`Dockerfile`). The runtime role is selected
by env at container start (`scripts/start.sh`):

| `PROCESS_TYPE` | Behavior | Source |
|---|---|---|
| `api` (default) | `exec node ./dist/apps/${SERVICE_NAME}/main.js` — run the HTTP service | `scripts/start.sh` |
| `worker` | Same bundle; `bootstrap.ts` forks on `PROCESS_TYPE=worker` to swap in the Kafka transport, register consumers, and run them (no HTTP listener) | `scripts/start.sh`, `apps/workflow/src/bootstrap.ts`, `apps/expense/src/bootstrap.ts` |
| `migration` | Run Umzug migrations + seeders, then exit (one-shot) | `scripts/start.sh` → `apps/cli/src/main.js` |

`docker-compose.all.yml` instantiates that one image once per role:

- **8 HTTP (`api`) roles:** `gateway` (4000), `user-management` (4001), `expense` (4002),
  `payroll` (4003), `reporting` (4004), `workflow` (4005), `notification` (4006), `invoice` (4007).
- **2 dedicated Kafka workers** (`PROCESS_TYPE=worker`): `workflow-worker`, `notification-worker`.
- **1 one-shot `migrate`** (profile `tools`, `restart: "no"`).
- **Infra:** Postgres, Redis, Kafka (KRaft).

**The outbox relay is not a separate process.** It runs **in-process inside the producer `api`
pods** — `bootstrap.ts` calls `initOutboxRelay()` on the API path (see
`apps/expense/src/bootstrap.ts:58`, `libs/events/src/init-relay.ts`), gated by
`OUTBOX_RELAY_ENABLED`. (The README lists a `relay` `PROCESS_TYPE` as a *possible* dedicated role,
but `scripts/start.sh` does not branch on it today — it would fall through to the `api|*` case. The
shipping topology runs the relay in-process, so this is a documentation-ahead-of-code note, not a
gap that affects either decision below.)

Each role is a single Node process. `tini` is PID 1 in the container (`ENTRYPOINT ["/sbin/tini",
"--"]`) so OS signals are forwarded correctly, and `bootstrap.ts` installs SIGTERM/SIGINT graceful
shutdown (`libs/service-core/src/bootstrap/shutdown.ts`, `startServer` / `installSignalHandlers`)
that drains in-flight work, then tears down relay → cache → bus → DB.

This follows an established pattern (the domain reference and the service-template reference do the same: one image, role by
env, one process per container, orchestrator as supervisor).

---

## 2. Why PM2 inside a production container is an anti-pattern

PM2 is a Node process manager: it supervises, restarts, clusters, watches health, and aggregates
logs. **Every one of those responsibilities is already owned by the orchestrator in production.**
Running PM2 inside the container means two supervisors fighting over the same job.

| Concern | Owned by orchestrator today | What PM2-in-container does instead |
|---|---|---|
| **Restart on crash** | `restart: unless-stopped` (Compose) / `restartPolicy` + kubelet (k8s) | PM2 restarts the child, so the container *never exits* on a crash. The orchestrator sees a "healthy" container wrapping a flapping process → restart counts, backoff, and `CrashLoopBackOff` signals are hidden. |
| **Health** | Compose `healthcheck` / k8s liveness+readiness probes against `/health` | PM2 has its own health notion that the orchestrator can't see; you'd run two health systems with different opinions. |
| **Signals / graceful shutdown** | `tini` (PID 1) → app SIGTERM handler drains DB/bus/cache | PM2 becomes PID 1 and intermediates signals; getting SIGTERM to reach the app cleanly (and exit codes to propagate back) is extra, fragile plumbing on top of what already works. |
| **Exit codes** | Non-zero exit → orchestrator acts (and `migrate` *must* exit cleanly to signal done) | PM2 swallows the child exit code; the migration one-shot pattern (run → exit 0/non-zero) stops working as a job. |
| **Scaling** | `docker compose up --scale` / k8s `replicas` + HPA — horizontal, schedulable across nodes | PM2 cluster mode forks within one container/host — invisible to the scheduler, can't spread across nodes, fights the one-process-per-container model. |
| **Logs** | One process → stdout/stderr → orchestrator log driver → aggregator | PM2 buffers/rotates its own log files inside the container; you now collect logs from PM2 instead of the standard stdout stream. |
| **Resource limits** | Per-container CPU/mem limits map 1:1 to one role | Multiple PM2-managed processes share one container's limits → noisy-neighbor and unfair OOM-kills inside the box. |

**Net:** PM2 in production buys nothing we don't already have and actively breaks restart
visibility, health, signal/exit-code handling, schedulable scaling, and the clean
one-process-per-container contract. The 12-factor / container norm is **one concern per container,
the orchestrator supervises** — which is exactly the current model. Keep it.

---

## 3. Where PM2 *is* useful: local dev without Docker

The real friction PM2 solves for us is purely a **developer-experience** one: running the full
platform on a laptop *without* Docker means hand-starting **ten** long-running Node processes (8 api
roles + 2 workers) in ten terminals, plus pointing them at a local Postgres/Redis/Kafka. PM2 starts
all of them with one command, gives one merged log stream, and one command to stop them.

This is strictly additive and **dev-only**. It does not appear in any image, compose file, or k8s
manifest. Production still runs the container + `PROCESS_TYPE` model from §1.

### Optional dev-only `ecosystem.config.js`

Shipped at the repo root, clearly marked dev-only. It builds first (`pnpm`/`npm run build` or
`nx run-many -t build`), then runs the compiled `dist/apps/*/main.js` with the same env switch the
container uses — `SERVICE_NAME` + `PROCESS_TYPE` — so dev parity with prod is preserved.

```js
// ecosystem.config.js  —  DEV ONLY. Not used by Docker / Compose / k8s.
// Runs all Aegis Node roles in one terminal for laptop dev WITHOUT Docker.
// Prereqs: a reachable Postgres + Redis + Kafka, per-app apps/<svc>/.env, and a prior build
//   (npm run build).  Production uses the container + PROCESS_TYPE model — see
//   docs/architecture/process-management.md and docker-compose.all.yml.
const api = (name, port) => ({
  name,
  script: `dist/apps/${name}/main.js`,
  env: { SERVICE_NAME: name, PROCESS_TYPE: 'api', PORT: String(port) },
});

const worker = (svc) => ({
  name: `${svc}-worker`,
  script: `dist/apps/${svc}/main.js`,
  env: { SERVICE_NAME: svc, PROCESS_TYPE: 'worker' },
});

module.exports = {
  apps: [
    // 8 HTTP (api) roles — gateway + the seven business services.
    api('gateway', 4000),
    api('user-management', 4001),
    api('expense', 4002),
    api('payroll', 4003),
    api('reporting', 4004),
    api('workflow', 4005),
    api('notification', 4006),
    api('invoice', 4007),

    // 2 dedicated Kafka workers (PROCESS_TYPE=worker → consumers only, no HTTP).
    worker('workflow'),
    worker('notification'),

    // NOTE — outbox relay: there is NO separate relay process. The relay runs in-process inside
    // the producer api roles above (bootstrap.ts → initOutboxRelay(); gate with OUTBOX_RELAY_ENABLED).
    // NOTE — migrations are a one-shot, not a long-running role; do not add them here.
    //   Run once before `pm2 start`:  npm run migrate && npm run migrate:seed
  ],
};
```

Add a dev-only npm script (in `package.json`, alongside the existing `compose:*` scripts):

```jsonc
"scripts": {
  "dev:pm2":      "npm run build && pm2 start ecosystem.config.js && pm2 logs",
  "dev:pm2:stop": "pm2 delete ecosystem.config.js"
}
```

Typical loop (no Docker for the app; deps can still be the lightweight `docker-compose.yml`
Postgres+Redis, or fully local):

```bash
# 1. deps (either local installs, or just the infra from the small compose file)
docker compose -f docker-compose.yml up -d            # Postgres + Redis (Kafka optional in dev)
# 2. schema once
npm run migrate && npm run migrate:seed
# 3. all ten Node roles in one terminal
npm run dev:pm2
# ... merged logs ...
npm run dev:pm2:stop
```

PM2 here owns nothing production-critical — it's just a convenient multi-process launcher for the
laptop. (`nx run-many -t serve` is a no-extra-dependency alternative if a team prefers not to add
PM2 at all; PM2 wins on a single merged log stream and `pm2 restart`/`pm2 stop` ergonomics.)

---

## 4. Recommendation

| Environment | Process management | Why |
|---|---|---|
| **Production (Compose / k8s)** | **Containers + `PROCESS_TYPE`** (current model — KEEP) | Orchestrator already supervises: restart, health probes, signals/exit codes, schedulable horizontal scaling, standard stdout logging. PM2 would duplicate all of it and break the one-process-per-container contract. Matches the reference pattern. |
| **Local dev WITH Docker** | `scripts/dev-up.sh` (`docker-compose.all.yml`) | Highest prod parity, zero manual env, one command. The default recommendation. |
| **Local dev WITHOUT Docker** | **Optional** PM2 via `ecosystem.config.js` (dev-only) | One terminal, one merged log stream, one stop command for all ten Node roles. Strictly additive; never shipped. `nx run-many -t serve` is the no-new-dependency alternative. |

**Decision:** Production stays on the container + `PROCESS_TYPE` model. PM2 is adopted **only** as an
optional local-dev convenience and must never enter an image, compose file, or k8s manifest.
