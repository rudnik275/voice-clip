
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

Multi-user PWA-server that turns voice recordings into clipboard text. Phones record → server transcribes via OpenAI `gpt-4o-transcribe` → text lands in the user's per-Mac clipboard via an opt-in daemon. Originally a single-user Mac-local Telegram bot; both paths are gone.

> **⚠ This file is largely v1-era and out-of-date as of 2026-05.** The "File map", "Storage and lifecycle", "Stores: factory pattern", "Auth model", and "Server: dependency injection" sections below describe the JSON-store / Synology NAS / invite-name-signup architecture that has been replaced. **Reality today:**
>
> - **Storage:** single SQLite file at `data/voice-clip.sqlite`. Tables: `users`, `sessions`, `history`, `costs`, `devices`, `pending_deliveries`, `errors`, `allowed_emails`, `invites`, `user_plans`, `usage_counters`. Source of truth: [`src/db.ts`](src/db.ts).
> - **Stores:** `users-store`, `sessions-store`, `history-store`, `cost-store`, `devices-store`, `pending-deliveries-store`, `errors-store`, `failed-audio-store`, `allowed-emails-store`, `invites-store`, `plans-store`. All in `src/`, all `(db, now?)` factories.
> - **Deploy target:** Hetzner VPS `46.62.229.131` (`deploy` user), `https://voice.rudifamily.uk` via Cloudflare Tunnel. NOT a Synology NAS anymore. CI-push deploys on every merge to `master` (`.github/workflows/server-deploy.yml`).
> - **Auth:** Google OAuth + DB-backed allowlist + invite links. `VOICE_CLIP_ALLOWED_EMAILS` seeds the table on boot; new users join via `/invite/:token` consumed atomically in the OAuth callback. `OWNER_EMAIL` marks the owner (sees admin UI). `ADMIN_TOKEN` is an alt admin path for ops scripts.
> - **Pricing scaffold:** three tiers in `user_plans` — **Free** (30 clips/mo), **Pro** ($3/mo · 50 clips/mo · 5-min/clip cap), **Unlimited** (owner-comp, no caps, no per-clip cap). Stripe not wired yet — promote by `UPDATE user_plans SET plan='pro'|'unlimited' …`. Sizing math + tier rationale in [`docs/adr/0004-pro-tier-pricing.md`](docs/adr/0004-pro-tier-pricing.md); original scaffold in [`docs/adr/0003-monetization-scaffold.md`](docs/adr/0003-monetization-scaffold.md).
> - **Operations:** [`docs/runbook/operations.md`](docs/runbook/operations.md) covers invites, quota override, observability, cost queries.
> - **Routes added** since this doc was written: `/api/errors`, `/admin/errors`, `/admin/errors/:id/replay`, `/admin/invites`, `/invite/:token`, `/pro`, `/icons/*`.
>
> When in doubt, **trust `src/db.ts` + `src/server.ts`** over what this doc says.

Two deployment modes:
- **Local Mac dev** (mkcert + pm2 + `https://Mac-mini-Rudnik.local:8443`) — for hacking on the code.
- ~~**Synology NAS via Tailscale Funnel + Docker**~~ → **Hetzner VPS via Cloudflare Tunnel + Docker**. Production, public HTTPS, multi-user, CI-deployed on merge to `master`.

## File map

