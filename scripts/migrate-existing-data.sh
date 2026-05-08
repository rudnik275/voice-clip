#!/usr/bin/env bash
# One-shot: take the legacy local data/history.json + data/cost.json (the
# single-user Mac deployment's state) and import them as user "dima" on the
# multi-user NAS deployment. Aggregate cost.json on the server is overwritten
# with the local total (since dima is initially the only user).
#
# Run from repo root after deploy.sh has produced a working PUBLIC_URL.
set -euo pipefail

[ -f .env ] || { echo "ERROR: .env not found." >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

: "${PUBLIC_URL:?PUBLIC_URL not set in .env}"
: "${ADMIN_TOKEN:?ADMIN_TOKEN not set in .env}"
: "${NAS_HOST:?}" "${NAS_USER:?}" "${REMOTE_DIR:?}"

[ -f data/history.json ] || { echo "ERROR: data/history.json not found locally — nothing to migrate" >&2; exit 2; }
[ -f data/cost.json ]    || { echo "ERROR: data/cost.json not found locally" >&2; exit 2; }

KEY="$HOME/.ssh/voice-clip-nas"
SSH_OPTS=(-i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)

USER_NAME=${1:-dima}

# Tailscale Funnel DNS may not have propagated to the local resolver yet.
# Resolve via Tailscale's anycast IPs instead so this works immediately. The
# IPs are public + stable; not secrets.
PUBLIC_HOST=$(echo "$PUBLIC_URL" | sed -E 's|^https?://([^/]+).*|\1|')
# Public DNS may not have propagated to local resolver yet. Fall through:
# 1.1.1.1 → 8.8.8.8 → ts.net authoritative NS. Tailscale anycast IPs are
# stable and not secret.
TS_IP=""
for resolver in 1.1.1.1 8.8.8.8 "$(dig +short NS ts.net | head -1)"; do
  [ -z "$resolver" ] && continue
  TS_IP=$(dig +short @"$resolver" "$PUBLIC_HOST" 2>/dev/null | head -1)
  [ -n "$TS_IP" ] && break
done
if [ -n "$TS_IP" ]; then
  RESOLVE_OPT=(--resolve "${PUBLIC_HOST}:443:${TS_IP}")
  echo "Using ${TS_IP} (DNS workaround in case the local resolver still has the old NXDOMAIN cached)"
else
  RESOLVE_OPT=()
  echo "(Local DNS resolution will be used)"
fi

echo "[1/5] Creating one-time invite via /admin/invites…"
INVITE=$(curl -fsS "${RESOLVE_OPT[@]}" --max-time 15 -X POST \
  -H "X-Admin-Token: ${ADMIN_TOKEN}" \
  "${PUBLIC_URL}/admin/invites" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
[ -n "$INVITE" ] || { echo "ERROR: failed to create invite" >&2; exit 3; }
echo "  invite created (token suppressed)"

echo "[2/5] Signing up as ${USER_NAME}…"
COOKIE_FILE=$(mktemp -t voice-clip-cookies.XXXXXX)
trap 'rm -f "$COOKIE_FILE"' EXIT

curl -fsS "${RESOLVE_OPT[@]}" --max-time 15 -X POST \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${USER_NAME}\"}" \
  -c "$COOKIE_FILE" \
  "${PUBLIC_URL}/signup/${INVITE}" >/dev/null

USER_ID=$(curl -fsS "${RESOLVE_OPT[@]}" --max-time 15 \
  -b "$COOKIE_FILE" \
  "${PUBLIC_URL}/me" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
[ -n "$USER_ID" ] || { echo "ERROR: failed to resolve userId" >&2; exit 4; }
echo "  userId: $USER_ID"

echo "[3/5] Creating per-user dir on NAS…"
ssh "${SSH_OPTS[@]}" "${NAS_USER}@${NAS_HOST}" \
  "mkdir -p ${REMOTE_DIR}/data/users/${USER_ID}"

echo "[4/5] Uploading history.json + cost.json…"
scp -O "${SSH_OPTS[@]}" data/history.json \
  "${NAS_USER}@${NAS_HOST}:${REMOTE_DIR}/data/users/${USER_ID}/history.json"
scp -O "${SSH_OPTS[@]}" data/cost.json \
  "${NAS_USER}@${NAS_HOST}:${REMOTE_DIR}/data/users/${USER_ID}/cost.json"

echo "[5/5] Seeding aggregate cost.json (initial total = dima's total since he was the only user)…"
scp -O "${SSH_OPTS[@]}" data/cost.json \
  "${NAS_USER}@${NAS_HOST}:${REMOTE_DIR}/data/cost.json"

echo
echo "✓ migrated. /me on the new server now returns id=${USER_ID:0:8}…"
echo "  Test: curl -b $COOKIE_FILE ${PUBLIC_URL}/history | jq length"
echo "  (cookie file kept temporarily — will be deleted on script exit)"
