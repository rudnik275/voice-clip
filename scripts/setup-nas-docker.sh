#!/usr/bin/env bash
# One-time: grant the deploy user passwordless sudo for /usr/local/bin/docker
# on the Synology NAS, so deploy.sh can run `sudo docker compose up -d --build`
# without a password prompt.
#
# Synology DSM admins are NOT in any sudoers NOPASSWD group by default. The
# only sudo for them is "ask password every time" — fine for human admin via
# DSM web UI, painful for an automated deploy script.
#
# This script:
#   - reads NAS_PASSWORD from env (injected by `op run --env-file=.env.1password`)
#   - opens an ssh session to the NAS using the deploy ssh-key (set up by
#     setup-ssh-key.sh) — auth itself doesn't need the password
#   - pipes the password through ssh stdin into `sudo -S` on the NAS
#   - sudo writes a tight /etc/sudoers.d entry: NOPASSWD only for the docker
#     binary, no other commands
#
# Run once via the wrapper so NAS_PASSWORD never lands on the local terminal:
#   with-secrets ./scripts/setup-nas-docker.sh
set -euo pipefail

[ -f .env ] || { echo "ERROR: .env not found." >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

: "${NAS_HOST:?NAS_HOST not set in .env}"
: "${NAS_USER:?NAS_USER not set in .env}"
: "${NAS_PASSWORD:?NAS_PASSWORD not set — did you run via with-secrets?}"

KEY="$HOME/.ssh/voice-clip-nas"
[ -f "$KEY" ] || { echo "ERROR: $KEY missing — run setup-ssh-key.sh first." >&2; exit 2; }

DOCKER_BIN=/usr/local/bin/docker
TAILSCALE_BIN=/var/packages/Tailscale/target/bin/tailscale
SUDOERS_PATH="/etc/sudoers.d/${NAS_USER}-voice-clip-docker"

echo "Granting NOPASSWD sudo for docker + tailscale to ${NAS_USER} on NAS…"

# Pipe password to sudo via stdin; sudo -S reads the first line as password.
# `-p ''` suppresses the "Password:" prompt that would otherwise leak into
# the ssh stderr.
echo "$NAS_PASSWORD" | ssh -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
  "${NAS_USER}@${NAS_HOST}" \
  "sudo -S -p '' sh -c \"echo '${NAS_USER} ALL=(ALL) NOPASSWD: ${DOCKER_BIN}, ${TAILSCALE_BIN}' > ${SUDOERS_PATH} && chmod 440 ${SUDOERS_PATH}\""

echo
echo "Verifying NOPASSWD by running 'sudo -n docker version'…"
ssh -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes "${NAS_USER}@${NAS_HOST}" "sudo -n ${DOCKER_BIN} version --format '{{.Server.Version}}'" \
  && echo "✓ deploy user can now run docker + tailscale without a password" \
  || { echo "FAILED — check $SUDOERS_PATH on NAS" >&2; exit 3; }