```
src/
  config.ts                 env config; required: OPENAI_API_KEY; optional: PORT, TLS_*, DATA_DIR,
                            USE_TLS, ADMIN_TOKEN, PUBLIC_URL
  index.ts                  entry: starts server, handles SIGINT/SIGTERM
  server.ts                 Bun.serve; routes (auth, signup, history, upload, /events SSE,
                            /install/voice-clip-daemon); per-user store cache
  storage.ts                createAudioStorage(dataDir) → saveAudio + daily cleanup of data/recordings/
                            (still GLOBAL — debug-only audio dump, not user-isolated)
  history-store.ts          createHistoryStore(dataDir) — JSON + write-mutex; server passes
                            data/users/<userId>/ to scope per user
  cost-store.ts             createCostStore(dataDir) — same pattern. TWO instances per request:
                            per-user (data/users/<userId>/cost.json) and aggregate (data/cost.json).
                            Aggregate is what the UI total-pill shows.
  users-store.ts            createUsersStore(dataDir) → data/users.json
  invites-store.ts          createInvitesStore(dataDir) → data/invites.json (single-use atomic consume)
  sessions-store.ts         createSessionsStore(dataDir) → data/sessions.json (HttpOnly cookie tokens)
  pending-clips-store.ts    per-user; data/users/<id>/pending-clips.json — clips queued for daemon
                            replay when it reconnects, ack'd via /events/ack
  live-bus.ts               in-memory pub/sub for SSE delivery to currently-connected daemons
  auth.ts                   parseSessionCookie, setSessionCookieHeader, resolveSession,
                            unauthorized/forbidden helpers
  pricing.ts                calcCostUsd(usage) per OpenAI gpt-4o-transcribe rates
  transcribe.ts             wraps OpenAI audio.transcriptions.create with multi-lang prompt
  macos.ts                  pbcopy via Bun.spawn — used in legacy local-Mac path; in NAS deploy
                            this is a no-op since the container has no pbcopy

web/
  home.html                 PWA entry (authed shell). Topbar (history btn + user pill),
                            main (record button), history modal, profile modal
  app.ts                    /me check on load (401 → /login redirect), recording,
                            history rendering, SW registration, profile menu (sign out,
                            paired devices, UI sounds toggle)
  sounds.ts                 Web Audio synth module — 8 UI sounds (start/stop/pause/resume,
                            success bell, error buzzer, copy pop, modal swoosh).
                            No .wav/.mp3 assets. Mute toggle persisted in localStorage.
  login.html                self-contained sign-in page (Google OAuth entry)
  access-denied.html        self-contained "no access" page (daemon download w/o valid token)
  style.css                 design tokens + components (Neo-Brutalism: cream + red + violet,
                            thick black borders, hard offset shadows, mechanical press).
                            See docs/adr/0002-neo-brutalism-design-system.md
  sw.js                     service worker — cache-first for shell, passthrough for API
  manifest.webmanifest      PWA manifest (icon set, theme color, display mode)
  tsconfig.json             adds DOM lib (separate from server's tsconfig)

daemon/
  index.ts                  Bun runtime that holds /events SSE → pbcopy → /events/ack loop
  install.sh.tmpl           bash installer template (server inlines URL/TOKEN, embeds source)
  com.voiceclip.daemon.plist.tmpl   launchd plist template

scripts/
  setup-cert.sh             one-time mkcert helper (local dev only)
  with-secrets.sh           AI-safe `op run` wrapper (copy of slots/scripts/with-secrets.sh)
  setup-ssh-key.sh          one-time: ssh-keygen + sshpass ssh-copy-id (via with-secrets.sh)
  setup-tailscale-funnel.sh ssh into NAS, configure tailscale serve+funnel, print public URL
  deploy.sh                 rsync + scp .env + docker compose up -d on NAS

Dockerfile                  multi-stage Bun image (alpine), HEALTHCHECK against /version
docker-compose.yml          single `voice-clip` service, 127.0.0.1:8080 loopback, ./data:/data

certs/   gitignored: cert.pem, key.pem, rootCA.pem (local dev only)
data/    gitignored: per-user history/cost/recordings/pending-clips, plus root-level
         users.json, invites.json, sessions.json, cost.json (aggregate)

tests/   bun test suite — pricing, all stores, storage cleanup, auth, daemon-delivery, upload-flow
```

## Storage and lifecycle (per-user)

