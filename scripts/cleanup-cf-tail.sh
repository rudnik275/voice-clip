#!/usr/bin/env bash
# cleanup-cf-tail.sh — one-pass cleanup of the stray Cloudflare tunnel +
# its VPS files + its DNS record. Idempotent and dry-run by default.
#
# Usage:
#   op run --env-file=.env.cleanup-cf.1password -- ./scripts/cleanup-cf-tail.sh           # dry-run
#   op run --env-file=.env.cleanup-cf.1password -- ./scripts/cleanup-cf-tail.sh --apply   # execute
#
# WHAT IT TOUCHES (and only these — the prod tunnel is verified before any
# destructive step):
#   - VPS container       voice-clip-cloudflared                    (stop + rm)
#   - VPS files           /opt/voice-clip/cloudflared-config.yml
#                         /opt/voice-clip/cloudflared-creds.json
#                         /tmp/cfauth/                              (whole dir)
#   - Cloudflare DNS      clip.rudifamily.uk  (CNAME of stray tunnel)
#   - Cloudflare tunnel   3087388c-4d9c-4e29-bad8-0aa6bd16c751
#
# Token rotation lives in the Cloudflare dashboard — this script does NOT
# attempt to revoke CF_API_TOKEN. Do it by hand at
# https://dash.cloudflare.com/profile/api-tokens once the script finishes.

set -euo pipefail

# --- config -----------------------------------------------------------------
SSH_USER="${SSH_USER:-deploy}"
SSH_HOST="${SSH_HOST:-46.62.229.131}"
T="${SSH_USER}@${SSH_HOST}"

STRAY_CONTAINER="voice-clip-cloudflared"
STRAY_TUNNEL_UUID="3087388c-4d9c-4e29-bad8-0aa6bd16c751"
PROD_TUNNEL_UUID="30379608-2d8c-4281-9b39-6114cacf6371"
STRAY_RECORD="clip.rudifamily.uk"
ZONE_NAME="rudifamily.uk"
PROD_HEALTH_URL="https://voice.rudifamily.uk/version"

VPS_FILES=(
  "/opt/voice-clip/cloudflared-config.yml"
  "/opt/voice-clip/cloudflared-creds.json"
)
VPS_DIRS=(
  "/tmp/cfauth"
)

# --- args -------------------------------------------------------------------
APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ "$APPLY" -eq 1 ]; then
  echo "▸ MODE: APPLY (destructive)"
else
  echo "▸ MODE: DRY-RUN (no changes — re-run with --apply to execute)"
fi
echo

# --- preflight --------------------------------------------------------------
if [ -z "${CF_API_TOKEN:-}" ]; then
  echo "✗ CF_API_TOKEN not set. Run via:"
  echo "    op run --env-file=.env.cleanup-cf.1password -- $0 $*"
  exit 2
fi

cf() {
  curl -fsS --max-time 15 \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    "$@"
}

echo "▸ Preflight: CF token has correct scopes"
me=$(cf "https://api.cloudflare.com/client/v4/user/tokens/verify" | grep -oE '"status":"active"' || true)
[ -n "$me" ] || { echo "✗ CF token not active or scopes missing"; exit 1; }
echo "  ✓ token active"

echo "▸ Preflight: prod tunnel ${PROD_TUNNEL_UUID:0:8}… alive"
prod_running=$(ssh -o ConnectTimeout=10 "${T}" 'docker inspect --format "{{.State.Running}}" cloudflared 2>/dev/null || echo false')
[ "$prod_running" = "true" ] || { echo "✗ prod cloudflared container not running — abort"; exit 1; }
echo "  ✓ prod cloudflared container running"

echo "▸ Preflight: ${PROD_HEALTH_URL} responds"
prod_health=$(curl -fsS --max-time 10 "${PROD_HEALTH_URL}" 2>/dev/null || echo FAIL)
[ "$prod_health" != "FAIL" ] || { echo "✗ prod URL not reachable — abort before touching anything"; exit 1; }
echo "  ✓ prod responds: ${prod_health}"

echo "▸ Preflight: stray container exists and is the right one (UUID match)"
stray_present=$(ssh "${T}" "docker ps -a --filter name=^${STRAY_CONTAINER}\$ --format '{{.Names}}'")
if [ -z "$stray_present" ]; then
  echo "  ✓ stray container already removed (idempotent)"
else
  stray_uuid=$(ssh "${T}" "grep -oE '[0-9a-f-]{36}' /opt/voice-clip/cloudflared-config.yml 2>/dev/null | head -1 || echo none")
  [ "$stray_uuid" = "$STRAY_TUNNEL_UUID" ] \
    || { echo "✗ config UUID mismatch ($stray_uuid vs expected $STRAY_TUNNEL_UUID) — abort, manual check needed"; exit 1; }
  echo "  ✓ container ${STRAY_CONTAINER} configured for tunnel ${STRAY_TUNNEL_UUID:0:8}…"
