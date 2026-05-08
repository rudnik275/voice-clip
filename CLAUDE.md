
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

---

# Project: voice-clip

Self-hosted PWA on macOS that turns voice recordings into clipboard text. Phone records → Mac transcribes via OpenAI `gpt-4o-transcribe` → text lands in both clipboards. Originally a Telegram bot; that path is gone.

## File map

```
src/
  config.ts          env config; required: OPENAI_API_KEY; optional: PORT, TLS_*, DATA_DIR
  index.ts           entry: starts server, handles SIGINT/SIGTERM
  server.ts          Bun.serve with TLS; wires stores; routes /, /sw.js, /cost, /history*, /upload
  storage.ts         createAudioStorage(dataDir) → saveAudio + daily cleanup of data/recordings/
  history-store.ts   createHistoryStore(dataDir) → CRUD on data/history.json
  cost-store.ts      createCostStore(dataDir) → cumulative spend in data/cost.json
  pricing.ts         calcCostUsd(usage) per OpenAI gpt-4o-transcribe rates
  transcribe.ts      wraps OpenAI audio.transcriptions.create with multi-lang prompt
  macos.ts           pbcopy via Bun.spawn

web/
  index.html         PWA entry; topbar (history btn + total pill), main (record button, result), modal
  app.ts             recording, IndexedDB queue, drain, history rendering, SW registration
  style.css          design tokens + components
  sw.js              service worker — cache-first for shell, passthrough for API
  tsconfig.json      adds DOM lib (separate from server's tsconfig)

scripts/setup-cert.sh  one-time mkcert helper

certs/   gitignored: cert.pem, key.pem, rootCA.pem (publish rootCA.pem to other devices)
data/    gitignored: recordings/ (auto-cleaned), history.json, cost.json, .last-cleanup

tests/   bun test suite — pricing, history-store, cost-store, storage cleanup
```

## Storage and lifecycle

| Path                    | Lifetime                                              | Role                                                              |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `data/recordings/*.m4a` | Lazy daily purge of non-today files on first /upload  | Debug-only audio dump. **Don't reference from app logic.**        |
| `data/history.json`     | **Forever**                                           | Source of truth: every transcription with id/text/cost/source/readAt |
| `data/cost.json`        | **Forever** (survives history.clear)                  | Cumulative spend (totalUsd / totalRequests / since)               |
| `data/.last-cleanup`    | Until next day                                        | One line: YYYY-MM-DD of last recordings cleanup                   |

History.json + cost.json are canonical. Audio is debug-only.

## Stores: factory pattern

All three stores — `createHistoryStore(dataDir)`, `createCostStore(dataDir)`, `createAudioStorage(dataDir)` — take dataDir as a parameter. **Don't read `config.dataDir` directly inside stores or storage code.** Server wires `config.dataDir` at startup; tests pass a temp dir. This is the testability contract — keep it.

History- and cost-store both serialize their write paths through a single Promise-chain mutex so concurrent uploads from multiple devices (e.g. phone + tablet draining offline queues at the same time) can't lose items via load → mutate → save races.

## Server: dependency injection

`startServer(deps)` accepts an optional `ServerDeps` object: `history`, `costs`, `audio`, `transcribe`, `copyToClipboard`, `port`, `certPath`, `keyPath`, `useTls`. Production (`src/index.ts`) calls it with no args — sensible defaults wire real stores, real OpenAI, real `pbcopy`. Tests pass mocks: stub `transcribe` returning canned `{text, usage}`, stub `copyToClipboard` capturing calls, real stores backed by a temp dir. Use `useTls: false` and `port: 0` for in-process integration tests on an ephemeral HTTP port.

## Offline protocol

Recording always tries `/upload` immediately. On fetch failure the audio blob lands in IndexedDB (DB `voice-clip`, store `queue`, key `localId`). Drain triggers:

1. App load
2. After every successful online upload
3. `online` window event
4. Periodic 60s retry while items remain in queue

Drained items POST `/upload` with `source=offline`. Server contract:

- `source=online` → pbcopy + history insert
- `source=offline` → history insert ONLY (don't override the user's current Mac clipboard with stale audio)

Clients send `recordedAt` ISO timestamp on every upload — used to sort history by actual recording time, not sync time. Server records both `ts` (server-side processing time) and the client's `recordedAt`.

`web/sw.js` caches the app shell so the PWA loads even when the Mac is unreachable. `/upload`, `/cost`, `/history*` always pass through to the network — the SW never speculates on API responses. After deploying changes that affect the SW, hard-refresh the PWA so the new SW activates.

## Design tokens (style.css `:root`)

