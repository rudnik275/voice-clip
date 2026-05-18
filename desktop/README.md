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

## Verified on macOS (Apple Silicon, Tauri 2.11)

- `cargo check` / `cargo tauri build` compile clean (0 warnings); `.app`
  bundles with the correct Info.plist (voiceclip:// scheme, `LSUIElement`
  menubar-only, identifier, version) and an embedded `icon.icns`
- App launches without crashing; `voiceclip://` is registered with
  LaunchServices and bound to `com.voiceclip.desktop`
- `cargo test` — 7/7 pass (URL/CSRF parser, backoff bounds, clip JSON)
- `Cargo.lock` is committed → reproducible CI release builds

## Still needs an interactive macOS pass (Phase 3, with the owner)

Inherently can't be automated — done when the owner installs the first
signed build and pairs:

- Google OAuth round-trip → `voiceclip://callback` deep link delivered
- device token persists in / reads back from the macOS Keychain (first
  write prompts for Keychain access on an unsigned binary)
- SSE stays connected to prod; reconnect backoff after a real network drop
- end-to-end: phone records → server fan-out → `pbcopy` on this Mac
- right-click → Open clears Gatekeeper on a *downloaded* (quarantined) DMG

> The local `.dmg` step (`bundle_dmg.sh`) fails on a fresh Mac due to the
> well-known Finder/AppleScript automation requirement — cosmetic only.
> CI's `tauri-action` on the GitHub macOS runner produces the real signed
> universal `.dmg`, so this does not affect releases.
