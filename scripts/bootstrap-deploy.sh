#!/usr/bin/env bash
# bootstrap-deploy.sh — one command, full first deploy of voice-clip to the VPS.
#
# Usage:
#   ./scripts/bootstrap-deploy.sh                 # prompts for the VPS host
#   SSH_HOST=46.62.229.131 ./scripts/bootstrap-deploy.sh
#   ./scripts/bootstrap-deploy.sh 46.62.229.131
#
# Idempotent — safe to re-run. Every step is a no-op if already done, so if it
# stops at the Google-OAuth gate you just fill .env and run the SAME command.
#
# What it does, end to end:
#   1. Validates local .env has the v2 keys (Google OAuth client is the ONLY
#      step a script can't do — Google has no CLI for a Web OAuth client +
#      consent screen; if missing it prints the exact 2-min console steps).
#   2. Reminds you to flip the GHCR package to Public (one click; your gh
#      token has no packages scope so this can't be automated).
#   3. VPS: creates /opt/voice-clip/data, ensures the shared infra-net.
#   4. Ships .env + docker-compose.prod.yml (scp, never printed).
#   5. Adds the voice.rudifamily.uk ingress to the VPS cloudflared config
#      (idempotent) and restarts cloudflared.
#   6. docker compose pull + up -d  (first deploy, synchronous).
#   7. Polls https://voice.rudifamily.uk/version until healthy.
# Subsequent deploys: just `git push` — Watchtower auto-rolls (6h poll), or
# `./scripts/redeploy.sh` for an instant roll.
#
# Secrets: this script runs in YOUR terminal. It NEVER cats/echoes .env or any
# secret value — only key NAMES and SET/MISSING status — so its output is safe
# to paste back into a chat.

set -euo pipefail

# ─── Config (override via env) ──────────────────────────────────────────────
SSH_USER="${SSH_USER:-deploy}"
REMOTE_DIR="${REMOTE_DIR:-/opt/voice-clip}"
CF_DIR="${CF_DIR:-/opt/_infra/cloudflared}"
PUBLIC_HOST="${PUBLIC_HOST:-voice.rudifamily.uk}"
PUBLIC_URL="https://${PUBLIC_HOST}"
IMAGE="ghcr.io/rudnik275/voice-clip:latest"
GHCR_SETTINGS_URL="https://github.com/users/rudnik275/packages/container/voice-clip/settings"

cd "$(dirname "$0")/.."   # repo root

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ─── 0. Tooling ─────────────────────────────────────────────────────────────
for c in ssh scp curl; do command -v "$c" >/dev/null || die "$c not found"; done
[ -f .env ] || die ".env not found in repo root — copy .env.example to .env first"
[ -f docker-compose.prod.yml ] || die "docker-compose.prod.yml missing"

# ─── 1. Resolve VPS host ────────────────────────────────────────────────────
SSH_HOST="${1:-${SSH_HOST:-}}"
if [ -z "${SSH_HOST}" ]; then
  read -rp "VPS host/IP (the valorant-bot VPS, e.g. 46.62.229.131): " SSH_HOST
fi
[ -n "${SSH_HOST}" ] || die "no VPS host given"
T="${SSH_USER}@${SSH_HOST}"
SSH_OPTS=(-o ConnectTimeout=10)
say "Checking SSH to ${T}"
ssh "${SSH_OPTS[@]}" "${T}" true \
  || die "cannot SSH to ${T} (1Password SSH agent / key set up? host correct?)"
ok "SSH OK"

# ─── 2. Validate local .env (names only, never values) ──────────────────────
say "Validating local .env for v2"
env_has() { grep -qE "^$1=.+" .env; }
MISSING=()
for k in OPENAI_API_KEY GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET \
         VOICE_CLIP_ALLOWED_EMAILS PUBLIC_URL; do
  env_has "$k" && printf '  %-28s SET\n' "$k" || { printf '  %-28s MISSING\n' "$k"; MISSING+=("$k"); }
done

if [ "${#MISSING[@]}" -ne 0 ]; then
  cat <<EOF

$(warn ".env is missing: ${MISSING[*]}")

The Google OAuth client is the only thing no script can create (Google has no
CLI for a Web client + consent screen). Do this once (~2 min):

  1. https://console.cloud.google.com/apis/credentials
       → Create credentials → OAuth client ID → Web application
  2. Authorized JavaScript origins:  ${PUBLIC_URL}
  3. Authorized redirect URIs:       ${PUBLIC_URL}/auth/google/callback
  4. Copy Client ID + Client Secret.

Then add to .env (edit it in YOUR editor — never share the values):

  OPENAI_API_KEY=sk-...                         # keep existing if already set
  GOOGLE_OAUTH_CLIENT_ID=....apps.googleusercontent.com
  GOOGLE_OAUTH_CLIENT_SECRET=...
  VOICE_CLIP_ALLOWED_EMAILS=dmitriyrudnik@gmail.com,partner@example.com
  PUBLIC_URL=${PUBLIC_URL}

Re-run the exact same command afterwards — it picks up from here.
EOF
  exit 2
fi

if ! grep -qE "^PUBLIC_URL=${PUBLIC_URL}$" .env; then
  warn "PUBLIC_URL in .env != ${PUBLIC_URL} — the Google redirect_uri must match EXACTLY or login breaks"
