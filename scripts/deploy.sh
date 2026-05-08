#!/usr/bin/env bash
# Main deploy:
#   - rsync project sources to NAS:$REMOTE_DIR
#   - scp local .env (with OPENAI_API_KEY etc) to NAS — never read by AI here,
#     scp transmits bytes blindly inside SSH
#   - docker compose up -d --build on the NAS
#   - smoke-test /version
#
# Run from repo root. NAS_PASSWORD is NOT needed (auth via ssh-key).
set -euo pipefail

[ -f .env ] || { echo "ERROR: .env not found. Run: cp .env.example .env, fill values." >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

: "${NAS_HOST:?NAS_HOST not set in .env}"
: "${NAS_USER:?NAS_USER not set in .env}"
: "${REMOTE_DIR:?REMOTE_DIR not set in .env}"
: "${OPENAI_API_KEY:?OPENAI_API_KEY not set in .env}"
: "${ADMIN_TOKEN:?ADMIN_TOKEN not set in .env}"

KEY="$HOME/.ssh/voice-clip-nas"
[ -f "$KEY" ] || { echo "ERROR: ssh-key $KEY missing — run setup-ssh-key.sh first." >&2; exit 2; }

# BatchMode=yes makes ssh fail-fast if it would prompt for a password. On
# Synology DSM sshd, without this flag, ssh attempts password fallback after
# publickey succeeds and rsync hangs with "Permission denied, please try
# again". IdentitiesOnly=yes pins the deploy key (don't try ssh-agent).
SSH_OPTS=(-i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)

echo "[1/4] Ensuring remote dir + data volume exist…"
# `data/` is excluded from rsync (state is per-deployment), so it must be
# pre-created — docker compose with a bind-mount fails if the host path is
# missing.
ssh "${SSH_OPTS[@]}" "${NAS_USER}@${NAS_HOST}" "mkdir -p ${REMOTE_DIR}/data"

echo "[2/4] rsync sources → NAS…"
# --delete: stale files removed; -e: pin ssh-key + opts; excludes line up with
# .dockerignore + don't ship secrets/data/build artefacts.
# --rsync-path: Synology's non-interactive ssh PATH doesn't include /usr/bin,
# and a missing remote rsync surfaces as a misleading "Permission denied,
# please try again". Pin the absolute path.
rsync -avz --delete \
  --rsync-path=/usr/bin/rsync \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='data' \
  --exclude='certs' \
  --exclude='.env' \
  --exclude='.env.*.local' \
  --exclude='conversation-*.txt' \
  --exclude='dist' \
  --exclude='out' \
  --exclude='*.tgz' \
  --exclude='.DS_Store' \
  ./ "${NAS_USER}@${NAS_HOST}:${REMOTE_DIR}/"

echo "[3/4] scp .env → NAS:${REMOTE_DIR}/.env (chmod 600)…"
# scp transmits bytes inside the encrypted SSH channel without echoing them.
# AI is also blocked from reading .env contents (global CLAUDE.md rule).
# `-O` forces the legacy SCP protocol — Synology's sshd ships with the SFTP
# subsystem disabled (modern scp >= 9.0 uses SFTP by default and dies with
# "subsystem request failed on channel 0").
scp -O "${SSH_OPTS[@]}" .env "${NAS_USER}@${NAS_HOST}:${REMOTE_DIR}/.env"
ssh "${SSH_OPTS[@]}" "${NAS_USER}@${NAS_HOST}" "chmod 600 ${REMOTE_DIR}/.env"

echo "[4/4] docker compose up -d --build on NAS…"
# Full path to docker: Synology's /usr/local/bin isn't in non-interactive ssh
# PATH (and the sudoers.d entry written by setup-nas-docker.sh whitelists this
# exact path).
DOCKER=/usr/local/bin/docker
ssh "${SSH_OPTS[@]}" "${NAS_USER}@${NAS_HOST}" "cd ${REMOTE_DIR} && sudo -n ${DOCKER} compose up -d --build"

echo
echo "Smoke: GET /version (via NAS loopback)…"
ssh "${SSH_OPTS[@]}" "${NAS_USER}@${NAS_HOST}" "curl -fsS http://127.0.0.1:8080/version" || {
  echo "FAILED — check 'docker logs voice-clip' on NAS"
  exit 4
}
echo
echo "✓ deployed. If PUBLIC_URL is set, also check ${PUBLIC_URL:-https://<funnel>}/version externally."
