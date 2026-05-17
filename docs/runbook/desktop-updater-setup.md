# Desktop auto-updater — one-time owner setup

Voice Clip's macOS app uses Tauri's built-in Ed25519 updater. The CI workflow
(`.github/workflows/tauri-release.yml`) builds a universal `.dmg`, signs the
update manifest with your private key, and publishes both to GitHub Releases.
The server route `GET /desktop/update.json` 302-redirects the Tauri app to the
signed `latest.json` manifest on each release.

**This page covers the four one-time steps you must do before the first
`desktop-v*` tag triggers a working auto-update.**

---

## Step 1 — Generate the Ed25519 signing keypair

Run this on your local Mac (requires Tauri CLI, `cargo install tauri-cli` if
not already present):

```sh
cd desktop/src-tauri
cargo tauri signer generate -w ~/.tauri/voiceclip.key
```

This writes the **private key** to `~/.tauri/voiceclip.key` (keep it out of
git — it's in your home dir, not the repo) and prints the **public key** to
stdout. Copy it; you'll need it in Step 3.

---

## Step 2 — Add GitHub Actions secrets

Go to **GitHub repo → Settings → Secrets and variables → Actions → New
repository secret** and add:

| Secret name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Full contents of `~/.tauri/voiceclip.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The passphrase you chose (or empty string if you pressed Enter when prompted) |

These two secrets are referenced in `.github/workflows/tauri-release.yml` and
are never logged or printed anywhere.

---

## Step 3 — Paste the public key into `tauri.conf.json`

Open `desktop/src-tauri/tauri.conf.json` and replace the placeholder:

```json
"pubkey": "REPLACE_WITH_ED25519_PUBLIC_KEY"
```

with the public key string printed in Step 1 (starts with `dW50cnVzdGVk...`
or similar base64). Commit and push this change — the public key is safe to
commit; only the private key must stay out of the repo.

---

## Step 4 — Tag a release to trigger CI

1. Bump `"version"` in `desktop/src-tauri/tauri.conf.json` (e.g. `"0.2.0"`).
2. Commit: `git commit -am "chore: bump desktop version to 0.2.0"`
3. Tag and push:

```sh
git tag desktop-v0.2.0 && git push origin desktop-v0.2.0
```

The `tauri-release` workflow fires automatically:
- Builds a universal `.dmg` (`aarch64` + `x86_64` via `lipo`).
- Signs the `latest.json` updater manifest with your Ed25519 key.
- Creates a GitHub Release named `Voice Clip desktop-v0.2.0` with both assets attached.

---

## How updates reach users

1. The Tauri app polls (or the user clicks **Check for Updates** in the tray menu).
2. Tauri fetches `https://voice.rudifamily.uk/desktop/update.json`.
3. The server 302-redirects to `https://github.com/…/releases/latest/download/latest.json`.
4. Tauri verifies the Ed25519 signature in `latest.json` against the pubkey in
   `tauri.conf.json`. If the version is newer, it downloads and installs the `.dmg`.
5. The app relaunches into the new version automatically (native macOS update dialog
   shown because `"dialog": true` in `tauri.conf.json`).

---

## Secret discipline

- The private key file (`~/.tauri/voiceclip.key`) must never enter git, chat, or
  AI context. Store a backup in 1Password as a DOCUMENT item.
- The GitHub secret `TAURI_SIGNING_PRIVATE_KEY` is only visible to Actions
  runners; it is masked in all logs.
- The public key in `tauri.conf.json` is not a secret — it is safe (and required)
  to commit.
