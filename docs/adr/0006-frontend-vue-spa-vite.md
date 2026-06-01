# ADR 0006 — Frontend rewritten as a Vue 3 SPA built with Vite

Status: **Accepted** · 2026-05-31

## Context

The frontend was a single hand-written `web/app.ts` (~63 KB of imperative DOM
code) plus `web/home.html`, transpiled by `Bun.build` at server boot and
served as an ES module (see ADR 0001 and the "Frontend" section of
`CLAUDE.md`). The project's standing rules explicitly said: don't use Vite,
build the frontend with `Bun.build` / HTML imports, keep the frontend free of
`node_modules` dependencies, and version assets by hashing the bundle at boot.

Two pressures broke that arrangement:

1. **`app.ts` became unmaintainable.** All state, the recording engine, the
   history/profile/preset UI, the network layer, and observability lived in
   one file with no module boundaries. It was risky to touch.

2. **The recording engine needs to be testable in isolation.** There is a
   real, unresolved bug — after the app is backgrounded and foregrounded on a
   phone, the *next* recording is broken — and the audio capture logic was too
   entangled with the DOM to reproduce or test the failure deliberately.

The owner decided to rewrite the frontend from scratch on the standard Vue
community stack (latest versions), keeping only the visual layer (`style.css`,
animations, button layout, voice-reactive halo) byte-for-byte, and to rebuild
audio capture as an explicit, testable finite-state machine. The backend and
API contract stay unchanged.

## Decision

### Stack

The frontend is a **Vue 3 SPA built with Vite** (Vue 3.5 + Pinia 3 + Vite 8 +
`@vitejs/plugin-vue` 6). This **overrides** the `CLAUDE.md` rules that forbade
Vite, mandated `Bun.build`/HTML-imports, and required a `node_modules`-free
frontend. The community-standard toolchain was chosen deliberately over the
bespoke `Bun.build` setup for maintainability and ecosystem fit.

- **No `vue-router`** — the app is a single screen; modals (History, Profile)
  are driven by reactive state, not routes. Router will be added when a second
  screen appears.
- **No service worker** during the rewrite — manual SW caching was the biggest
  source of debugging friction (stale bundles, the "bump `CACHE` in 4 places"
  ritual) and would interfere with diagnosing the capture bug in the browser.
  The PWA **manifest is kept** so the app still installs to the home screen in
  standalone mode. A service worker will return as a separate task.

### Build & serving

`vite build` emits `web/dist/` with content-hashed assets; Vite handles asset
versioning, replacing the boot-time `Bun.build(app.ts)` + manual `ASSET_VER`
hashing. The Bun server serves `dist/` statically and `index.html` at `/`. The
Dockerfile gains a `vite build` stage.

### Audio capture architecture

Capture is rebuilt as a framework-agnostic `RecorderMachine` (FSM) behind
ports/adapters: an `AudioAdapter` port (sole implementation `BrowserAudioAdapter`
holding all iOS-specific quirks) and an `Uploader` port. Background/foreground
are modelled as **events**, not states. The eight hard-won iOS invariants
(fresh `getUserMedia` per recording, `autoGainControl: false`, pause via
`track.enabled`, mime via `isTypeSupported`, `start(250)` timeslice, closing
`AudioContext` at idle, `primeAudioSession()` before resume, finalize with an
`onstop`/timeout race) are preserved and locked down with unit tests against a
fake adapter.

### Explicitly preserved

The visual layer is carried over 1:1 — `style.css`, the Neo-Brutalism tokens
(ADR 0002), mechanical press, and the voice-reactive halo (`--voice-level`,
smoothing alpha 0.16). SFC templates reproduce the same markup and class names
to guarantee pixel parity. The backend, DB, and API contract are unchanged.

## Consequences

- `CLAUDE.md` (Bun.build frontend, Vite ban, no-`node_modules` rule, the
  4-place version/SW dance) is now outdated and must be updated to match.
- `tests/pwa-shell.test.ts` (which enforced the version string across four
  places) must be rewritten or removed.
- The preset mode is dropped from the rewrite scope (tracked in #98); full PRD
  for the rewrite is #99.
