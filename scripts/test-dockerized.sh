#!/usr/bin/env bash
#
# One-command acceptance run for reviewers:
#   1. Build/start the fully Dockerized stack (Postgres, Redis, Kafka, APIs, workers).
#   2. Start the browser log/analytics dashboard when Node.js is available.
#   3. Run predefined HTTP API flow tests from a disposable Node container on the Compose network.
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

echo "▶ starting fully Dockerized Aegis stack"
bash scripts/setup.sh

if [ "${AEGIS_LOG_DASHBOARD:-1}" != "0" ]; then
  echo "▶ starting browser log/analytics dashboard"
  bash scripts/start-log-dashboard.sh docker || true
fi

NETWORK_NAME="$("${COMPOSE[@]}" -f docker-compose.all.yml ps -q gateway | xargs docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}')"
if [ -z "${NETWORK_NAME}" ]; then
  NETWORK_NAME="aegis_aegis"
fi

echo "▶ running scripted HTTP flows"
docker run -i --rm \
  --network "${NETWORK_NAME}" \
  -e AEGIS_BASE_URL="http://gateway:4000" \
  node:22-alpine \
  node < scripts/e2e/http-flow-tests.js

echo "✅ Dockerized acceptance flows passed."