| Path                                          | Lifetime                                              | Role                                                              |
| --------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `data/recordings/*.m4a`                       | Lazy daily purge of non-today files on first /upload  | GLOBAL debug-only audio dump. Not user-isolated. **Don't reference from app logic.** |
| `data/users.json`                             | **Forever**                                           | Array of `{id, name, createdAt, daemonToken}` |
| `data/invites.json`                           | **Forever**                                           | Single-use invite tokens (consumed atomically) |
| `data/sessions.json`                          | **Forever** (no idle expiry; explicit /logout deletes) | Cookie tokens → userId |
| `data/users/<userId>/history.json`            | **Forever**                                           | Per-user transcription log (canonical) |
| `data/users/<userId>/cost.json`               | **Forever**                                           | Per-user cumulative spend |
| `data/users/<userId>/pending-clips.json`      | Until ack'd by daemon                                 | Server-side queue of clips not yet pbcopy'd |
| `data/cost.json`                              | **Forever** (survives history.clear)                  | AGGREGATE spend across ALL users — what the UI total-pill shows |
| `data/.last-cleanup`                          | Until next day                                        | YYYY-MM-DD of last recordings cleanup                   |

`history.json` + per-user `cost.json` + aggregate `cost.json` are canonical. Audio is debug-only.

## Stores: factory pattern (unchanged)

`createHistoryStore(dataDir)`, `createCostStore(dataDir)`, `createAudioStorage(dataDir)`, `createUsersStore(dataDir)`, `createInvitesStore(dataDir)`, `createSessionsStore(dataDir)`, `createPendingClipsStore(dataDir, userId)` — all take a dataDir parameter. **Don't read `config.dataDir` directly inside stores or storage code.** Server wires `config.dataDir` at startup; tests pass a temp dir.

For per-user history/cost stores, server.ts passes `path.join(dataDir, 'users', userId)` as the dataDir — the store doesn't know it's user-scoped. **Important:** server.ts caches per-user store instances in a `Map<userId, Store>` so the write-mutex Promise chain inside each store is shared across requests for the same user; without the cache, concurrent uploads would race.

All write-mutating store ops are serialized through a single Promise-chain mutex.

## Auth model

- Invite-link signup. Owner generates one-time token via `POST /admin/invites` (gated by `X-Admin-Token` header == `ADMIN_TOKEN` env). Invitee opens `https://<server>/signup/<token>`, enters name, gets a session cookie, redirected to `/`.
- Session = HttpOnly cookie (`session=<32-hex>`), Secure flag matches `useTls`, no idle expiry. `POST /logout` deletes the row in `sessions.json`.
- All API routes (`/upload`, `/history*`, `/cost`, `/me`) require a session via `resolveSession()`. Daemon-only routes (`/events`, `/events/ack`, `/install/voice-clip-daemon`) auth via the user's `daemonToken` (URL or `X-Daemon-Token` header).

## Server: dependency injection

`startServer(deps)` accepts an optional `ServerDeps` object: `dataDir`, `users`, `invites`, `sessions`, `audio`, `aggregateCosts`, `liveBus`, `transcribe`, `copyToClipboard`, `port`, `certPath`, `keyPath`, `useTls`, `adminToken`, `publicUrl`. Production (`src/index.ts`) calls it with no args. Tests pass `dataDir: tempDir` plus optional store instances + stub `transcribe` / `copyToClipboard`. Use `useTls: false` and `port: 0` for in-process integration tests on an ephemeral HTTP port.

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

See [docs/adr/0002-neo-brutalism-design-system.md](docs/adr/0002-neo-brutalism-design-system.md) for the full rationale.