fi
ok ".env has all v2 keys"

# ─── 3. GHCR package must be Public (Watchtower + VPS pull need it) ─────────
say "GHCR package visibility"
cat <<EOF
The repo is private, so ghcr.io/rudnik275/voice-clip is private too. The VPS
and Watchtower pull anonymously, so the *package* must be Public (the image
has no secrets — those live in .env on the VPS). Your gh token has no packages
scope, so flip it by hand (one-time, ~15s):

  ${GHCR_SETTINGS_URL}
  → Danger Zone → Change visibility → Public → type "voice-clip" to confirm

EOF
read -rp "Press Enter once the package is Public (or already was)… " _

# ─── 4. VPS prep ────────────────────────────────────────────────────────────
say "Preparing VPS"
ssh "${SSH_OPTS[@]}" "${T}" "mkdir -p '${REMOTE_DIR}/data' && (docker network inspect infra-net >/dev/null 2>&1 || docker network create infra-net)"
ok "data dir + infra-net ready"

# ─── 5. Ship .env + compose (scp; contents never printed) ──────────────────
say "Shipping .env + compose to ${REMOTE_DIR}"
scp -q "${SSH_OPTS[@]}" .env "${T}:${REMOTE_DIR}/.env"
scp -q "${SSH_OPTS[@]}" docker-compose.prod.yml "${T}:${REMOTE_DIR}/docker-compose.prod.yml"
ssh "${SSH_OPTS[@]}" "${T}" "chmod 600 '${REMOTE_DIR}/.env'"
ok "files in place"

# ─── 6. Cloudflared ingress (idempotent) ───────────────────────────────────
say "Cloudflare Tunnel ingress for ${PUBLIC_HOST}"
if ! ssh "${SSH_OPTS[@]}" "${T}" "test -f '${CF_DIR}/config.yml'"; then
  warn "no ${CF_DIR}/config.yml on VPS — add this ingress entry by hand, above the http_status:404 catch-all:"
  printf '    - hostname: %s\n      service: http://voice-clip:8080\n' "${PUBLIC_HOST}"
elif ssh "${SSH_OPTS[@]}" "${T}" "grep -q '${PUBLIC_HOST}' '${CF_DIR}/config.yml'"; then
  ok "ingress already present"
else
  ssh "${SSH_OPTS[@]}" "${T}" \
    "sed -i 's#^\\(\\s*\\)- service: http_status:404#\\1- hostname: ${PUBLIC_HOST}\\n\\1  service: http://voice-clip:8080\\n\\1- service: http_status:404#' '${CF_DIR}/config.yml' && (docker restart cloudflared >/dev/null 2>&1 || (cd '${CF_DIR}' && docker compose up -d))"
  ok "ingress added + cloudflared restarted"
fi

# ─── 7. First deploy (synchronous) ─────────────────────────────────────────
say "Pulling image + starting container"
if ! ssh "${SSH_OPTS[@]}" "${T}" "cd '${REMOTE_DIR}' && docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d"; then
  die "docker pull/up failed — most likely the GHCR package is still Private (step 3): ${GHCR_SETTINGS_URL}"
fi
ok "container started"

# ─── 8. Verify ──────────────────────────────────────────────────────────────
say "Waiting for ${PUBLIC_URL}/version"
DEPLOYED=""
for i in $(seq 1 40); do
  if V=$(curl -fsS --max-time 5 "${PUBLIC_URL}/version" 2>/dev/null); then
    DEPLOYED="$V"; break
  fi
  if L=$(ssh "${SSH_OPTS[@]}" "${T}" "curl -fsS --max-time 3 http://127.0.0.1:8080/version" 2>/dev/null) && [ -n "$L" ]; then
    printf '  app healthy on VPS (%s); waiting for Cloudflare DNS/route…\n' "$L"
  else
    printf '  attempt %s/40: not healthy yet, 3s…\n' "$i"
  fi
  sleep 3
done

if [ -n "${DEPLOYED}" ]; then
  ok "LIVE — ${PUBLIC_URL}/version → ${DEPLOYED}"
  WT=$(ssh "${SSH_OPTS[@]}" "${T}" "docker ps --format '{{.Names}}'" 2>/dev/null | grep -qx watchtower && echo yes || echo no)
  if [ "$WT" = yes ]; then
    ok "Watchtower running → future 'git push master' auto-rolls (≤6h); ./scripts/redeploy.sh for instant"
  else
    warn "Watchtower NOT running — future deploys need ./scripts/redeploy.sh (or start the shared watchtower from valorant-comunity-bot/infra/_compose/watchtower)"
  fi
  cat <<EOF

Next: open ${PUBLIC_URL} → "Sign in with Google".
  - allowlisted email  → "Hello, Dmitriy"
  - other email        → "Access denied"
EOF
else
  warn "did not become reachable in time. Diagnose:"
  echo "  ssh ${T} \"cd ${REMOTE_DIR} && docker compose -f docker-compose.prod.yml logs --tail=120 voice-clip\""
  echo "  (if the app is healthy on the VPS but ${PUBLIC_HOST} isn't, it's Cloudflare DNS/route — recheck step 6 + the tunnel)"
  exit 1
fi
