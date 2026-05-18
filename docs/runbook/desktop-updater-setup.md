# Desktop auto-updater — one-time owner setup

Voice Clip's macOS app uses Tauri's built-in Ed25519 updater. The CI workflow
(`.github/workflows/tauri-release.yml`) builds a universal `.dmg`, signs the
update manifest with your private key, and publishes both to GitHub Releases.
The server route `GET /desktop/update.json` 302-redirects the Tauri app to the
signed `latest.json` manifest on each release.

---

## One command (do this once)

Run on your local Mac, in your **own** terminal (not via an AI session — the
generator handles the private key):

```sh
bash desktop/scripts/setup-signing-key.sh
```

Prereqs the script checks for you: `cargo-tauri`
(`cargo install tauri-cli --version "^2"`), the 1Password CLI signed in
(`op signin` / unlock the app), and `gh` authenticated.

It does everything end-to-end:

- generates the Ed25519 keypair with a random 192-bit passphrase
- uploads the **private key** to 1Password → `VoiceClip / tauri-signing-key`
  (document) and the **passphrase** → `VoiceClip / tauri-signing-key passphrase`
- sets the two GitHub Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (values via stdin, never stdout)
- prints **only the public key**

No secret value is ever echoed. The script refuses to overwrite an existing
`~/.tauri/voiceclip.key` unless you pass `FORCE=1` — rotating a key that has
already signed a published release permanently breaks auto-update for every
installed app, so only force when you are certain no signed release exists yet.

Hand the printed public key to Claude (it is safe to commit, not a secret);
Claude writes it into `desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).

> Recovery: the private key + passphrase live in 1Password vault `VoiceClip`.
> If GitHub secrets are ever lost, re-create them from there — do **not**
> regenerate the key, or installed apps can no longer auto-update.

---

## Cut a release

1. Bump `version` in `desktop/src-tauri/tauri.conf.json` **and** `Cargo.toml`
   (keep them equal), refresh `Cargo.lock` (`cargo check`).
2. Commit, then tag and push:

```sh
git tag desktop-v0.2.0 && git push origin desktop-v0.2.0
```

The `tauri-release` workflow fires automatically:
- Builds a universal `.dmg` (`aarch64` + `x86_64` via `lipo`).
- Signs the `latest.json` updater manifest with your Ed25519 key.
- Creates a GitHub Release named `Voice Clip desktop-v0.2.0` with both assets.

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

- The private key (1Password document `tauri-signing-key`) and its passphrase
  must never enter git, chat, or AI context. The setup script enforces this by
  suppressing the generator's output and piping secrets straight to `gh`/`op`.
- The GitHub secret `TAURI_SIGNING_PRIVATE_KEY` is only visible to Actions
  runners; it is masked in all logs.
- The public key in `tauri.conf.json` is not a secret — it is safe (and required)
  to commit.
