#!/usr/bin/env bash
#
# Aegis — one-command setup for a brand-new machine.
#
#   bash scripts/setup.sh
#
# A new user runs THIS, once, and ends with the entire platform up and every flow exercisable:
#   1. Verify Docker is installed AND the daemon is running (clear pointer + non-zero exit if not).
#   2. Build per-service images from one monorepo/shared Dockerfile.service.
#   3. Bring up the full stack on one Docker network: Postgres (+RLS app role from scripts/db-init),
#      Redis, Kafka, all 9 HTTP services (gateway 4000 + 4001-4007), the workflow + notification
#      Kafka workers, and the in-process outbox relay (runs inside the producer api pods).
#   4. Run the one-shot `migrate` container (PROCESS_TYPE=migration → migrations THEN seeders),
#      exactly as scripts/start.sh dispatches it.
#   5. Poll /health on every service until ready (or time out with a diagnostic dump).
#   6. Print the ready URLs, seeded credentials, and next steps (Postman import / curl recipes).
#
# Idempotent + re-runnable: `docker compose up -d` reconciles to desired state, the image rebuild is
# layer-cached, and the migrate/seeder runners are themselves idempotent (already-applied migrations
# and seeders are skipped). Safe to run again after a crash, a code change, or a `down` (volumes kept).
#
set -euo pipefail

# ---- locate the repo root (this script lives in <root>/scripts) -------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

COMPOSE_FILE="docker-compose.all.yml"
# Service name -> host port, for the /health poll. Gateway + the seven business api roles.
HEALTH_PORTS="gateway:4000 user-management:4001 expense:4002 payroll:4003 reporting:4004 workflow:4005 notification:4006 invoice:4007"
HEALTH_TIMEOUT_SECONDS="${AEGIS_HEALTH_TIMEOUT:-180}"  # per-service readiness budget

# ---- tiny logging helpers (colour only on a TTY) ---------------------------------------------------
if [ -t 1 ]; then
  C_RESET="$(printf '\033[0m')"; C_BOLD="$(printf '\033[1m')"
  C_GREEN="$(printf '\033[32m')"; C_YELLOW="$(printf '\033[33m')"; C_RED="$(printf '\033[31m')"; C_CYAN="$(printf '\033[36m')"
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""
fi
step()  { printf '%s▶ %s%s\n' "${C_CYAN}${C_BOLD}" "$*" "${C_RESET}"; }
ok()    { printf '%s✓ %s%s\n' "${C_GREEN}" "$*" "${C_RESET}"; }
warn()  { printf '%s! %s%s\n' "${C_YELLOW}" "$*" "${C_RESET}"; }
fail()  { printf '%s✗ %s%s\n' "${C_RED}${C_BOLD}" "$*" "${C_RESET}" 1>&2; }

