#!/usr/bin/env bash
# One-time owner setup: Tauri updater Ed25519 signing key.
#
#   bash desktop/scripts/setup-signing-key.sh
#
# Generates the keypair, stores the PRIVATE key + passphrase in 1Password
# (vault VoiceClip), sets the two GitHub Actions secrets, and prints ONLY
# the PUBLIC key (safe to commit). No secret value is ever echoed — the
# generator's output is fully suppressed and secrets go to gh/op via stdin
# or argv on this trusted machine, never to stdout.
#
# Guard: refuses to overwrite an existing key unless FORCE=1 — rotating a
# key that already signed a release permanently breaks auto-update for
# every installed app.

set -euo pipefail

VAULT="${VAULT:-VoiceClip}"
REPO="${REPO:-rudnik275/voice-clip}"
KEY="$HOME/.tauri/voiceclip.key"
PUB="$KEY.pub"

note() { printf '  %s\n' "$*"; }
ok()   { printf '\033[32m\xe2\x9c\x93\033[0m %s\n' "$*"; }
die()  { printf '\033[31m\xe2\x9c\x97 %s\033[0m\n' "$*" >&2; exit 1; }

# ---- prerequisites ----------------------------------------------------------
command -v cargo >/dev/null || die "cargo not found"
cargo tauri --version >/dev/null 2>&1 || die "cargo-tauri not installed (cargo install tauri-cli --version ^2)"
command -v op >/dev/null || die "1Password CLI 'op' not found"
command -v gh >/dev/null || die "GitHub CLI 'gh' not found"
op whoami >/dev/null 2>&1 || die "op not signed in — unlock the 1Password app / run 'op signin' and retry"
gh auth status >/dev/null 2>&1 || die "gh not authenticated — run 'gh auth login' and retry"
op vault get "$VAULT" >/dev/null 2>&1 || die "1Password vault '$VAULT' not found (override with VAULT=...)"

# ---- guard against accidental key rotation ---------------------------------
if [ -e "$KEY" ] && [ "${FORCE:-0}" != "1" ]; then
  die "$KEY already exists. Rotating breaks auto-update for installed apps. Re-run with FORCE=1 ONLY if you are sure no signed release exists yet."
fi

# ---- generate keypair (non-interactive, output fully suppressed) -----------
mkdir -p "$HOME/.tauri"
# Single command, no pipe: `tr </dev/urandom | head` SIGPIPEs `tr`, which
# under `set -e -o pipefail` kills the script silently. openssl has neither
# problem; 48 hex chars = 192 bits, argv- and passphrase-safe.
PASS="$(openssl rand -hex 24)"
[ -n "$PASS" ] || die "passphrase generation failed (openssl)"
trap 'PASS=""; unset PASS 2>/dev/null || true' EXIT
cargo tauri signer generate --ci -p "$PASS" -w "$KEY" -f >/dev/null 2>&1 \
  || die "key generation failed"
[ -s "$KEY" ] || die "private key file not written"
[ -s "$PUB" ] || die "public key file not written"
chmod 600 "$KEY"
ok "keypair generated: $KEY (private, encrypted) + $PUB (public)"

# ---- store in 1Password (vault $VAULT) -------------------------------------
# Existence check via `op item list` only (titles, no secret values).
# No pipe: grep -q early-exit + pipefail would misreport "found" as failure.
have_item() {
  local out
  out="$(op item list --vault "$VAULT" --format=json 2>/dev/null || true)"
  case "$out" in *"\"title\": \"$1\""*) return 0 ;; *) return 1 ;; esac
}

if have_item "tauri-signing-key"; then
  note "1Password: document 'tauri-signing-key' already exists — skipped"
else
  op document create "$KEY" --title "tauri-signing-key" --vault "$VAULT" \
    --tags "voice-clip,tauri,signing" >/dev/null \
    || die "op document create failed"
  ok "private key uploaded to 1Password ($VAULT / tauri-signing-key)"
fi

if have_item "tauri-signing-key passphrase"; then
  note "1Password: 'tauri-signing-key passphrase' already exists — skipped"
else
  op item create --category password \
    --title "tauri-signing-key passphrase" --vault "$VAULT" \
    --tags "voice-clip,tauri,signing" \
    "password=$PASS" \
    "notesPlain=Passphrase for the Tauri updater Ed25519 private key (1Password document 'tauri-signing-key', same vault). Mirror of GitHub Actions secret TAURI_SIGNING_PRIVATE_KEY_PASSWORD in $REPO." >/dev/null \
    || die "op item create (passphrase) failed"
  ok "passphrase stored in 1Password ($VAULT / tauri-signing-key passphrase)"
fi

# ---- GitHub Actions secrets (value via stdin/argv, never stdout) -----------
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo "$REPO" < "$KEY" \
  || die "gh secret set TAURI_SIGNING_PRIVATE_KEY failed"
ok "GitHub secret TAURI_SIGNING_PRIVATE_KEY set"

printf '%s' "$PASS" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo "$REPO" \
  || die "gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD failed"
ok "GitHub secret TAURI_SIGNING_PRIVATE_KEY_PASSWORD set"

# ---- output the PUBLIC key (safe to commit) --------------------------------
echo
echo "===== PUBLIC KEY — paste this whole block back to Claude ====="
cat "$PUB"
echo "=============================================================="
echo
ok "Done. Private key + passphrase are in 1Password ($VAULT) and GitHub secrets."
note "Next: Claude commits the public key into tauri.conf.json and tags desktop-v0.2.0."
