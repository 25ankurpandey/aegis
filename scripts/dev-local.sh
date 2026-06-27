#!/usr/bin/env bash
#
# Fast local development loop:
#   - Docker runs infrastructure only: Postgres, Redis, Kafka.
#   - Node services/workers run from local TypeScript by default, so code changes do not require a
#     Docker image rebuild. Set AEGIS_LOCAL_RUNTIME=dist to run compiled dist/apps/*/main.js.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose is required." >&2
  exit 1
fi

POSTGRES_PORT="${AEGIS_POSTGRES_PORT:-55433}"
REDIS_PORT="${AEGIS_REDIS_PORT:-6380}"
KAFKA_PORT="${AEGIS_KAFKA_PORT:-9092}"
LOG_DIR="${AEGIS_LOG_DIR:-${ROOT_DIR}/.aegis/logs}"
PID_DIR="${AEGIS_PID_DIR:-${ROOT_DIR}/.aegis/pids}"
LOCAL_RUNTIME="${AEGIS_LOCAL_RUNTIME:-ts-node}"

mkdir -p "${LOG_DIR}" "${PID_DIR}"

stop_repo_process_on_port() {
  port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    return
  fi
  pids="$(lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  for pid in ${pids}; do
    cmd="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
    case "${cmd}" in
      *"${ROOT_DIR}"*|*"apps/"*"/src/index.ts"*|*"dist/apps/"*"/main.js"*)
        echo "  stopping stale Aegis process on :${port} (${pid})"
        kill "${pid}" >/dev/null 2>&1 || true
        ;;
      *)
        echo "Port ${port} is already in use by a non-Aegis process: ${cmd}" >&2
        exit 1
        ;;
    esac
  done
}

echo "▶ starting Dockerized infrastructure only"
AEGIS_POSTGRES_PORT="${POSTGRES_PORT}" AEGIS_REDIS_PORT="${REDIS_PORT}" AEGIS_KAFKA_PORT="${KAFKA_PORT}" \
  "${COMPOSE[@]}" -f docker-compose.all.yml up -d postgres redis kafka

echo "▶ stopping Dockerized app containers so local services can bind 4000-4007"
AEGIS_POSTGRES_PORT="${POSTGRES_PORT}" AEGIS_REDIS_PORT="${REDIS_PORT}" AEGIS_KAFKA_PORT="${KAFKA_PORT}" \
  "${COMPOSE[@]}" -f docker-compose.all.yml stop \
  gateway user-management expense payroll reporting workflow notification invoice workflow-worker notification-worker >/dev/null 2>&1 || true
for port in 4000 4001 4002 4003 4004 4005 4006 4007; do
  stop_repo_process_on_port "${port}"
done

echo "▶ waiting for Dockerized infrastructure"
pg_deadline=$(( $(date +%s) + 120 ))
until "${COMPOSE[@]}" -f docker-compose.all.yml exec -T postgres pg_isready -U aegis_owner -d aegis >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "${pg_deadline}" ]; then
    echo "Postgres did not become ready within 120s" >&2
    exit 1
  fi
  sleep 2
done
redis_deadline=$(( $(date +%s) + 60 ))
until "${COMPOSE[@]}" -f docker-compose.all.yml exec -T redis redis-cli ping >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "${redis_deadline}" ]; then
    echo "Redis did not become ready within 60s" >&2
    exit 1
  fi
  sleep 1
done
kafka_deadline=$(( $(date +%s) + 180 ))
until "${COMPOSE[@]}" -f docker-compose.all.yml exec -T kafka /opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092 >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "${kafka_deadline}" ]; then
    echo "Kafka did not become ready within 180s" >&2
    exit 1
  fi
  sleep 3
done

if [ "${LOCAL_RUNTIME}" = "dist" ]; then
  echo "▶ building local services"
  ./node_modules/.bin/nx run-many -t build --all --prod
else
  echo "▶ using ts-node runtime for local services (set AEGIS_LOCAL_RUNTIME=dist for compiled output)"
fi