- Backgrounds: `--bg-0` (#07070b), `--bg-1` (#0c0c14)
- Text: `--fg` (#f1f1f7), `--muted` (#8b8b9c)
- Glass: `--glass-bg` (white at 0.045), `--glass-border` (white at 0.10), strong borders 0.18
- Idle accent gradient: `--accent-a` #7383ff → `--accent-b` #b15eff
- Recording state: `--rec-a` #ff5577 → `--rec-b` #ff7a4f
- `--shadow-deep` for floating elements

Typography: SF Pro Display / system stack, letter-spacing `-0.01em` for body, `0.04em–0.10em` for small/uppercase labels, `font-variant-numeric: tabular-nums` for time/money/count.

## Visual conventions — don't drift

- **Liquid Glass surfaces** (top bar pills, modal sheet, history items, copy button): `backdrop-filter: blur(20–40px) saturate(180%)` + `var(--glass-bg)` + `1px solid var(--glass-border)`. Use this for any new surface — don't introduce solid panels.
- **Conic-gradient aura** belongs to the record button only (rotating, blurred 40px). Don't apply to other elements.
- **Mesh gradient ambient bg** lives once on `body::before`/`body::after`. Don't repeat it per-component.
- **Spring curves**: press `cubic-bezier(0.34, 1.4, 0.64, 1)`, modal entrance `cubic-bezier(0.16, 1, 0.3, 1)`, breathing/pulse `cubic-bezier(0.4, 0, 0.6, 1)`.
- **Voice reactivity** (recording state): JS sets `--voice-level` on `#rec` plus an 8-corner asymmetric `border-radius` ("blob"). Smoothing alpha **0.16** (~95ms time constant). Don't change the alpha without a reason — too low feels dead, too high jittery.
- **`hidden` attribute pitfall**: any element with `display: flex|grid|block` in author CSS will defeat the HTML `hidden` attribute. There is a global `[hidden] { display: none !important }` rule at the top of `style.css` covering this — leave it in place. New surfaces should rely on the `hidden` attribute (so JS toggles via `el.hidden = true/false`), not on CSS classes.

## Adding things

**New endpoint:** add to `routes` in server.ts. Use `Response.json(...)`. Multi-method routes use `{ GET, POST }` shape. If it's an API path, list it in `isApiPath` inside `web/sw.js` so the SW passes through.

**New persistent state:** new `createXxxStore(dataDir)` factory in `src/`. File at `data/<name>.json`. Read-load-save pattern (no streaming — small data). Add tests in `tests/`.

**New UI element:** HTML in `web/index.html`, style with existing tokens, surface = Liquid Glass, animations = one of the spring curves above. Wire in `web/app.ts`.

**New language preferences:** the language hint lives in `LANGUAGE_PROMPT` in `src/transcribe.ts` (ru/uk/en + "keep English terms verbatim" + "never Belarusian"). User-specific — see memory `feedback_transcription_languages.md`.

## Testing

- `bun test` runs everything in `tests/`. Tests use temp dirs; no mocks needed for stores.
- **Unit tests** (history-store, cost-store, pricing, storage cleanup) — pure factory + temp dir.
- **Integration tests** (`tests/upload-flow.test.ts`) — spin up `startServer` on an ephemeral HTTP port (`port: 0, useTls: false`) with stubbed `transcribe` and `copyToClipboard`, then drive it via `fetch()`. Covers online auto-read + offline-stays-unread + clipboard-only-on-online + multi-device parallel drain.
- `bun run typecheck` runs both server-side (`tsc --noEmit`) and web-side (`tsc --noEmit -p web`) — they have separate tsconfigs because web needs DOM lib.

## Deployment / lifecycle

PM2 process is named `voice-clip`. After server-side changes: `pm2 restart voice-clip`.

**PWA update propagation:** the page periodically calls `registration.update()` (every 30 min, plus on `online` and `visibilitychange`). When a new SW takes control (`controllerchange` fires after the first install), the page auto-reloads — so the tablet picks up new builds without manual close+reopen.

**Important — cache busting:** when you ship changes to `web/` assets (HTML, bundled JS/CSS, but NOT `sw.js` itself), the SW byte-content doesn't change and the browser won't trigger an update cycle. **Bump `CACHE` in `web/sw.js`** (e.g. `voice-clip-v3` → `voice-clip-v4`) so the SW changes byte-wise, the activate handler clears the previous cache, and clients reload to fetch fresh.

**Version visibility:** the version string (`v7`, `v8`, …) is shown to the user in three places — bottom-right corner of the live UI (`#version-tag`), inside the `#boot-fallback` panel, and on `/offline`. There's also a plain-text `/version` endpoint. When bumping the SW cache, update **all four** spots: `web/sw.js` (`CACHE = 'voice-clip-vN'`), `web/index.html` (`#version-tag` and the `.version` span in `#boot-fallback`), `web/offline.html` (the `.version` span), and `src/server.ts` (the `/version` route response). A test in `tests/pwa-shell.test.ts` enforces that they all match.

