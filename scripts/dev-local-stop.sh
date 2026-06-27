#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="${AEGIS_PID_DIR:-${ROOT_DIR}/.aegis/pids}"

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
        kill "${pid}" >/dev/null 2>&1 || true
        echo "stopped stale Aegis port owner :${port} (${pid})"
        ;;
    esac
  done
}

if [ ! -d "${PID_DIR}" ]; then
  echo "No local Aegis pid directory found."
  exit 0
fi

for pid_file in "${PID_DIR}"/*.pid; do
  [ -e "${pid_file}" ] || continue
  pid="$(cat "${pid_file}")"
  if kill -0 "${pid}" >/dev/null 2>&1; then
    kill "${pid}" >/dev/null 2>&1 || true
    echo "stopped $(basename "${pid_file}" .pid) (${pid})"
  fi
  rm -f "${pid_file}"
done

for port in 4000 4001 4002 4003 4004 4005 4006 4007; do
  stop_repo_process_on_port "${port}"
done
