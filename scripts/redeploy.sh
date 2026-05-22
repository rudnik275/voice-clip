#!/usr/bin/env bash
# redeploy.sh — manual emergency roll: pull the latest image + restart.
#
# Normal deploys are automatic: a push to master runs the `deploy` job in
# .github/workflows/server-deploy.yml, which rolls the image and health-gates
# it. Use this script only when CI itself is unavailable and you need to roll
# by hand from your Mac.
#
# Usage:
#   ./scripts/redeploy.sh                       # prompts for the VPS host
#   SSH_HOST=46.62.229.131 ./scripts/redeploy.sh
#   ./scripts/redeploy.sh 46.62.229.131
#
# First deploy / .env / cloudflared changes → use bootstrap-deploy.sh instead.

set -euo pipefail

cd "$(dirname "$0")/.."   # repo root — need local compose + litestream.yml to ship

SSH_USER="${SSH_USER:-deploy}"
REMOTE_DIR="${REMOTE_DIR:-/opt/voice-clip}"
PUBLIC_URL="https://${PUBLIC_HOST:-voice.rudifamily.uk}"

SSH_HOST="${1:-${SSH_HOST:-}}"
[ -z "${SSH_HOST}" ] && read -rp "VPS host/IP: " SSH_HOST
[ -n "${SSH_HOST}" ] || { echo "✗ no VPS host" >&2; exit 1; }
T="${SSH_USER}@${SSH_HOST}"

echo "▸ Syncing compose + litestream.yml to ${REMOTE_DIR}"
scp -q -o ConnectTimeout=10 docker-compose.prod.yml litestream.yml "${T}:${REMOTE_DIR}/"

echo "▸ Rolling ${REMOTE_DIR} on ${T}"
ssh -o ConnectTimeout=10 "${T}" "cd '${REMOTE_DIR}' && docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d"

echo "▸ Verifying ${PUBLIC_URL}/version"
for i in $(seq 1 20); do
  if V=$(curl -fsS --max-time 5 "${PUBLIC_URL}/version" 2>/dev/null); then
    echo "✓ LIVE → ${V}"; exit 0
  fi
  sleep 3
done
echo "✗ not reachable in time — ssh ${T} \"cd ${REMOTE_DIR} && docker compose logs --tail=80 voice-clip\"" >&2
exit 1
