#!/bin/sh
# Aegis container entrypoint.
# Selects runtime behavior by PROCESS_TYPE so one image serves every role.
#   PROCESS_TYPE=api        -> run the HTTP service named by SERVICE_NAME
#   PROCESS_TYPE=worker     -> run the background worker for SERVICE_NAME
#   PROCESS_TYPE=migration  -> run DB migrations + seeders, then exit
set -e

PROCESS_TYPE="${PROCESS_TYPE:-api}"
SERVICE_NAME="${SERVICE_NAME:-user-management}"

run_migrations() {
  echo "[aegis] running migrations (env=${AEGIS_ENV})"
  node ./dist/apps/cli/main.js migrate --auto-confirm
  node ./dist/apps/cli/main.js migrate-seeders --auto-confirm
}

case "$PROCESS_TYPE" in
  migration)
    run_migrations
    ;;
  worker)
    # Same bundle as the api role; bootstrap.ts forks on PROCESS_TYPE=worker to swap in the Kafka
    # transport, register the topic consumers, and run them (no HTTP listener).
    echo "[aegis] starting worker: ${SERVICE_NAME}"
    exec node "./dist/apps/${SERVICE_NAME}/main.js"
    ;;
  api|*)
    echo "[aegis] starting api: ${SERVICE_NAME}"
    exec node "./dist/apps/${SERVICE_NAME}/main.js"
    ;;
esac