# ===================================================================================================
# 1. Docker preflight — installed AND running.
# ===================================================================================================
step "Checking Docker"
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker is not installed (no \`docker\` on PATH)."
  printf '\n  Install Docker Desktop / Engine, then re-run this script:\n    %s\n\n' "https://docs.docker.com/get-docker/"
  exit 1
fi

# Compose is available either as the Docker v2 plugin (`docker compose`) or the standalone
# `docker-compose` binary on lightweight local runtimes such as Colima.
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  fail "Docker Compose is not available (\`docker compose version\` and \`docker-compose\` both failed)."
  printf '\n  Update Docker Desktop, install the Compose v2 plugin, or install docker-compose:\n    %s\n\n' "https://docs.docker.com/compose/install/"
  exit 1
fi

# `docker info` only succeeds when the daemon is actually up and reachable.
if ! docker info >/dev/null 2>&1; then
  fail "The Docker daemon is not running (could not reach it via \`docker info\`)."
  printf '\n  Start Docker Desktop (or \`sudo systemctl start docker\` on Linux), wait for it to\n'
  printf '  report \"running\", then re-run this script. Install help: %s\n\n' "https://docs.docker.com/get-docker/"
  exit 1
fi
ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'present') and Compose v2 are ready."

# Sanity: the compose file we drive must exist (guards against running from the wrong directory).
if [ ! -f "${COMPOSE_FILE}" ]; then
  fail "Cannot find ${COMPOSE_FILE} in ${ROOT_DIR}. Run this script from a full Aegis checkout."
  exit 1
fi

# ===================================================================================================
# 2 + 3. Build the images and bring the whole stack up (idempotent — reconciles to desired state).
#     `--build` rebuilds the aegis/<service>:local images (layer-cached) so a re-run picks up code changes.
#     `up -d` starts/updates every default-profile service (the `migrate` one-shot is in the `tools`
#     profile, so it does NOT auto-start here — we run it explicitly in step 4).
# ===================================================================================================
step "Building service images and starting the stack (Postgres + RLS, Redis, Kafka, 9 services, 2 workers)"
"${COMPOSE[@]}" -f "${COMPOSE_FILE}" up -d --build

# ===================================================================================================
# 4. Wait for Postgres, then run the one-shot migrate container (migrations THEN seeders).
#     `PROCESS_TYPE=migration` makes start.sh run `cli migrate` + `cli migrate-seeders` and exit.
#     Both runners are idempotent, so re-running setup.sh re-applies nothing already applied.
# ===================================================================================================
step "Waiting for Postgres to accept connections"
pg_deadline=$(( $(date +%s) + 120 ))
until "${COMPOSE[@]}" -f "${COMPOSE_FILE}" exec -T postgres pg_isready -U aegis_owner -d aegis >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "${pg_deadline}" ]; then
    fail "Postgres did not become ready within 120s."
    "${COMPOSE[@]}" -f "${COMPOSE_FILE}" logs --tail 50 postgres || true
    exit 1
  fi
  sleep 2
done
ok "Postgres is accepting connections."

step "Applying migrations + seeders (one-shot migrate container, PROCESS_TYPE=migration)"
# --rm: the one-shot exits after migrating; we do not leave a stopped container behind.
if ! "${COMPOSE[@]}" -f "${COMPOSE_FILE}" run --rm -e PROCESS_TYPE=migration migrate; then
  fail "The migrate one-shot exited non-zero. Inspect its output above (and \`${COMPOSE[*]} -f ${COMPOSE_FILE} logs postgres\`)."
  exit 1
fi
ok "Migrations + seeders applied (system roles, demo tenants, casbin policies, approval policies, connector configs)."

# ===================================================================================================
# 5. Poll /health on the gateway + every service until each reports ok (or time out with diagnostics).
# ===================================================================================================
step "Waiting for every service to report healthy (timeout ${HEALTH_TIMEOUT_SECONDS}s each)"

# Probe one http://localhost:PORT/health, return 0 once it answers 2xx.
wait_for_health() {
  svc="$1"; port="$2"
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
  while :; do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/health" 2>/dev/null || echo 000)"
    case "${code}" in
      2*) ok "${svc} healthy (http://localhost:${port}/health)"; return 0 ;;
    esac
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      fail "${svc} did not become healthy on :${port} within ${HEALTH_TIMEOUT_SECONDS}s (last HTTP ${code})."
      "${COMPOSE[@]}" -f "${COMPOSE_FILE}" logs --tail 40 "${svc}" || true
      return 1
    fi
    sleep 2
  done
}

unhealthy=0
for pair in ${HEALTH_PORTS}; do
  svc="${pair%%:*}"; port="${pair##*:}"
  wait_for_health "${svc}" "${port}" || unhealthy=1
done

if [ "${unhealthy}" -ne 0 ]; then
  fail "One or more services are not healthy. Stack state:"
  "${COMPOSE[@]}" -f "${COMPOSE_FILE}" ps || true
  printf '\n  Re-running this script is safe — it will reconcile and retry.\n'
  exit 1
fi

# The two Kafka workers have no HTTP port; surface their state for completeness (not a health gate).
step "Background workers (Kafka consumers — no HTTP port)"
"${COMPOSE[@]}" -f "${COMPOSE_FILE}" ps workflow-worker notification-worker || true

if [ "${AEGIS_LOG_DASHBOARD:-1}" != "0" ]; then
  step "Starting browser log/analytics dashboard"
  if bash scripts/start-log-dashboard.sh docker; then
    DASHBOARD_URL="http://127.0.0.1:${AEGIS_LOG_DASHBOARD_PORT:-4010}"
  else
    warn "Log dashboard was skipped; the stack is still ready."
    DASHBOARD_URL="not started"
  fi
else
  DASHBOARD_URL="disabled (AEGIS_LOG_DASHBOARD=0)"
fi

# ===================================================================================================
# 6. Print the ready URLs + seeded credentials + next steps.
# ===================================================================================================
cat <<EOF

${C_GREEN}${C_BOLD}✅ Aegis is up.${C_RESET}

  ${C_BOLD}Gateway (single entry point)${C_RESET}   http://localhost:4000
  ${C_BOLD}Live API docs${C_RESET}                 http://localhost:4000/api-docs
  ${C_BOLD}Raw OpenAPI spec${C_RESET}              http://localhost:4000/api-docs.json
  ${C_BOLD}Logs + analytics dashboard${C_RESET}     ${DASHBOARD_URL}
  ${C_BOLD}Services (defense-in-depth PEP)${C_RESET}
     user-management   http://localhost:4001
     expense           http://localhost:4002
     payroll           http://localhost:4003
     reporting         http://localhost:4004
     workflow          http://localhost:4005
     notification      http://localhost:4006
     invoice           http://localhost:4007
  ${C_BOLD}Infra${C_RESET}
     Postgres owner   aegis_owner / aegis_local       postgres://aegis_owner:aegis_local@127.0.0.1:${AEGIS_POSTGRES_PORT:-5432}/aegis
     Postgres app     aegis_app / aegis_app_pw        postgres://aegis_app:aegis_app_pw@127.0.0.1:${AEGIS_POSTGRES_PORT:-5432}/aegis
     Redis            redis://127.0.0.1:${AEGIS_REDIS_PORT:-6379}     (no password)
     Kafka            127.0.0.1:${AEGIS_KAFKA_PORT:-9092}             (PLAINTEXT, no SASL)
     Inside Docker    postgres:5432, redis:6379, kafka:9092

  ${C_BOLD}Seeded demo tenant (login works immediately)${C_RESET}
     x-tenant-id   00000000-0000-4000-8000-000000000001   (Demo Org)
     email         admin@demo-org.test
     password      demo-admin-pw
     (admin holds every permission, so all flows below are exercisable with this one login)
     A second tenant — admin@demo-org-b.test / demo-admin-pw-b,
     x-tenant-id 00000000-0000-4000-8000-000000000002 — exists for cross-tenant RLS isolation.

  ${C_BOLD}Every request through the gateway needs these headers${C_RESET}
     x-tenant-id: <tenant UUID>      (required, fail-closed — never defaulted)
     x-correlation-id: <any id>      (optional — the gateway mints one and echoes it back)
     authorization: Bearer <jwt>     (every route except /auth/register and /auth/login)

  ${C_BOLD}Hit every flow${C_RESET}
   • Postman:  import ${C_CYAN}docs/postman/Aegis.postman_collection.json${C_RESET}
               (set the {{baseUrl}} var = http://localhost:4000; "Login" saves the JWT into {{token}};
                then run the requests top-to-bottom).
   • curl:     follow ${C_CYAN}docs/testing/CURL_EXAMPLES.md${C_RESET} (copy-paste, in order).
   • Deeper live runbook (side-effects, RLS, audit chain, DLQ):
               ${C_CYAN}docs/testing/LIVE_E2E_RUNBOOK.md${C_RESET}

  ${C_BOLD}Manage the stack${C_RESET}
     status     ${COMPOSE[*]} -f ${COMPOSE_FILE} ps
     logs       ${COMPOSE[*]} -f ${COMPOSE_FILE} logs -f gateway expense
     dashboard  ${DASHBOARD_URL}
     stop       ${COMPOSE[*]} -f ${COMPOSE_FILE} down            (keeps data volumes)
     reset      ${COMPOSE[*]} -f ${COMPOSE_FILE} down -v         (wipes Postgres + Kafka volumes)
     re-run     bash scripts/setup.sh                             (idempotent)

EOF
