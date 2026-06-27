#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${ROOT_DIR}/.aegis/log-dashboard.pid"

if [ ! -f "${PID_FILE}" ]; then
  echo "Log dashboard is not running."
  exit 0
fi

pid="$(cat "${PID_FILE}")"
if kill -0 "${pid}" >/dev/null 2>&1; then
  kill "${pid}" >/dev/null 2>&1 || true
  echo "Stopped log dashboard (${pid})."
fi
rm -f "${PID_FILE}"
