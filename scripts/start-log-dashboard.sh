#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

MODE="${1:-${AEGIS_DASHBOARD_MODE:-docker}}"
PORT="${AEGIS_LOG_DASHBOARD_PORT:-4010}"
STATE_DIR="${ROOT_DIR}/.aegis"
PID_FILE="${STATE_DIR}/log-dashboard.pid"
LOG_FILE="${STATE_DIR}/log-dashboard.log"

mkdir -p "${STATE_DIR}"

if ! command -v node >/dev/null 2>&1; then
  echo "Log dashboard skipped: Node.js is not on PATH. The Aegis stack still runs normally." >&2
  echo "Fallback logs: docker compose -f docker-compose.all.yml logs -f --tail=100" >&2
  exit 0
fi

if [ -f "${PID_FILE}" ]; then
  old_pid="$(cat "${PID_FILE}")"
  if kill -0 "${old_pid}" >/dev/null 2>&1; then
    kill "${old_pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${PID_FILE}"
fi

: > "${LOG_FILE}"
nohup env AEGIS_DASHBOARD_MODE="${MODE}" AEGIS_LOG_DASHBOARD_PORT="${PORT}" \
  node scripts/log-dashboard.js "${MODE}" >"${LOG_FILE}" 2>&1 &
echo "$!" > "${PID_FILE}"

echo "Log dashboard: http://127.0.0.1:${PORT}"
echo "Dashboard process log: ${LOG_FILE}"