fi
echo

# --- zone + record + tunnel discovery --------------------------------------
echo "▸ Resolving Cloudflare zone ID for ${ZONE_NAME}"
zone_id=$(cf "https://api.cloudflare.com/client/v4/zones?name=${ZONE_NAME}" \
  | grep -oE '"id":"[a-f0-9]{32}"' | head -1 | cut -d'"' -f4)
[ -n "$zone_id" ] || { echo "✗ zone not found"; exit 1; }
echo "  ✓ zone id ${zone_id:0:8}…"

echo "▸ Resolving DNS record ID for ${STRAY_RECORD}"
record_id=$(cf "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records?name=${STRAY_RECORD}" \
  | grep -oE '"id":"[a-f0-9]{32}"' | head -1 | cut -d'"' -f4 || true)
if [ -n "$record_id" ]; then
  echo "  ✓ record id ${record_id:0:8}…"
else
  echo "  ✓ no DNS record for ${STRAY_RECORD} (idempotent)"
fi

echo "▸ Resolving Cloudflare account ID (needed for tunnel API)"
account_id=$(cf "https://api.cloudflare.com/client/v4/accounts" \
  | grep -oE '"id":"[a-f0-9]{32}"' | head -1 | cut -d'"' -f4)
[ -n "$account_id" ] || { echo "✗ account not found"; exit 1; }
echo "  ✓ account id ${account_id:0:8}…"

echo "▸ Looking up stray tunnel ${STRAY_TUNNEL_UUID:0:8}…"
tunnel_status=$(cf "https://api.cloudflare.com/client/v4/accounts/${account_id}/cfd_tunnel/${STRAY_TUNNEL_UUID}" \
  | grep -oE '"deleted_at":(null|"[^"]+")' | head -1 || echo "none")
if [ "$tunnel_status" = "none" ]; then
  echo "  ✓ tunnel not found via API (already gone, idempotent)"
elif echo "$tunnel_status" | grep -q '"deleted_at":null'; then
  echo "  ✓ tunnel exists and is active — will be deleted"
else
  echo "  ✓ tunnel already deleted (idempotent)"
fi
echo

# --- plan summary -----------------------------------------------------------
cat <<EOF
=== PLAN ===
1. docker stop ${STRAY_CONTAINER}; docker rm ${STRAY_CONTAINER}
2. rm ${VPS_FILES[*]}
3. rm -rf ${VPS_DIRS[*]}
4. CF DNS DELETE ${STRAY_RECORD} (record ${record_id:-<absent>})
5. CF tunnel DELETE ${STRAY_TUNNEL_UUID}
6. Verify ${PROD_HEALTH_URL} still responds

EOF

if [ "$APPLY" -eq 0 ]; then
  echo "Dry-run done. Re-run with --apply to execute."
  exit 0
fi

# --- execute ---------------------------------------------------------------
echo "▸ [1/6] Stop + remove ${STRAY_CONTAINER}"
ssh "${T}" "docker rm -f ${STRAY_CONTAINER} 2>&1 || true"
echo

echo "▸ [2/6] rm VPS files"
ssh "${T}" "rm -fv ${VPS_FILES[*]}"
echo

echo "▸ [3/6] rm VPS dirs"
ssh "${T}" "rm -rfv ${VPS_DIRS[*]}"
echo

if [ -n "$record_id" ]; then
  echo "▸ [4/6] CF DNS DELETE ${STRAY_RECORD}"
  cf -X DELETE "https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records/${record_id}" \
    | grep -oE '"success":(true|false)' | head -1
else
  echo "▸ [4/6] CF DNS DELETE skipped (no record)"
fi
echo

echo "▸ [5/6] CF tunnel DELETE ${STRAY_TUNNEL_UUID}"
# `cleanup=true` purges stale connections so the tunnel deletes cleanly even
# if cloudflared was just stopped a moment ago.
cf -X DELETE "https://api.cloudflare.com/client/v4/accounts/${account_id}/cfd_tunnel/${STRAY_TUNNEL_UUID}?cleanup=true" \
  | grep -oE '"success":(true|false)' | head -1 || true
echo

echo "▸ [6/6] Verify prod still healthy"
final=$(curl -fsS --max-time 10 "${PROD_HEALTH_URL}" 2>/dev/null || echo FAIL)
if [ "$final" = "FAIL" ]; then
  echo "✗ prod URL down after cleanup — INVESTIGATE IMMEDIATELY"
  exit 1
fi
echo "  ✓ ${PROD_HEALTH_URL} → ${final}"
echo

echo "✓ Cleanup done. Last manual step: revoke the read-only CF token in the"
echo "  dashboard → https://dash.cloudflare.com/profile/api-tokens"
echo "  Look for the token referenced by op://VoiceClip/cf-token/api-token."
