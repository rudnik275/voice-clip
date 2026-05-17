#!/usr/bin/env bash
set -euo pipefail

# Idempotent Litestream restore script for voice-clip.
# Run this on the VPS when you need to recover the SQLite database from
# Hetzner Object Storage. The app container must be stopped before running.
#
# Usage: bash scripts/litestream-restore.sh
#
# Pre-conditions:
#   - /opt/voice-clip/.env contains valid LITESTREAM_S3_* credentials
#   - Docker is installed and the litestream image is available
#   - Hetzner Object Storage bucket is accessible

COMPOSE_DIR="/opt/voice-clip"
DATA_DIR="${COMPOSE_DIR}/data"
DB_FILE="${DATA_DIR}/voice-clip.sqlite"
LITESTREAM_CONFIG="${COMPOSE_DIR}/litestream.yml"
ENV_FILE="${COMPOSE_DIR}/.env"

echo "==> Checking app container is stopped..."
APP_STATE=$(docker compose -f "${COMPOSE_DIR}/docker-compose.prod.yml" ps --format json voice-clip 2>/dev/null | python3 -c "import sys,json; data=sys.stdin.read().strip(); items=json.loads(data) if data.startswith('[') else ([json.loads(data)] if data else []); print(items[0].get('State','') if items else 'stopped')" 2>/dev/null || echo "stopped")

if [ "${APP_STATE}" = "running" ]; then
  echo "ERROR: voice-clip container is still running. Stop it first:"
  echo "  docker compose -f ${COMPOSE_DIR}/docker-compose.prod.yml stop voice-clip"
  exit 1
fi

echo "==> App container is not running. Proceeding."

if [ -f "${DB_FILE}" ]; then
  BACKUP_NAME="${DB_FILE}.bak.$(date +%s)"
  echo "==> Backing up existing database to ${BACKUP_NAME}..."
  mv "${DB_FILE}" "${BACKUP_NAME}"
  echo "    Backup created: ${BACKUP_NAME}"
else
  echo "==> No existing database file found. Skipping backup."
fi

echo "==> Running litestream restore..."
docker run --rm -v "${DATA_DIR}:/data" -v "${LITESTREAM_CONFIG}:/etc/litestream.yml:ro" --env-file "${ENV_FILE}" litestream/litestream:latest restore -if-replica-exists -o /data/voice-clip.sqlite /data/voice-clip.sqlite

if [ ! -f "${DB_FILE}" ]; then
  echo "INFO: No replica exists in the bucket yet (restore skipped by -if-replica-exists). Nothing to restore."
  exit 0
fi

echo "==> Verifying database integrity..."
INTEGRITY=$(sqlite3 "${DB_FILE}" 'PRAGMA integrity_check' 2>&1)

if [ "${INTEGRITY}" != "ok" ]; then
  echo "ERROR: integrity_check failed: ${INTEGRITY}"
  echo "The restored file may be corrupt. Check the litestream replica."
  exit 1
fi

echo "    integrity_check: ok"
echo ""
echo "Restore complete. Run: docker compose -f ${COMPOSE_DIR}/docker-compose.prod.yml up -d"