COMMON_ENV=(
  "NODE_ENV=development"
  "AEGIS_ENV=local"
  "TS_NODE_PROJECT=tsconfig.base.json"
  "DATABASE_URL=postgres://aegis_app:aegis_app_pw@127.0.0.1:${POSTGRES_PORT}/aegis"
  "REDIS_URL=redis://127.0.0.1:${REDIS_PORT}"
  "KAFKA_BROKERS=127.0.0.1:${KAFKA_PORT}"
  "AUTH_JWT_SECRET=dev-only-user-token-secret-change-me"
  "JWKS_URL=http://127.0.0.1:4001/.well-known/jwks.json"
  "INTERNAL_JWT_SECRET=dev-only-internal-s2s-secret-change-me"
  "INTERNAL_ORIGIN=aegis-internal"
  "GATEWAY_URL=http://127.0.0.1:4000"
  "USER_MANAGEMENT_URL=http://127.0.0.1:4001"
  "EXPENSE_URL=http://127.0.0.1:4002"
  "PAYROLL_URL=http://127.0.0.1:4003"
  "REPORTING_URL=http://127.0.0.1:4004"
  "WORKFLOW_URL=http://127.0.0.1:4005"
  "NOTIFICATION_URL=http://127.0.0.1:4006"
  "INVOICE_URL=http://127.0.0.1:4007"
  "FIELD_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef"
)

echo "▶ applying migrations + seeders locally against Dockerized Postgres"
env \
  TS_NODE_PROJECT=tsconfig.base.json \
  NODE_ENV=development \
  AEGIS_ENV=local \
  SERVICE_NAME=cli \
  DATABASE_URL="postgres://aegis_owner:aegis_local@127.0.0.1:${POSTGRES_PORT}/aegis" \
  ./node_modules/.bin/ts-node -r tsconfig-paths/register apps/cli/src/main.ts migrate
env \
  TS_NODE_PROJECT=tsconfig.base.json \
  NODE_ENV=development \
  AEGIS_ENV=local \
  SERVICE_NAME=cli \
  DATABASE_URL="postgres://aegis_owner:aegis_local@127.0.0.1:${POSTGRES_PORT}/aegis" \
  ./node_modules/.bin/ts-node -r tsconfig-paths/register apps/cli/src/main.ts migrate-seeders

start_role() {
  svc="$1"
  port="$2"
  process_type="${3:-api}"
  name="${svc}"
  if [ "${process_type}" = "worker" ]; then
    name="${svc}-worker"
  fi
  log_file="${LOG_DIR}/${name}.log"
  pid_file="${PID_DIR}/${name}.pid"
  if [ -f "${pid_file}" ] && kill -0 "$(cat "${pid_file}")" >/dev/null 2>&1; then
    kill "$(cat "${pid_file}")" >/dev/null 2>&1 || true
  fi
  : > "${log_file}"
  if [ "${LOCAL_RUNTIME}" = "dist" ]; then
    nohup env "${COMMON_ENV[@]}" \
      SERVICE_NAME="${svc}" \
      SOURCE_SERVICE="${svc}" \
      PROCESS_TYPE="${process_type}" \
      PORT="${port}" \
      node "dist/apps/${svc}/main.js" >"${log_file}" 2>&1 &
  else
    nohup env "${COMMON_ENV[@]}" \
      SERVICE_NAME="${svc}" \
      SOURCE_SERVICE="${svc}" \
      PROCESS_TYPE="${process_type}" \
      PORT="${port}" \
      ./node_modules/.bin/ts-node -r tsconfig-paths/register "apps/${svc}/src/index.ts" >"${log_file}" 2>&1 &
  fi
  echo "$!" > "${pid_file}"
  echo "  ${name} pid $(cat "${pid_file}") -> ${log_file}"
}

echo "▶ starting local services/workers"
start_role gateway 4000
start_role user-management 4001
start_role expense 4002
start_role payroll 4003
start_role reporting 4004
start_role workflow 4005
start_role notification 4006
start_role invoice 4007
start_role workflow 4005 worker
start_role notification 4006 worker

if [ "${AEGIS_LOG_DASHBOARD:-1}" != "0" ]; then
  bash scripts/start-log-dashboard.sh local || true
fi

echo "▶ waiting for local HTTP health"
for port in 4000 4001 4002 4003 4004 4005 4006 4007; do
  deadline=$(( $(date +%s) + 90 ))
  until curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      echo "service on :${port} did not become healthy; see ${LOG_DIR}" >&2
      exit 1
    fi
    sleep 1
  done
done

echo "✅ local Aegis services are up against Dockerized infra."
echo "   Gateway: http://127.0.0.1:4000"
if [ "${AEGIS_LOG_DASHBOARD:-1}" != "0" ]; then
  echo "   Logs:    http://127.0.0.1:${AEGIS_LOG_DASHBOARD_PORT:-4010}"
fi
echo "   Stop:    bash scripts/dev-local-stop.sh"
