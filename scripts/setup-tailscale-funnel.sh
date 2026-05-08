#!/usr/bin/env bash
# Configure Tailscale Funnel on the NAS so the Bun container at 127.0.0.1:8080
# is reachable from the public internet via https://<nas>.tail-XXXX.ts.net.
#
# Prerequisites (do these once in DSM UI before running this script):
#   1. Package Center → install Tailscale.
#   2. Open Tailscale package → sign in to your Tailscale account.
#   3. (Optional but recommended) In Tailscale Admin Console, the NAS device
#      must have HTTPS Funnel enabled in its access controls.
#
# This script (idempotent):
#   - shells into NAS via the ssh-key set up by setup-ssh-key.sh
#   - registers /var/run/tailscale.sock backend with `tailscale serve`
#   - exposes via Funnel on port 443
#   - prints the public URL to stdout — paste it into PUBLIC_URL in .env
set -euo pipefail

[ -f .env ] || { echo "ERROR: .env not found." >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

: "${NAS_HOST:?NAS_HOST not set in .env}"
: "${NAS_USER:?NAS_USER not set in .env}"

KEY="$HOME/.ssh/voice-clip-nas"
[ -f "$KEY" ] || { echo "ERROR: ssh-key $KEY missing — run setup-ssh-key.sh first." >&2; exit 2; }

REMOTE() {
  ssh -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "${NAS_USER}@${NAS_HOST}" "$@"
}

# Synology installs Tailscale in /var/packages/Tailscale. The CLI is symlinked
# but on some DSM versions only the absolute path works under non-interactive
# ssh — try sudo if the user can't run it directly.
TS_BIN="/var/packages/Tailscale/target/bin/tailscale"
echo "Detecting Tailscale binary on NAS…"
if ! REMOTE "test -x $TS_BIN"; then
  echo "ERROR: $TS_BIN not found on NAS. Is the Tailscale package installed?" >&2
  exit 3
fi

echo "Configuring Tailscale to serve http://127.0.0.1:8080…"
# `tailscale serve` and `tailscale funnel` need root on Synology — DSM admin
# users get sudo without password by default. If your account doesn't, run
# this script while ssh'd in as root.
REMOTE "sudo $TS_BIN serve --bg http://127.0.0.1:8080"
REMOTE "sudo $TS_BIN funnel 443 on"

echo
echo "Funnel status:"
REMOTE "sudo $TS_BIN funnel status" || true

echo
echo "Public URL (paste into PUBLIC_URL in your .env):"
# `tailscale status --json` includes Self.DNSName which is the public funnel
# hostname when funnel is enabled.
REMOTE "sudo $TS_BIN status --json" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); name=d.get("Self",{}).get("DNSName","").rstrip("."); print("https://" + name if name else "unknown")'