- Background: `--bg` (#FFFDF5 cream), `--white` (#FFFFFF) for cards
- Text: `--fg` (#09090B rich black, not pure black), `--muted` (#5A5A6E)
- Accents: `--red` (#FF6B6B primary CTA), `--violet` (#B5A8FF), `--yellow` (#FFD93D),
  `--green` (#A7E8BD), `--orange` (#FFB088), `--pink` (#FFB8D9)
- Borders: `--border` (3px solid var(--fg)), `--border-strong` (5px solid var(--fg))
- Shadows (hard offset, no blur): `--shadow-sm` (4px), `--shadow-md` (6px), `--shadow-lg` (12px)
- Animation: `--press` (100ms linear), `--spring` (cubic-bezier(0.34, 1.4, 0.64, 1))

Typography: **Space Grotesk** (Google Fonts, weights 500/600/700) for everything. Body `letter-spacing: -0.005em`, uppercase labels `0.10em–0.16em`, numbers `font-variant-numeric: tabular-nums`.

## Visual conventions — don't drift

- **Thick black borders + hard offset shadows** on every interactive surface (top bar pills, modals, history items, buttons): use `var(--border)` + one of the `--shadow-{sm,md,lg}` tokens. **No `backdrop-filter`, no blur, no glass.**
- **Mechanical press** on every clickable element: on `:active` translate `(N, N)px` matching the shadow offset and drop the shadow to `0`. No scale, no spring physics. See `#rec`, `.topbar-btn`, `.user-pill`, `.ghost-btn` for the pattern.
- **Slight rotation** on identity elements: history btn `-2°`, user pill `+1.5°`, REC sticker `+14°`. Don't over-apply — only on "sticker"-like elements that earn the playful tilt.
- **Voice reactivity** (recording state): JS sets `--voice-level` on `#rec` (0..1), CSS drives 4 properties — scale (+7%), tilt (-1.2°), yellow halo ring (0→22px), framed black outline (4px thicker than halo). Smoothing alpha **0.16** in JS (~95ms time constant). Don't change the alpha without a reason.
- **Dot-grid texture** lives once on `body::before` (24px grid, low-opacity black, mask-faded toward edges). Don't repeat per-component.
- **Spring curves** (for non-press motion): modal entrance `cubic-bezier(0.16, 1, 0.3, 1)`, busy bounce `cubic-bezier(0.4, 0, 0.6, 1)`.
- **`hidden` attribute pitfall**: any element with `display: flex|grid|block` in author CSS will defeat the HTML `hidden` attribute. There is a global `[hidden] { display: none !important }` rule at the top of `style.css` covering this — leave it in place. New surfaces should rely on the `hidden` attribute (so JS toggles via `el.hidden = true/false`), not on CSS classes.
- **UI sounds**: every interactive moment that warrants audio feedback should call the matching function from `web/sounds.ts` (e.g. `playStartRec()`, `playSuccess()`, `playError()`). Respects the user's mute toggle via `localStorage`. Don't load external audio assets — extend `sounds.ts` with new synth functions instead.

## Adding things

**New endpoint:** add to `routes` in server.ts. Use `Response.json(...)`. Multi-method routes use `{ GET, POST }` shape. If it's an API path, list it in `isApiPath` inside `web/sw.js` so the SW passes through.

**New persistent state:** new `createXxxStore(dataDir)` factory in `src/`. File at `data/<name>.json`. Read-load-save pattern (no streaming — small data). Add tests in `tests/`.

**New UI element:** HTML in `web/home.html`, style with existing tokens (Neo-Brutalism: thick borders + offset shadow + mechanical press, see Visual conventions). Wire in `web/app.ts`. If the interaction warrants audio feedback, add a matching synth function in `web/sounds.ts` and call it from `app.ts`.

**New language preferences:** the language hint lives in `LANGUAGE_PROMPT` in `src/transcribe.ts` (ru/uk/en + "keep English terms verbatim" + "never Belarusian"). User-specific — see memory `feedback_transcription_languages.md`.

## Testing

- `bun test` runs everything in `tests/`. Tests use temp dirs; no mocks needed for stores.
- **Unit tests** (history-store, cost-store, pricing, storage cleanup) — pure factory + temp dir.
- **Integration tests** (`tests/upload-flow.test.ts`) — spin up `startServer` on an ephemeral HTTP port (`port: 0, useTls: false`) with stubbed `transcribe` and `copyToClipboard`, then drive it via `fetch()`. Covers online auto-read + offline-stays-unread + clipboard-only-on-online + multi-device parallel drain.
- `bun run typecheck` runs both server-side (`tsc --noEmit`) and web-side (`tsc --noEmit -p web`) — they have separate tsconfigs because web needs DOM lib.

## Deployment / lifecycle

**Production (Synology NAS):** server runs as a Docker container managed by `docker compose`. Public HTTPS via Tailscale Funnel. After code changes:

```sh
./scripts/deploy.sh
```

That rsyncs sources to the NAS, scp's the local `.env` (gitignored, AI-blocked), and runs `docker compose up -d --build`. Health-checks `/version` at the end.

`scripts/setup-ssh-key.sh` (one-time, via `./scripts/with-secrets.sh`) registers an ssh-key so deploys don't need the NAS password. After that the password can be rotated freely. `scripts/setup-tailscale-funnel.sh` is the other one-time setup that turns on the public Funnel and prints the `*.ts.net` URL — paste that into `.env` as `PUBLIC_URL`.

**Local dev (Mac):** `bun run dev` (TLS via mkcert) or `pm2 restart voice-clip` if you keep PM2 running. The Mac-local pbcopy path still works for the dev user, but the multi-user delivery story is the per-user `daemon/` SSE-stream — install on each user's Mac via the curl one-liner in the user-pill menu.

**PWA update propagation:** the page periodically calls `registration.update()` (every 30 min, plus on `online` and `visibilitychange`). When a new SW takes control (`controllerchange` fires after the first install), the page auto-reloads — so the tablet picks up new builds without manual close+reopen.

**Important — cache busting:** when you ship changes to `web/` assets (HTML, bundled JS/CSS, but NOT `sw.js` itself), the SW byte-content doesn't change and the browser won't trigger an update cycle. **Bump `CACHE` in `web/sw.js`** (e.g. `voice-clip-v3` → `voice-clip-v4`) so the SW changes byte-wise, the activate handler clears the previous cache, and clients reload to fetch fresh.

**Version visibility:** the version string (`v7`, `v8`, …) is shown to the user in three places — bottom-right corner of the live UI (`#version-tag`), inside the `#boot-fallback` panel, and on `/offline`. There's also a plain-text `/version` endpoint. When bumping the SW cache, update **all four** spots: `web/sw.js` (`CACHE = 'voice-clip-vN'`), `web/index.html` (`#version-tag` and the `.version` span in `#boot-fallback`), `web/offline.html` (the `.version` span), and `src/server.ts` (the `APP_VERSION` constant). A test in `tests/pwa-shell.test.ts` enforces that they all match.

**Litestream / DB backup + restore:** a `voice-clip-litestream` sidecar in `docker-compose.prod.yml` continuously replicates `voice-clip.sqlite` to Hetzner Object Storage (7-day WAL retention, 24h snapshots). Config is `litestream.yml` at repo root. Credentials come from four `LITESTREAM_S3_*` env vars (see `.env.example`). Full restore procedure: `docs/runbook/litestream-restore.md` — run `scripts/litestream-restore.sh` on the VPS with the app container stopped.

**macOS app auto-updater (Tauri Ed25519):** releases are triggered by a `desktop-v*` tag. The CI workflow (`.github/workflows/tauri-release.yml`) builds a universal `.dmg`, signs `latest.json` with the Ed25519 key from GH secrets, and publishes both to GitHub Releases. The Tauri app checks `https://voice.rudifamily.uk/desktop/update.json` (a thin server 302 → GitHub Releases). One-time owner setup: `docs/runbook/desktop-updater-setup.md`.

## Deployment runbook — full re-deploy from zero

If the NAS dies or you start over on a different host, this is the recipe. Every step is reversible/idempotent.

### One-time prerequisites (~10 min)

1. **On your local Mac:**
   - `brew install 1password-cli hudochenkov/sshpass/sshpass` (op CLI + sshpass for the one-time ssh-copy-id).
   - Install 1Password 8 desktop app, sign in to your account.
   - In 1Password app: **Settings → Developer → Integrate with 1Password CLI** → ON.
   - Verify: `op vault list` should trigger TouchID and print your vaults.

2. **On the Synology NAS (via DSM web UI in browser):**
   - **Control Panel → Terminal & SNMP → Enable SSH service** (port 22).
   - **Package Center → Container Manager → Install** (provides `docker` + `docker compose`).
   - **Package Center → Tailscale → Install → Sign in** to your Tailscale account. The NAS appears in your tailnet.
   - **Tailscale Admin Console** (https://login.tailscale.com/admin/machines) → click the NAS → toggle **Funnel** on for that node.
   - **Tailscale Admin → DNS → HTTPS Certificates → ON** (required for public *.ts.net DNS to be published).

3. **Required 1Password items:**
   - Vault `Personal` → item `NAS (local)` → fields `username`, `password` (CONCEALED — keep the password in the standard Password field, **not** in a custom STRING field; AI tools that filter only CONCEALED-typed fields will leak STRING fields). Note the item's UUID via `op item list --vault=Personal` — used in `.env.1password` references.

### Bootstrap a fresh deploy

```sh
# 1. Clone & populate .env
git clone <repo> voice-clip && cd voice-clip
cp .env.example .env
# Edit .env in your own terminal (not via AI):
#   OPENAI_API_KEY  - from 1Password VoiceClip/GPT_API_TOKEN or platform.openai.com
#   ADMIN_TOKEN     - openssl rand -hex 16
#   NAS_HOST        - LAN IP / Tailscale name / *.local
#   NAS_USER        - DSM admin username (default: dimka)
#   REMOTE_DIR      - /volume1/docker/voice-clip (default)
#   PUBLIC_URL      - leave EMPTY for first deploy; fill after step 4

# 2. Verify .env.1password references match your 1Password layout
#    (UUID of `NAS (local)` item — replace if you re-create the item)
cat .env.1password

# 3. One-time: register ssh-key on NAS (uses NAS_PASSWORD from 1Password)
./scripts/with-secrets.sh ./scripts/setup-ssh-key.sh

# 4. One-time: grant NOPASSWD sudo on NAS for /usr/local/bin/docker
#    AND /var/packages/Tailscale/target/bin/tailscale (uses NAS_PASSWORD once)
./scripts/with-secrets.sh ./scripts/setup-nas-docker.sh

# 5. Tailscale Funnel: turn it on, get the public URL
ssh -i ~/.ssh/voice-clip-nas dimka@<NAS_HOST> \
  'sudo -n /var/packages/Tailscale/target/bin/tailscale funnel --bg http://127.0.0.1:8080'
# Print the public URL
ssh -i ~/.ssh/voice-clip-nas dimka@<NAS_HOST> \
  'sudo -n /var/packages/Tailscale/target/bin/tailscale funnel status'
# → put the printed https://<host>.tail-XXXX.ts.net into .env as PUBLIC_URL

# 6. Deploy: rsync + scp .env + docker compose up -d --build
./scripts/deploy.sh
# Smoke: curl <PUBLIC_URL>/version → "v8" (or whatever current APP_VERSION is)

# 7. Bootstrap first user (admin self-signup):
INVITE=$(set -a; source .env; set +a; \
  curl -fsS -X POST -H "X-Admin-Token: $ADMIN_TOKEN" \
    "$PUBLIC_URL/admin/invites" | jq -r .token)
echo "Open on phone: $PUBLIC_URL/signup/$INVITE"
# - User opens link in phone Safari
# - Enters name → gets session cookie + lands at /
# - Share → "Add to Home Screen" — PWA icon ready

# 8. (Optional) Install Mac daemon — opens Cmd+V flow per-user.
# In the PWA → tap user pill (top-right) → "📎 Подключить Mac"
# This copies a `curl ... | bash` command to clipboard. Paste into Terminal
# on the user's Mac. The installer:
#   - drops daemon source into ~/.voice-clip-daemon/
#   - registers ~/Library/LaunchAgents/com.voiceclip.daemon.plist
#   - launchctl load → daemon runs at login, holds SSE stream, pbcopy's clips
```

### Adding more users later

```sh
# Generate a one-time invite (admin):
INVITE=$(set -a; source .env; set +a; \
  curl -fsS -X POST -H "X-Admin-Token: $ADMIN_TOKEN" \
    "$PUBLIC_URL/admin/invites" | jq -r .token)
echo "$PUBLIC_URL/signup/$INVITE"
# Send the URL to the new user. They sign up — own per-user history,
# isolated from yours. Aggregate cost.json reflects everyone's spend.
```

### Common gotchas (and the lines in scripts that handle them)

- **Synology sshd password fallback after publickey** → SSH_OPTS in deploy.sh include `BatchMode=yes` + `IdentitiesOnly=yes`. Without these rsync hangs on "Permission denied, please try again" even though publickey already succeeded.
- **rsync "Permission denied" but key works for `ssh exec`** → remote rsync isn't in non-interactive PATH on Synology. Pin it: `--rsync-path=/usr/bin/rsync`.
- **scp dies with "subsystem request failed on channel 0"** → DSM ships without SFTP subsystem; use legacy `scp -O`.
- **DSM admin's sudo asks for password every time** → run `./scripts/with-secrets.sh ./scripts/setup-nas-docker.sh` once. Writes a tight `/etc/sudoers.d/<user>-voice-clip-docker` entry whitelisting only the docker + tailscale binaries.
- **`docker compose up` fails with "Bind mount failed: '...data' does not exist"** → deploy.sh creates `${REMOTE_DIR}/data` ahead of build. Recreate manually with `mkdir -p` if you ever wipe the host volume.
- **Public URL is NXDOMAIN locally even though Funnel is ON** → local resolver cached the negative response from before Funnel was enabled. Auth NS still has the record (verify with `dig @<one-of-ts.net-NS> <hostname>`). It propagates within a few minutes; meanwhile use `curl --resolve <host>:443:<tailscale-anycast-IP>`.
- **Funnel command says "Funnel is not enabled on your tailnet"** → click the enable link from the error message (one-off in Tailscale Admin Console), or visit the Admin → device → Funnel toggle.
- **ContainerManager is missing on DSM 7.0/older** → upgrade DSM or use the legacy "Docker" package (path `/var/packages/Docker/target/usr/bin/docker`).
- **Cert leak via `op item get --format=json`**: NEVER use this command for items that have custom STRING fields holding secrets. Only the `CONCEALED`-typed fields are masked by jq filters; STRING fields print plaintext. Stick to `op run --env-file=...` exclusively (see Secrets section).

### Cleaning up stranded / abandoned users

Symptom: someone opened a `/signup/<token>` link in an in-app browser (Telegram, Slack, Mail) — that consumed the invite + created a user inside that webview's cookie jar, but the user can never come back to that account from a normal browser. Result: an orphaned user in `users.json` you want to remove before they sign up again under a slightly different name.

```sh
# 1. List users to find the orphan id (only id + name + createdAt — no secrets):
ssh -i ~/.ssh/voice-clip-nas dimka@<NAS_HOST> \
  'sudo -n /usr/local/bin/docker exec voice-clip cat /data/users.json' | jq '.[] | {id, name, createdAt}'

# 2. Remove by id(s) — tiny inline Bun script that touches users.json + sessions.json + the per-user data dir atomically:
cat > /tmp/cleanup.ts <<'TSEOF'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'; import { join } from 'node:path'
const DATA = '/data'; const ids = process.argv.slice(2)
const users = JSON.parse(await readFile(join(DATA, 'users.json'), 'utf8'))
const sessions = JSON.parse(await readFile(join(DATA, 'sessions.json'), 'utf8'))
await writeFile(join(DATA, 'users.json'), JSON.stringify(users.filter((u: any) => !ids.includes(u.id)), null, 2))
await writeFile(join(DATA, 'sessions.json'), JSON.stringify(sessions.filter((s: any) => !ids.includes(s.userId)), null, 2))
for (const id of ids) { const d = join(DATA, 'users', id); if (existsSync(d)) await rm(d, { recursive: true, force: true }) }
console.log('done')
TSEOF
scp -i ~/.ssh/voice-clip-nas /tmp/cleanup.ts dimka@<NAS_HOST>:/tmp/
ssh -i ~/.ssh/voice-clip-nas dimka@<NAS_HOST> \
  'sudo -n /usr/local/bin/docker cp /tmp/cleanup.ts voice-clip:/tmp/cleanup.ts && \
   sudo -n /usr/local/bin/docker exec voice-clip bun /tmp/cleanup.ts <ORPHAN_ID> [<ORPHAN_ID>...]'
```

Tip when sending the invite: ask the recipient to *long-press the link* and pick "Open in Safari" / "Open in Chrome" — Telegram's in-app browser is the most common source of this orphan-user bug, and it also blocks "Add to Home Screen" anyway.

### Disaster recovery — start over on the same NAS

```sh
# Stop + remove container; keep data:
ssh -i ~/.ssh/voice-clip-nas dimka@<NAS_HOST> \
  'cd /volume1/docker/voice-clip && sudo -n /usr/local/bin/docker compose down'

# Wipe state (users, history, cost — IRREVERSIBLE):
ssh -i ~/.ssh/voice-clip-nas dimka@<NAS_HOST> \
  'sudo -n /usr/local/bin/docker run --rm -v /volume1/docker/voice-clip/data:/data alpine sh -c "rm -rf /data/users /data/recordings /data/users.json /data/invites.json /data/sessions.json /data/cost.json /data/.last-cleanup; echo \"[]\" > /data/users.json; echo \"[]\" > /data/invites.json; echo \"[]\" > /data/sessions.json"'

# Re-deploy:
./scripts/deploy.sh
```

### Migrate existing data into a fresh user (when someone signs up after a re-deploy)

`scripts/migrate-existing-data.sh` is a one-shot for when you have legacy `data/history.json` + `data/cost.json` on your Mac that you want under a freshly-signed-up user. It's brittle around multi-user merges (so we ended up wiping for the first deploy), but the right starting shape if you ever need it.

## Secrets

**App secrets** (`OPENAI_API_KEY`, `ADMIN_TOKEN`) live in plain `.env` (gitignored, AI-blocked by the global `Read .env*` rule). User fills `.env` by hand from `.env.example`.

**NAS connection** is the only thing that flows through 1Password — `op://Personal/<NAS-uuid>/{username,password}` references in `.env.1password`, resolved at run-time by `./scripts/with-secrets.sh` (a `op run` wrapper that masks values in stdout/stderr). NAS password is used **once** during `setup-ssh-key.sh`; afterwards everything is ssh-key-based.

**AI rules:**
- Never `op read`, `op item get`, `op inject`, or any command that prints secret values to stdout.
- Never `cat .env` / `Read .env`.
- Always go through `./scripts/with-secrets.sh ./scripts/<X>.sh` for anything that needs `NAS_PASSWORD`.
- For 1Password items with special chars in the title (parens/spaces), use the item's UUID in the `op://` reference instead of the title — the URI syntax doesn't allow them.

