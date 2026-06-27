// ecosystem.config.js  —  DEV ONLY. Not used by Docker / Compose / Kubernetes.
//
// Runs every long-running Aegis Node role in one terminal for local development WITHOUT Docker.
// Production uses the single-image + PROCESS_TYPE + one-container-per-role model instead — see
// docs/architecture/process-management.md, scripts/start.sh, and docker-compose.all.yml.
//
// Prereqs:
//   1. Reachable Postgres + Redis (+ Kafka if you want the workers to consume real events):
//        docker compose -f docker-compose.yml up -d        # Postgres + Redis
//   2. Per-app env at apps/<service>/.env  (same files docker-compose.all.yml uses).
//   3. A prior build (PM2 runs the compiled output, matching the container):
//        npm run build
//   4. Schema once, before `pm2 start`:
//        npm run migrate && npm run migrate:seed
//
// Then:  npm run dev:pm2        (build + pm2 start + pm2 logs)
//        npm run dev:pm2:stop   (pm2 delete)

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
    // 8 HTTP (api) roles — gateway + the seven business services (ports mirror docker-compose.all.yml).
    api('gateway', 4000),
    api('user-management', 4001),
    api('expense', 4002),
    api('payroll', 4003),
    api('reporting', 4004),
    api('workflow', 4005),
    api('notification', 4006),
    api('invoice', 4007),

    // 2 dedicated Kafka workers (PROCESS_TYPE=worker → consumers only, no HTTP listener).
    worker('workflow'),
    worker('notification'),

    // NOTE — outbox relay: there is NO separate relay process. The relay runs IN-PROCESS inside the
    //   producer api roles above (apps/*/src/bootstrap.ts → initOutboxRelay(); opt a pod out with
    //   OUTBOX_RELAY_ENABLED=false). Do not add a relay app here.
    // NOTE — migrations are a one-shot (PROCESS_TYPE=migration), not a long-running role. Run them
    //   once before `pm2 start`:  npm run migrate && npm run migrate:seed
  ],
};
