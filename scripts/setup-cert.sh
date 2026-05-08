#!/usr/bin/env bash
set -euo pipefail

HOSTNAME="${1:-$(scutil --get LocalHostName).local}"
CERT_DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$CERT_DIR"

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert not found. Install:  brew install mkcert nss" >&2
  exit 1
fi

mkcert -install
mkcert -cert-file "$CERT_DIR/cert.pem" -key-file "$CERT_DIR/key.pem" "$HOSTNAME" localhost 127.0.0.1 ::1

CA_ROOT="$(mkcert -CAROOT)"

echo
echo "Cert generated for: $HOSTNAME"
echo "  $CERT_DIR/cert.pem"
echo "  $CERT_DIR/key.pem"
echo
echo "To trust on iPhone (one time):"
echo "  1. AirDrop or email this file to the iPhone:"
echo "       $CA_ROOT/rootCA.pem"
echo "  2. On iPhone: open the file → Settings prompts to install profile"
echo "  3. Settings → General → VPN & Device Management → install the profile"
echo "  4. Settings → General → About → Certificate Trust Settings → enable mkcert root"
echo
echo "Then on the iPhone open: https://$HOSTNAME:8443"
