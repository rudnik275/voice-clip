# Voice Clip — macOS desktop app (Tauri)

Native macOS clipboard receiver. Pairs to a voice-clip account via Google
OAuth in the default browser, holds a long-lived SSE connection to the
server's `/events`, and `pbcopy`s every transcribed clip into the Mac
clipboard.

## Architecture

```
desktop/
  src-tauri/
    Cargo.toml              Rust crate manifest (tauri, reqwest, keyring, ...)
    tauri.conf.json         bundle id, voiceclip:// URL scheme, updater
    build.rs                tauri-build codegen
    src/
      main.rs               app bootstrap, deep-link plumbing, state machine
      keychain.rs           macOS Keychain device-token storage (via `keyring`)
      sse.rs                reqwest SSE client + exponential backoff reconnect
      clipboard.rs          pbcopy via std::process::Command
  src/
    index.html              webview UI (plain HTML/JS — NO TypeScript)
    app.js                  view state machine (Signed out / Signed in)
    style.css               minimal styling
```

## Pairing handshake (server contract — see issue #4)

1. App generates a one-time `state`, opens the default browser at
   `<PUBLIC_URL>/desktop/auth/start?state=<state>`.
2. User completes Google OAuth in the browser.
3. Server `302`s to `voiceclip://callback?token=<device_token>&state=<state>`.
4. macOS routes the `voiceclip://` URL to this app (registered URL scheme).
5. App validates `state` matches the one it generated, stores `token` in the
   macOS Keychain (`service = "com.voiceclip.desktop"`, `account = "device_token"`),
   transitions to "Signed in".

## Live delivery

- Connect: `GET <PUBLIC_URL>/events?device_token=<token>` (SSE).
- On each `data: {json}` frame → `pbcopy` the `text`, then
  `POST <PUBLIC_URL>/events/ack` with `{ "seq": <n> }` and the
  `X-Device-Token` header.
- Reconnect with exponential backoff: 1s → 30s cap, full jitter.

## Build & run (manual — macOS only)

Requires the Rust toolchain + Tauri CLI:

```sh
cargo install tauri-cli --version "^2"
cd desktop/src-tauri
PUBLIC_URL=https://<your-server> cargo tauri dev      # dev run
PUBLIC_URL=https://<your-server> cargo tauri build    # produces .dmg
```

The server's `/download/latest` route 302s to the GitHub Releases asset
`voice-clip.dmg`; upload the `cargo tauri build` output there.

## Distribution / Gatekeeper

This app ships **unsigned** (Ed25519 update signing only, no Apple
notarization). First launch: right-click the app → **Open** → confirm the
Gatekeeper prompt once. Subsequent launches open normally.

## What is NOT in the automated CI gate

The Rust app cannot be built/signed/smoke-tested in the agent sandbox.
The following require a manual macOS verification pass:

- `cargo build` / `cargo tauri build` compiles cleanly
- `voiceclip://` URL scheme is registered and routes to the running app
- device token persists in and reads back from the macOS Keychain
- SSE stream stays connected; reconnect backoff works after a network drop
- `pbcopy` writes the clip text to the system clipboard
- right-click → Open clears Gatekeeper on first install
