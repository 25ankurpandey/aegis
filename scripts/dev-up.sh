#!/usr/bin/env bash
# Aegis — bring the WHOLE platform up locally in one command.
# Builds every per-service image, starts dockerized Postgres (with RLS app role) + Redis + Kafka,
# runs all services wired on one Docker network, applies migrations. No manual env needed.
set -euo pipefail
cd "$(dirname "$0")/.."

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose is required: install Docker Desktop or docker-compose, then re-run." >&2
  exit 1
fi

echo "▶ Aegis local bring-up"
"${COMPOSE[@]}" -f docker-compose.all.yml up -d --build
echo "▶ waiting for Postgres health..."
until "${COMPOSE[@]}" -f docker-compose.all.yml exec -T postgres pg_isready -U aegis_owner -d aegis >/dev/null 2>&1; do sleep 1; done
echo "▶ running migrations (one-shot)..."
"${COMPOSE[@]}" -f docker-compose.all.yml run --rm -e PROCESS_TYPE=migration migrate || true
echo "✅ Aegis is up. Gateway: http://localhost:4000  (services on 4001-4007)"
"${COMPOSE[@]}" -f docker-compose.all.yml ps
