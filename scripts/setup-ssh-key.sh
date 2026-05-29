#!/usr/bin/env bash
# One-time: generate ~/.ssh/voice-clip-nas, then ssh-copy-id to the NAS so
# subsequent deploy.sh runs use the key (not the password).
#
# Run via the wrapper so NAS_PASSWORD is masked in stdout/stderr:
#   with-secrets ./scripts/setup-ssh-key.sh
#
# After this runs once, you can rotate the NAS password in DSM at any time —
# the ssh-key keeps working.
set -euo pipefail

# Required from .env (NAS_HOST) and .env.1password (NAS_USERNAME, NAS_PASSWORD).
[ -f .env ] || { echo "ERROR: .env not found. Run: cp .env.example .env, fill values." >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

: "${NAS_HOST:?NAS_HOST not set in .env}"
: "${NAS_USERNAME:?NAS_USERNAME not set — did you run via with-secrets?}"
: "${NAS_PASSWORD:?NAS_PASSWORD not set — did you run via with-secrets?}"

KEY="$HOME/.ssh/voice-clip-nas"

if ! command -v sshpass >/dev/null 2>&1; then
  echo "sshpass is required. On macOS:"
  echo "  brew install hudochenkov/sshpass/sshpass"
  echo "(it isn't in homebrew-core for licensing reasons; the tap above is the standard fork.)"
  exit 2
fi

if [ ! -f "$KEY" ]; then
  echo "Generating new ed25519 keypair at $KEY (no passphrase)…"
  ssh-keygen -t ed25519 -f "$KEY" -N "" -C "voice-clip-deploy@$(hostname)"
else
  echo "Key already exists at $KEY — reusing it."
fi

echo "Copying public key to ${NAS_USERNAME}@${NAS_HOST}…"
# StrictHostKeyChecking=accept-new = accept the host fingerprint on first
# contact (records it in known_hosts), but strict on every later run.
SSHPASS="$NAS_PASSWORD" sshpass -e ssh-copy-id \
  -i "${KEY}.pub" \
  -o StrictHostKeyChecking=accept-new \
  -o PubkeyAuthentication=no \
  "${NAS_USERNAME}@${NAS_HOST}"

echo
echo "✓ ssh-key registered. Verify:"
echo "  ssh -i $KEY ${NAS_USERNAME}@${NAS_HOST} hostname"
