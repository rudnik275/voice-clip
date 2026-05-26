# Desktop auto-updater — one-time owner setup

Voice Clip's macOS app uses Tauri's built-in Ed25519 updater. The CI workflow
(`.github/workflows/tauri-release.yml`) builds a universal `.dmg` + `.app.tar.gz`,
signs the update manifest with your private key, publishes them to GitHub
Releases, **and mirrors all three artifacts to the VPS** at
`/opt/voice-clip/data/desktop/`. The server serves `GET /desktop/update.json`,
`GET /desktop/voice-clip.app.tar.gz`, and `GET /desktop/voice-clip.dmg`
directly from that directory — so the desktop updater keeps working when the
repo is private and GitHub Releases would require auth. If a file is missing
on the VPS (e.g. fresh deploy before the next `desktop-v*` tag), the routes
fall back to a 302 against GitHub Releases.

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
- Builds a universal `.dmg` + `.app.tar.gz` (`aarch64` + `x86_64` via `lipo`).
- Signs the `latest.json` updater manifest with your Ed25519 key.
- Creates a GitHub Release named `Voice Clip desktop-v0.2.0` with the assets
  (also attaches stable-named copies `voice-clip.dmg` + `voice-clip.app.tar.gz`).
- **Rewrites `latest.json`** so `platforms.*.url` points at
  `https://voice.rudifamily.uk/desktop/voice-clip.app.tar.gz` instead of GitHub
  (signature stays valid — it's over the tarball bytes, not the JSON).
- **Mirrors `voice-clip.dmg`, `voice-clip.app.tar.gz`, and the rewritten
  `latest.json` to the VPS** at `/opt/voice-clip/data/desktop/` (staged into
  `incoming/` then renamed atomically so an in-flight `/desktop/update.json`
  request never reads a half-uploaded file).

Required GitHub Actions secrets for the mirror step: `SSH_HOST`, `SSH_USER`,
`SSH_PRIVATE_KEY` — same secrets used by `server-deploy.yml`. No extra setup.

---

## How updates reach users

1. The Tauri app polls (or the user clicks **Check for Updates** in the tray menu).
2. Tauri fetches `https://voice.rudifamily.uk/desktop/update.json`.
3. The server reads `latest.json` straight from
   `/data/desktop/latest.json` (mounted from the VPS host).
4. Tauri verifies the Ed25519 signature in `latest.json` against the pubkey in
   `tauri.conf.json`. The `platforms.*.url` points at
   `https://voice.rudifamily.uk/desktop/voice-clip.app.tar.gz`, which the
   server also serves from disk.
5. Tauri unpacks the tarball over the installed `.app` bundle. The app
   relaunches into the new version automatically (native macOS update dialog
   shown because `"dialog": true` in `tauri.conf.json`).

Both the manifest route and the tarball route fall back to a 302 against
GitHub Releases if the on-disk file is missing — so the updater keeps
working through the brief cutover window between merging a server change
and re-cutting the next `desktop-v*` tag that populates the VPS mirror.

---

## Secret discipline

- The private key (1Password document `tauri-signing-key`) and its passphrase
  must never enter git, chat, or AI context. The setup script enforces this by
  suppressing the generator's output and piping secrets straight to `gh`/`op`.
- The GitHub secret `TAURI_SIGNING_PRIVATE_KEY` is only visible to Actions
  runners; it is masked in all logs.
- The public key in `tauri.conf.json` is not a secret — it is safe (and required)
  to commit.
