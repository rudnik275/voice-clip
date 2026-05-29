// Bun server — foundation slice (v2 #2).
//
// Route map:
//   GET  /version              → plain text APP_VERSION
//   GET  /                     → home.html (authed) | login.html (anon)
//   GET  /style.css            → static asset
//   GET  /manifest.webmanifest → static asset
//   GET  /auth/google/start    → 302 to Google + set oauth_state cookie
//   GET  /auth/google/callback → token-exchange + session cookie + 302 /
//   POST /logout               → delete session row + clear cookie
//   GET  /me                   → 200 { user } | 401
//
// The route table is intentionally minimal — slice #3 adds /upload + history.

import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { openDb, type DB } from './db'
import { createUsersStore, type UsersStore } from './users-store'
import { createSessionsStore, type SessionsStore } from './sessions-store'
import { createHistoryStore, type HistoryStore } from './history-store'
import { createCostStore, type CostStore } from './cost-store'
import { createDevicesStore, type DevicesStore } from './devices-store'
import { createErrorsStore, type ErrorsStore } from './errors-store'
import { createFailedAudioStore } from './failed-audio-store'
import { createAllowedEmailsStore, type AllowedEmailsStore } from './allowed-emails-store'
import { createInvitesStore, type InvitesStore } from './invites-store'
import { createPlansStore, monthKeyOf, type PlansStore } from './plans-store'
import {
  createPendingDeliveriesStore,
  type PendingDeliveriesStore,
} from './pending-deliveries-store'
import { createLiveBus, type LiveBus } from './live-bus'
import type { TranscriptionResult } from './transcribe'
import { calcCostUsd } from './pricing'
import { createGoogleOAuth, type GoogleFetcher, type GoogleOAuth } from './google-oauth'
import {
  buildClearInviteCookie,
  buildClearSessionCookie,
  buildClearStateCookie,
  buildInviteCookie,
  buildSessionCookie,
  buildStateCookie,
  parseInviteCookie,
  parseStateCookie,
  resolveUserFromRequest,
  resolveUserOrDevice,
  resolveDeviceFromRequest,
  unauthorized,
} from './auth-middleware'
import { APP_VERSION } from './version'

export interface ServerDeps {
  dataDir: string
  port?: number
  useTls?: boolean
  certPath?: string
  keyPath?: string
  // Auth / OAuth
  // Comma-separated env list of emails. Seeded into the DB allowed_emails
  // table on boot (idempotent) so existing logins keep working; new emails
  // get added at invite-consume time and never come back through here.
  allowlist?: readonly string[]
  // When set, this email's session counts as 'owner' — surfaces an extra
  // bit on /me so the UI can show owner-only affordances (generate invite
  // link). Otherwise the same actions are reachable via X-Admin-Token.
  ownerEmail?: string
  googleFetcher?: GoogleFetcher
  googleClientId?: string
  googleClientSecret?: string
  publicUrl?: string
  // Optional shared-secret gate for /admin/* (X-Admin-Token header).
  adminToken?: string
  // Test seams
  users?: UsersStore
  sessions?: SessionsStore
  history?: HistoryStore
  costs?: CostStore
  devices?: DevicesStore
  pendingDeliveries?: PendingDeliveriesStore
  errors?: ErrorsStore
  allowedEmails?: AllowedEmailsStore
  invites?: InvitesStore
  plans?: PlansStore
  // Override the free-tier monthly clip cap. Default 30. 0 = disable the
  // gate entirely (useful for tests + early ops).
  freeTierMonthlyLimit?: number
  // Pro tier monthly clip cap. Default 50 — chosen so that even if every
  // clip hits the 5-min/5MB ceiling we keep ≥50% margin on a $3 charge
  // after Stripe fees. 0 = disable (paid users effectively unlimited).
  proTierMonthlyLimit?: number
  // Hard byte ceiling on a single /upload. Default 5 MB ≈ 5 min of iPhone
  // mp4/AAC at ~128 kbps. The 'unlimited' plan bypasses this cap.
  maxAudioBytes?: number
  liveBus?: LiveBus
  transcribe?: (input: Uint8Array, filename: string) => Promise<TranscriptionResult>
  db?: DB
  now?: () => number
}

// Fallback GitHub Releases URLs for the desktop artifacts. In normal
// operation the tauri-release CI mirrors all three to the VPS under
// ${dataDir}/desktop/, and the server below serves them straight off disk
// — so the desktop updater keeps working when the repo is private and GH
// Releases require auth. The fallback 302 stays for the brief window after
// the first deploy of this change, before the next desktop-v* tag.
//
// Note: Tauri's updater downloads the .app.tar.gz (verifies its Ed25519
// signature, extracts in place); the .dmg is only for the first install
// from the PWA "Download Mac app" button.
const LATEST_DMG_URL =
  'https://github.com/rudnik275/voice-clip/releases/latest/download/voice-clip.dmg'
const LATEST_APP_TARBALL_URL =
  'https://github.com/rudnik275/voice-clip/releases/latest/download/voice-clip.app.tar.gz'
const LATEST_UPDATE_MANIFEST_URL =
  'https://github.com/rudnik275/voice-clip/releases/latest/download/latest.json'

export interface RunningServer {
  port: number
  stop(): void
}

const WEB_DIR = new URL('../web/', import.meta.url).pathname


async function readWebFile(name: string): Promise<string> {
  return readFile(join(WEB_DIR, name), 'utf8')
}

function htmlResponse(html: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // HTML carries the versioned asset URLs — it must never be cached
      // (by the browser or Cloudflare) or it would pin an old ?v=hash.
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export async function startServer(deps: ServerDeps): Promise<RunningServer> {
  const useTls = deps.useTls ?? false
  // Cookies must carry the `Secure` flag whenever the BROWSER-facing scheme
  // is https — regardless of whether Bun itself is using TLS. In prod the
  // Cloudflare Tunnel terminates TLS at the edge and forwards plain HTTP
  // to Bun (useTls=false), but the public URL is https — so cookies need
  // Secure. In local dev publicUrl is http://localhost so we omit Secure
  // (browsers reject Secure cookies over plain HTTP).
  const cookieSecure = deps.publicUrl
    ? new URL(deps.publicUrl).protocol === 'https:'
    : useTls
  // owner-email is normalised so the equality check in /me + admin gate is
  // not surprising about whitespace / case.
  const ownerEmail = deps.ownerEmail?.trim().toLowerCase() ?? null

  const db = deps.db ?? openDb(join(deps.dataDir, 'voice-clip.sqlite'))
  const users = deps.users ?? createUsersStore(db, deps.now)
  const sessions = deps.sessions ?? createSessionsStore(db, deps.now)
  const history = deps.history ?? createHistoryStore(db, deps.now)
  const costs = deps.costs ?? createCostStore(db)
  const devices = deps.devices ?? createDevicesStore(db, deps.now)
  const pendingDeliveries =
    deps.pendingDeliveries ?? createPendingDeliveriesStore(db, deps.now)
  const errors = deps.errors ?? createErrorsStore(db, deps.now)
  const failedAudio = createFailedAudioStore(deps.dataDir)

  const allowedEmails =
    deps.allowedEmails ?? createAllowedEmailsStore(db, deps.now)
  // Seed env emails into the DB (idempotent via INSERT OR IGNORE) so
  // existing deploys don't lock anyone out at boot.
  if (deps.allowlist && deps.allowlist.length > 0) {
    allowedEmails.seed(deps.allowlist)
  }
  // The configured owner email is implicitly always on the allowlist —
  // otherwise the owner could lock themselves out by misconfiguring the
  // env seed list.
  if (ownerEmail) allowedEmails.add(ownerEmail, 'env')

  const invites = deps.invites ?? createInvitesStore(db, deps.now)
  const plans = deps.plans ?? createPlansStore(db, deps.now)
  const FREE_TIER_LIMIT = deps.freeTierMonthlyLimit ?? 30
  const PRO_TIER_LIMIT = deps.proTierMonthlyLimit ?? 50
  const MAX_AUDIO_BYTES = deps.maxAudioBytes ?? 5 * 1024 * 1024

  function limitFor(plan: 'free' | 'pro' | 'unlimited'): number | null {
    if (plan === 'unlimited') return null
    if (plan === 'pro') return PRO_TIER_LIMIT > 0 ? PRO_TIER_LIMIT : null
    return FREE_TIER_LIMIT > 0 ? FREE_TIER_LIMIT : null
  }
  const liveBus = deps.liveBus ?? createLiveBus()

  // Simple per-IP rate limit for /api/errors. The endpoint is unauthed so
  // it can catch pre-login crashes; in exchange we cap a single IP at 60
  // reports per rolling minute (generous — real crashes don't loop fast).
  const ERROR_RATE_LIMIT = 60
  const ERROR_RATE_WINDOW_MS = 60_000
  const errorRateBuckets = new Map<string, { count: number; resetAt: number }>()

  // Two ways to reach /admin/*:
  //   - X-Admin-Token header matches deps.adminToken (env-driven ops scripts)
  //   - logged-in user's email == ownerEmail (UI button in profile modal)
  // The session path is gentler — no extra secret to remember.
  function isAdminRequest(req: Request): boolean {
    if (deps.adminToken && req.headers.get('x-admin-token') === deps.adminToken) return true
    const authed = resolveUserFromRequest(req, sessions, users)
    if (authed && ownerEmail && authed.user.email.toLowerCase() === ownerEmail) return true
    return false
  }

  function clientIp(req: Request): string {
    // Cloudflare Tunnel preserves the real client IP in CF-Connecting-IP.
    return (
      req.headers.get('cf-connecting-ip') ||
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      'unknown'
    )
  }

  function rateLimitErrorReport(ip: string): boolean {
    const now = (deps.now ?? Date.now)()
    const bucket = errorRateBuckets.get(ip)
    if (!bucket || bucket.resetAt < now) {
      errorRateBuckets.set(ip, { count: 1, resetAt: now + ERROR_RATE_WINDOW_MS })
      return true
    }
    if (bucket.count >= ERROR_RATE_LIMIT) return false
    bucket.count += 1
    return true
  }
  // The real transcriber pulls in `./config` (which fail-fasts on missing
  // OPENAI_API_KEY) and the OpenAI client. Load it lazily and ONLY when no
  // stub is injected, so store/auth/integration tests that pass a stub never
  // trip the config fail-fast just by importing the server.
  let realTranscribe: ServerDeps['transcribe'] | undefined
  const transcribe: NonNullable<ServerDeps['transcribe']> = async (bytes, name) => {
    if (deps.transcribe) return deps.transcribe(bytes, name)
    if (!realTranscribe) {
      realTranscribe = (await import('./transcribe')).transcribeAudio
    }
    return realTranscribe(bytes, name)
  }

  // Google OAuth is optional in tests that don't exercise it — but for /auth
  // routes we need clientId+secret. If unset, those routes return 503.
  const oauthReady =
    Boolean(deps.googleClientId) && Boolean(deps.googleClientSecret) && Boolean(deps.publicUrl)
  const oauth: GoogleOAuth | null = oauthReady
    ? createGoogleOAuth({
        clientId: deps.googleClientId!,
        clientSecret: deps.googleClientSecret!,
        fetcher: deps.googleFetcher,
        now: deps.now,
      })
    : null
  const publicBase = oauthReady ? deps.publicUrl!.replace(/\/$/, '') : ''
  const redirectUri = oauthReady ? `${publicBase}/auth/google/callback` : ''
  const desktopRedirectUri = oauthReady ? `${publicBase}/desktop/auth/complete` : ''

  // ----- prebuilt static pages -----
  const loginTplRaw = (await readWebFile('login.html')).replace('__APP_VERSION__', APP_VERSION)
  const accessDeniedTplRaw = await readWebFile('access-denied.html')
  const proHtml = await readWebFile('pro.html')
  const homeTplRaw = await readWebFile('home.html')
  const styleCss = await readWebFile('style.css')
  const manifestRaw = await readWebFile('manifest.webmanifest')
  const swJsRaw = await readWebFile('sw.js')

  // PWA icons. Read at boot so the route handlers can hand back Buffer
  // bytes directly — small files, no need for streaming. Filenames are
  // enumerated explicitly so we never serve arbitrary paths from /icons/.
  const ICONS: Record<string, { bytes: Buffer; mime: string }> = {}
  for (const [name, mime] of [
    ['icon-192.png', 'image/png'],
    ['icon-512.png', 'image/png'],
    ['apple-touch-icon.png', 'image/png'],
    ['favicon-32.png', 'image/png'],
    ['voice-clip-mark.svg', 'image/svg+xml'],
  ] as const) {
    ICONS[name] = {
      bytes: await readFile(join(WEB_DIR, 'icons', name)),
      mime,
    }
  }

  // Bundle + transpile the browser entrypoint once at boot. Bun strips TS
  // types and produces an ES module the browser can load directly via
  // <script type="module" src="/app.ts">.
  const appBuild = await Bun.build({
    entrypoints: [join(WEB_DIR, 'app.ts')],
    target: 'browser',
    minify: true,
  })
  const appJs = appBuild.success ? await appBuild.outputs[0]!.text() : ''
  if (!appBuild.success) {
    // Surface build failures loudly — a broken bundle means a dead PWA.
    console.error('web/app.ts build failed:', appBuild.logs)
  }

  // Versioned asset URLs = a content hash that covers every byte the SW
  // precaches: CSS, JS bundle, SW file itself, plus APP_VERSION (which
  // gets stamped into the HTML at render time). Any change → new hash →
  // new asset URLs AND new SW byte content → standard SW update flow
  // installs the new version, which activates the next time all PWA
  // clients close (= next foreground on iOS). HTML is served `no-store`
  // so a deploy is never blocked by a stale Cloudflare/edge HTML cache;
  // CSS and JS are `immutable` because their URL changes per hash.
  const verHash = createHash('sha1')
    .update(styleCss)
    .update(appJs)
    .update(swJsRaw)
    .update(APP_VERSION)
  for (const name of Object.keys(ICONS).sort()) verHash.update(ICONS[name]!.bytes)
  const ASSET_VER = verHash.digest('hex').slice(0, 10)
  const withAssetVer = (html: string): string =>
    html
      .replaceAll('/style.css"', `/style.css?v=${ASSET_VER}"`)
      .replaceAll('/app.ts"', `/app.ts?v=${ASSET_VER}"`)
      // Icon URLs in HTML <link> tags and inside the manifest JSON.
      .replaceAll('/icons/icon-192.png"', `/icons/icon-192.png?v=${ASSET_VER}"`)
      .replaceAll('/icons/icon-512.png"', `/icons/icon-512.png?v=${ASSET_VER}"`)
      .replaceAll('/icons/apple-touch-icon.png"', `/icons/apple-touch-icon.png?v=${ASSET_VER}"`)
      .replaceAll('/icons/favicon-32.png"', `/icons/favicon-32.png?v=${ASSET_VER}"`)
      .replaceAll('/icons/voice-clip-mark.svg"', `/icons/voice-clip-mark.svg?v=${ASSET_VER}"`)

  const loginHtml = withAssetVer(loginTplRaw)
  const homeHtmlStatic = withAssetVer(homeTplRaw).replace('__APP_VERSION__', APP_VERSION)
  const accessDeniedTpl = withAssetVer(accessDeniedTplRaw)
  const manifestJson = withAssetVer(manifestRaw)
  const swJs = swJsRaw.replaceAll('__ASSET_VER__', ASSET_VER)

  function renderAccessDenied(email: string): string {
    return accessDeniedTpl
      .replace('__EMAIL__', escapeHtml(email))
      .replace('__APP_VERSION__', APP_VERSION)
  }

  // Serves a desktop-release artifact from ${dataDir}/desktop/<name>. When the
  // file isn't present yet (fresh deploy before any desktop-v* tag re-runs
  // the release CI to populate the mirror) we 302 to the legacy GH Releases
  // URL — keeps the updater alive during the cutover, harmless once the
  // mirror is populated. cache-control: no-store because the URL is stable
  // (voice-clip.dmg / latest.json) but its content changes per release.
  async function serveDesktopArtifact(
    name: string,
    contentType: string,
    fallbackUrl: string,
  ): Promise<Response> {
    const file = Bun.file(join(deps.dataDir, 'desktop', name))
    if (await file.exists()) {
      return new Response(file, {
        status: 200,
        headers: { 'content-type': contentType, 'cache-control': 'no-store' },
      })
    }
    return new Response(null, { status: 302, headers: { location: fallbackUrl } })
  }

  const server = Bun.serve({
    port: deps.port ?? 8080,
    development: false,
    // SSE (/events) holds a long-lived, mostly-idle stream. Bun's default
    // idleTimeout is 10s, which silently closes the idle connection — the
    // origin then EOFs the cloudflared tunnel, the desktop client reconnects,
    // and the cycle repeats every ~13s (10s idle + backoff), spamming
    // `unexpected EOF` in the tunnel logs. Raise it well past the SSE
    // heartbeat interval (see /events) so an idle-but-alive stream is never
    // reaped. 255s is Bun's maximum.
    idleTimeout: 255,
    tls: useTls
      ? {
          cert: Bun.file(deps.certPath ?? './certs/cert.pem'),
          key: Bun.file(deps.keyPath ?? './certs/key.pem'),
        }
      : undefined,
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url)
      const pathname = url.pathname
      const method = req.method

      // ---- CORS (Tauri webview cross-origin) ----
      // The Tauri macOS app runs its bundled PWA at `tauri://localhost`,
      // so every fetch to this server is cross-origin. Requests carrying
      // `X-Device-Token` trip CORS preflight; without an opt-in here the
      // browser-side fetch fails before the request is sent.
      //
      // Allow only Tauri schemes (no `Allow-Credentials` since Tauri
      // doesn't send cookies anyway — the device_token header is the
      // entire auth). The PWA running same-origin doesn't preflight, so
      // its requests skip this block entirely.
      const origin = req.headers.get('origin')
      const isTauriOrigin =
        origin !== null &&
        (origin === 'tauri://localhost' ||
          origin === 'http://tauri.localhost' ||
          origin.startsWith('tauri://'))

      if (method === 'OPTIONS' && isTauriOrigin) {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': origin!,
            // PWA fetches pass `credentials: 'include'`, which Tauri's
            // webview honours — the browser then requires Allow-Credentials
            // on the preflight even though Tauri's cookie jar is empty for
            // voice.rudifamily.uk. Without this header the request is
            // blocked before X-Device-Token ever reaches the server.
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers':
              req.headers.get('access-control-request-headers') ??
              'Content-Type, X-Device-Token, X-Admin-Token',
            'Access-Control-Max-Age': '600',
            Vary: 'Origin',
          },
        })
      }

      // Wrap the rest of the handler so we can stamp the Allow-Origin
      // header onto every response when the request came from Tauri.
      const baseResponse = await handleRouted(req, url, pathname, method)
      if (isTauriOrigin) {
        baseResponse.headers.set('Access-Control-Allow-Origin', origin!)
        baseResponse.headers.set('Access-Control-Allow-Credentials', 'true')
        baseResponse.headers.append('Vary', 'Origin')
      }
      return baseResponse
    },
  })

  async function handleRouted(
    req: Request,
    url: URL,
    pathname: string,
    method: string,
  ): Promise<Response> {
      // ---- static / version ----
      if (method === 'GET' && pathname === '/version') {
        return new Response(APP_VERSION, {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      }
      if (method === 'GET' && pathname === '/style.css') {
        return new Response(styleCss, {
          status: 200,
          headers: {
            'content-type': 'text/css; charset=utf-8',
            // URL is content-versioned (?v=hash) → safe to cache forever.
            'cache-control': 'public, max-age=31536000, immutable',
          },
        })
      }
      if (method === 'GET' && pathname === '/manifest.webmanifest') {
        return new Response(manifestJson, {
          status: 200,
          headers: { 'content-type': 'application/manifest+json; charset=utf-8' },
        })
      }
      // Icon route: explicit allowlist by filename — never reads arbitrary
      // paths from disk. The bytes are loaded at boot; URLs are versioned
      // with ?v=hash so a redesign rolls cleanly without phones holding
      // a stale icon in their home-screen cache.
      if (method === 'GET' && pathname.startsWith('/icons/')) {
        const name = pathname.slice('/icons/'.length)
        const icon = ICONS[name]
        if (icon) {
          return new Response(icon.bytes, {
            status: 200,
            headers: {
              'content-type': icon.mime,
              'cache-control': 'public, max-age=31536000, immutable',
            },
          })
        }
      }
      if (method === 'GET' && pathname === '/app.ts') {
        return new Response(appJs, {
          status: 200,
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            // URL is content-versioned (?v=hash) → safe to cache forever.
            'cache-control': 'public, max-age=31536000, immutable',
          },
        })
      }
      // The service worker MUST be served from the site root (its scope
      // is `/`) and the browser re-fetches it on every navigation to
      // detect updates. We serve it with `no-cache` so the browser
      // always re-validates; the bytes themselves change whenever
      // ASSET_VER changes, triggering the standard install/activate
      // lifecycle. See docs/adr/0001-pwa-boot-architecture.md.
      if (method === 'GET' && pathname === '/sw.js') {
        return new Response(swJs, {
          status: 200,
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-cache',
            'service-worker-allowed': '/',
          },
        })
      }

      // ---- /api/errors ---- (client error reporting, no auth)
      if (pathname === '/api/errors') {
        if (method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
        if (!rateLimitErrorReport(clientIp(req))) {
          return Response.json({ error: 'rate limited' }, { status: 429 })
        }
        let payload: Record<string, unknown>
        try {
          payload = (await req.json()) as Record<string, unknown>
        } catch {
          return Response.json({ error: 'invalid json' }, { status: 400 })
        }
        if (typeof payload.type !== 'string' || typeof payload.message !== 'string') {
          return Response.json({ error: 'type + message required' }, { status: 400 })
        }
        // Hard caps on the payload — we don't want a runaway stack trace
        // ballooning the DB row.
        const trim = (s: unknown, max: number): string | null =>
          typeof s === 'string' ? s.slice(0, max) : null
        const authed = resolveUserFromRequest(req, sessions, users)
        errors.insert({
          type: payload.type.slice(0, 64),
          message: payload.message.slice(0, 2_000),
          stack: trim(payload.stack, 16_000),
          context: payload.context && typeof payload.context === 'object'
            ? (payload.context as Record<string, unknown>)
            : null,
          user_id: authed?.user.id ?? null,
        })
        return Response.json({ ok: true })
      }

      // ---- /admin/errors ---- (admin-token gated read)
      if (pathname === '/admin/errors') {
        if (!isAdminRequest(req)) return new Response('Unauthorized', { status: 401 })
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        const includeResolved = url.searchParams.get('all') === '1'
        const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 200))
        const rows = errors.list({ limit, includeResolved })
        // Join the user name for at-a-glance triage.
        const out = rows.map((e) => {
          const u = e.user_id ? users.findById(e.user_id) : null
          return {
            id: e.id,
            ts: e.ts,
            type: e.type,
            message: e.message,
            stack: e.stack,
            context: e.context ? JSON.parse(e.context) : null,
            userId: e.user_id,
            userName: u?.name ?? null,
            audioFile: e.audio_file,
            canReplay: Boolean(e.audio_file),
            resolved: Boolean(e.resolved),
          }
        })
        return Response.json(out)
      }

      // ---- /admin/errors/:id/replay ---- (re-run transcription on saved blob)
      const replayMatch = pathname.match(/^\/admin\/errors\/([^/]+)\/replay$/)
      if (replayMatch) {
        if (!isAdminRequest(req)) return new Response('Unauthorized', { status: 401 })
        if (method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
        const errId = replayMatch[1]!
        const row = errors.get(errId)
        if (!row) return Response.json({ error: 'not found' }, { status: 404 })
        if (!row.audio_file) {
          return Response.json({ error: 'no audio retained for this error' }, { status: 400 })
        }
        let bytes: Uint8Array
        try {
          bytes = failedAudio.read(row.audio_file)
        } catch (e) {
          return Response.json(
            { error: `audio missing on disk: ${(e as Error).message}` },
            { status: 410 },
          )
        }
        const filename = row.audio_file.split('/').pop() || 'clip.bin'
        try {
          const result = await transcribe(bytes, filename)
          errors.markResolved(errId)
          return Response.json({
            ok: true,
            text: result.text,
            usage: result.usage ?? null,
          })
        } catch (e) {
          return Response.json(
            { ok: false, error: (e as Error).message },
            { status: 502 },
          )
        }
      }

      // ---- /me ----
      if (pathname === '/me') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        const authed = resolveUserOrDevice(req, sessions, users, devices)
        if (!authed) return unauthorized()
        const u = authed.user
        const plan = plans.getPlan(u.id)
        const usage = plans.getUsage(u.id, monthKeyOf((deps.now ?? Date.now)()))
        const limit = limitFor(plan)
        return Response.json({
          id: u.id,
          email: u.email,
          name: u.name,
          picture_url: u.picture_url,
          // is_owner = "may create invite links / see admin affordances".
          // The owner check is loose on purpose: if OWNER_EMAIL is unset,
          // no one is owner (UI hides the button; admin token still works
          // server-side for ops scripts).
          is_owner: ownerEmail !== null && u.email.toLowerCase() === ownerEmail,
          plan,
          usage: {
            clips_this_month: usage,
            // null = unlimited (no cap on this plan). The client paints
            // the quota chip off whichever value is set; we no longer
            // ship the irrelevant other limit so the UI can't confuse
            // "5 / 50" for a Pro user with the Free 30 limit.
            monthly_limit: limit,
            // Legacy alias — kept until web/ + macos clients are updated
            // to read monthly_limit. Tracks the FREE limit specifically.
            free_monthly_limit: FREE_TIER_LIMIT > 0 ? FREE_TIER_LIMIT : null,
          },
        })
      }

      // ---- /logout ----
      if (pathname === '/logout') {
        if (method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
        const authed = resolveUserFromRequest(req, sessions, users)
        if (authed) sessions.delete(authed.session.token)
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': buildClearSessionCookie({ secure: cookieSecure }),
          },
        })
      }

      // ---- /upload ----
      if (pathname === '/upload') {
        if (method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
        const authed = resolveUserOrDevice(req, sessions, users, devices)
        if (!authed) return unauthorized()

        // Quota gate. Check BEFORE reading the body so a capped user
        // doesn't burn bandwidth / blob memory. 'unlimited' bypasses
        // entirely; 'pro' is capped by PRO_TIER_LIMIT, 'free' by
        // FREE_TIER_LIMIT (either == 0 disables that tier's gate).
        const month = monthKeyOf((deps.now ?? Date.now)())
        const userPlan = plans.getPlan(authed.user.id)
        const userLimit = limitFor(userPlan)
        if (userLimit !== null) {
          const used = plans.getUsage(authed.user.id, month)
          if (used >= userLimit) {
            return Response.json(
              {
                error:
                  userPlan === 'pro'
                    ? 'pro tier monthly limit reached'
                    : 'free tier monthly limit reached',
                code: 'quota_exceeded',
                plan: userPlan,
                used,
                limit: userLimit,
              },
              { status: 402 },
            )
          }
        }

        let form: Awaited<ReturnType<Request['formData']>>
        try {
          form = await req.formData()
        } catch {
          return Response.json({ error: 'expected multipart/form-data' }, { status: 400 })
        }
        const audio = form.get('audio')
        if (!(audio instanceof Blob)) {
          return Response.json({ error: 'missing audio field' }, { status: 400 })
        }
        const recordedAtRaw = form.get('recordedAt')
        const recordedAt =
          typeof recordedAtRaw === 'string' && recordedAtRaw.length > 0
            ? recordedAtRaw
            : new Date().toISOString()
        const sourceRaw = form.get('source')
        const source = sourceRaw === 'offline' ? 'offline' : 'online'

        const bytes = new Uint8Array(await audio.arrayBuffer())
        const filename = (audio as File).name || 'clip.webm'

        // Per-clip duration ceiling — gpt-4o-transcribe charges by audio
        // tokens, so an unbounded clip blows the Pro $3/mo unit economics
        // wide open. 5 MB ≈ 5 min of iPhone mp4/AAC. 'unlimited' opts out
        // (owner-comp tier). The client also auto-stops at the matching
        // MAX_RECORD_MS so well-behaved phones never hit this.
        if (
          userPlan !== 'unlimited' &&
          MAX_AUDIO_BYTES > 0 &&
          bytes.length > MAX_AUDIO_BYTES
        ) {
          return Response.json(
            {
              error: 'clip too long — keep recordings under 5 minutes',
              code: 'clip_too_long',
              bytes: bytes.length,
              limit: MAX_AUDIO_BYTES,
            },
            { status: 413 },
          )
        }

        let result: TranscriptionResult
        try {
          result = await transcribe(bytes, filename)
        } catch (e) {
          const msg = (e as Error).message
          console.error(
            `[upload] transcription failed user=${authed.user.id} file=${filename} ` +
              `type=${(audio as Blob).type || '?'} bytes=${bytes.length} src=${source}: ${msg}`,
          )
          // Stash the raw audio so /admin/errors/:id/replay can re-run the
          // transcription later. Pull the extension off the original filename
          // (clip.webm → webm) so we don't lose mime info that OpenAI needs.
          const extension = filename.includes('.') ? filename.split('.').pop()! : 'bin'
          const errId = `e_${randomBytes(12).toString('hex')}`
          let audioFile: string | null = null
          try {
            audioFile = failedAudio.save({
              userId: authed.user.id,
              errorId: errId,
              bytes,
              extension,
            })
          } catch (saveErr) {
            console.error(`[upload] failed to retain audio: ${(saveErr as Error).message}`)
          }
          errors.insert({
            type: 'transcription_error',
            message: msg,
            user_id: authed.user.id,
            audio_file: audioFile,
            context: {
              filename,
              mime: (audio as Blob).type || null,
              bytes: bytes.length,
              source,
              recordedAt,
            },
          })
          return Response.json(
            { error: `transcription failed: ${msg}` },
            { status: 502 },
          )
        }
        console.log(
          `[upload] ok user=${authed.user.id} file=${filename} ` +
            `type=${(audio as Blob).type || '?'} bytes=${bytes.length} src=${source} chars=${result.text.length}`,
        )

        const costUsd = result.usage ? calcCostUsd(result.usage) : 0
        const clip = history.append({
          userId: authed.user.id,
          text: result.text,
          recordedAt,
          source,
          costUsd,
        })
        if (costUsd > 0) costs.add(authed.user.id, costUsd)
        // Bump the monthly clip counter for the quota gate. Increment AFTER
        // transcription succeeded — failed uploads (audio too short, etc.)
        // shouldn't count toward the limit.
        plans.incrementUsage(authed.user.id, month)

        // Fan-out: push the clip to every paired Mac for this user. A Mac
        // with a live SSE stream gets it instantly; one that is offline gets
        // a pending_deliveries row so it replays the clip on its next
        // /events connect (publish() returns false when there is no live
        // subscriber).
        const clipPayload = {
          seq: clip.seq,
          text: clip.text,
          recordedAt: clip.recordedAt,
          source: clip.source,
          costUsd,
        }
        for (const d of devices.list(authed.user.id)) {
          const live = liveBus.publish(d.id, clipPayload)
          if (!live) pendingDeliveries.enqueue(d.id, clip.seq)
        }

        return Response.json({
          text: clip.text,
          seq: clip.seq,
          recordedAt: clip.recordedAt,
          cost: costUsd,
        })
      }

      // ---- /history ----
      if (pathname === '/history') {
        const authed = resolveUserOrDevice(req, sessions, users, devices)
        if (!authed) return unauthorized()

        if (method === 'GET') {
          const sinceRaw = url.searchParams.get('since')
          const limitRaw = url.searchParams.get('limit')
          const since = sinceRaw !== null ? Number(sinceRaw) : undefined
          const limit = limitRaw !== null ? Number(limitRaw) : undefined
          const page = history.list(authed.user.id, {
            since: since !== undefined && Number.isFinite(since) ? since : undefined,
            limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
          })
          return Response.json(page)
        }
        if (method === 'DELETE') {
          history.clear(authed.user.id)
          return Response.json({ ok: true })
        }
        return new Response('Method Not Allowed', { status: 405 })
      }

      // ---- /cost ----
      if (pathname === '/cost') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        const authed = resolveUserOrDevice(req, sessions, users, devices)
        if (!authed) return unauthorized()
        return Response.json({
          user: costs.userTotal(authed.user.id),
          aggregate: costs.aggregateTotal(),
        })
      }

      // ---- /clip/copy (session auth) ----
      // Re-send a past clip from the history modal to the user's paired Macs.
      // The PWA-local navigator.clipboard write only reaches the tablet doing
      // the tapping; this route runs the SAME fan-out as /upload so the text
      // actually lands on the Mac. Body: { seq }. Returns { ok, devices } —
      // `devices` is how many Macs got it (0 → tell the user to pair one).
      if (pathname === '/clip/copy') {
        if (method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
        const authed = resolveUserFromRequest(req, sessions, users)
        if (!authed) return unauthorized()

        let parsed: unknown
        try {
          parsed = await req.json()
        } catch {
          return Response.json({ error: 'expected JSON body' }, { status: 400 })
        }
        const seq =
          parsed && typeof parsed === 'object' && typeof (parsed as { seq?: unknown }).seq === 'number'
            ? (parsed as { seq: number }).seq
            : undefined
        if (seq === undefined) {
          return Response.json({ error: 'missing seq' }, { status: 400 })
        }
        const clip = history.getBySeq(authed.user.id, seq)
        if (!clip) {
          return Response.json({ error: 'not found' }, { status: 404 })
        }

        // Same fan-out shape as /upload. `source: 'online'` because this is
        // an explicit user action — the Mac should pbcopy it unconditionally,
        // never treat it like a stale offline replay.
        const clipPayload = {
          seq: clip.seq,
          text: clip.text,
          recordedAt: clip.recordedAt,
          source: 'online',
          costUsd: clip.costUsd,
        }
        const macs = devices.list(authed.user.id)
        for (const d of macs) {
          const live = liveBus.publish(d.id, clipPayload)
          if (!live) pendingDeliveries.enqueue(d.id, clip.seq)
        }
        return Response.json({ ok: true, devices: macs.length })
      }

      // ---- /devices (session auth) ----
      // The PWA profile modal lists the user's paired Macs. `label` is the
      // device_name the Tauri app reported at pairing (may be null).
      if (pathname === '/devices') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        const authed = resolveUserOrDevice(req, sessions, users, devices)
        if (!authed) return unauthorized()
        return Response.json(
          devices.list(authed.user.id).map((d) => ({
            id: d.id,
            label: d.device_name,
            created_at: d.created_at,
            last_seen_at: d.last_seen_at,
          })),
        )
      }

      // ---- /devices/:id (session auth) ----
      // Revoke a paired Mac. The ownership gate returns an IDENTICAL 404 for
      // "no such device" and "not your device" — never leak whether an id
      // exists for another user. revoke() deletes the device row, which
      // FK-cascades its pending_deliveries (devices.pending FK ON DELETE
      // CASCADE — see db.ts), so no explicit pending cleanup is needed.
      // disconnect() then aborts any live SSE stream so the revoked Tauri
      // app re-auths (and its now-dead token gets a 401).
      if (pathname.startsWith('/devices/')) {
        if (method !== 'DELETE') return new Response('Method Not Allowed', { status: 405 })
        const authed = resolveUserFromRequest(req, sessions, users)
        if (!authed) return unauthorized()
        const id = pathname.slice('/devices/'.length)
        const d = devices.findById(id)
        if (!d || d.user_id !== authed.user.id) {
          return new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
        }
        devices.revoke(id)
        liveBus.disconnect(id)
        return Response.json({ ok: true })
      }

      // ---- /admin/invites ---- (owner OR X-Admin-Token)
      if (pathname === '/admin/invites') {
        if (!isAdminRequest(req)) return new Response('Unauthorized', { status: 401 })
        if (method === 'POST') {
          const sessionAuth = resolveUserFromRequest(req, sessions, users)
          const createdBy = sessionAuth?.user.id ?? null
          const invite = invites.create(createdBy)
          const baseUrl = publicBase || `${url.protocol}//${url.host}`
          return Response.json({
            token: invite.token,
            url: `${baseUrl}/invite/${invite.token}`,
          })
        }
        if (method === 'GET') {
          const sessionAuth = resolveUserFromRequest(req, sessions, users)
          // When called over a session, scope to the calling user's invites
          // (an owner only sees their own); over admin token return nothing
          // useful since we don't track ownership beyond the creator id.
          const userId = sessionAuth?.user.id
          const rows = userId ? invites.listByCreator(userId) : []
          return Response.json(
            rows.map((r) => ({
              token: r.token,
              createdAt: r.created_at,
              used: r.used_at !== null,
              usedAt: r.used_at,
              usedByEmail: r.used_by_email,
            })),
          )
        }
        return new Response('Method Not Allowed', { status: 405 })
      }

      // ---- /invite/:token ---- (public, sets invite cookie + 302 OAuth)
      const inviteMatch = pathname.match(/^\/invite\/([0-9a-f]{8,128})$/)
      if (inviteMatch) {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        const token = inviteMatch[1]!
        const invite = invites.get(token)
        if (!invite || invite.used_at !== null) {
          // Render the access-denied page with a friendly message — using
          // the same brutalism shell so the user doesn't fall onto a
          // different visual context.
          return new Response(
            renderAccessDenied('this invite link has expired'),
            {
              status: 410,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        }
        // Set the invite cookie, then kick off the standard OAuth dance.
        // /auth/google/start sets its own oauth_state cookie on top.
        const h = new Headers({ location: '/auth/google/start' })
        h.append('set-cookie', buildInviteCookie(token, { secure: cookieSecure }))
        return new Response(null, { status: 302, headers: h })
      }

      // ---- /auth/google/start ----
      if (pathname === '/auth/google/start') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        if (!oauth) return new Response('OAuth not configured', { status: 503 })
        const state = randomBytes(16).toString('hex')
        const authUrl = oauth.getAuthUrl(state, redirectUri)
        return new Response(null, {
          status: 302,
          headers: {
            location: authUrl,
            'set-cookie': buildStateCookie(state, { secure: cookieSecure }),
          },
        })
      }

      // ---- /auth/google/callback ----
      if (pathname === '/auth/google/callback') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        if (!oauth) return new Response('OAuth not configured', { status: 503 })

        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const cookieState = parseStateCookie(req.headers.get('cookie'))
        if (!code || !state) return new Response('Missing code/state', { status: 400 })
        if (!cookieState || cookieState !== state) {
          return new Response('State mismatch', {
            status: 400,
            headers: { 'set-cookie': buildClearStateCookie({ secure: cookieSecure }) },
          })
        }

        let profile: Awaited<ReturnType<GoogleOAuth['exchangeCode']>>
        try {
          profile = await oauth.exchangeCode(code, redirectUri)
        } catch (e) {
          return new Response(`OAuth exchange failed: ${(e as Error).message}`, {
            status: 400,
            headers: { 'set-cookie': buildClearStateCookie({ secure: cookieSecure }) },
          })
        }

        // Invite-consume runs BEFORE the allowlist check so a fresh email
        // gets added to allowed_emails first, then trivially passes the
        // existing isAllowed() gate. Invite cookie was set by /invite/:token.
        const inviteToken = parseInviteCookie(req.headers.get('cookie'))
        let consumedInviteEmail: string | null = null
        if (inviteToken) {
          const u = users.upsertByGoogleSub({
            sub: profile.sub,
            email: profile.email,
            name: profile.name,
            picture_url: profile.picture_url,
          })
          // Atomic UPDATE … WHERE used_at IS NULL — a second tap on the
          // same link returns null and falls through to the normal flow.
          const consumed = invites.consume(inviteToken, u.id, profile.email)
          if (consumed) {
            allowedEmails.add(profile.email, 'invite', consumed.created_by_user_id)
            consumedInviteEmail = profile.email
          }
        }

        if (!allowedEmails.isAllowed(profile.email)) {
          const denyHeaders = new Headers({ 'content-type': 'text/html; charset=utf-8' })
          denyHeaders.append('set-cookie', buildClearStateCookie({ secure: cookieSecure }))
          if (inviteToken) {
            denyHeaders.append('set-cookie', buildClearInviteCookie({ secure: cookieSecure }))
          }
          return new Response(renderAccessDenied(profile.email), {
            status: 403,
            headers: denyHeaders,
          })
        }

        // upsert again (or first time, if no invite token path ran above)
        // so picture/name refresh on every sign-in.
        const user = users.upsertByGoogleSub({
          sub: profile.sub,
          email: profile.email,
          name: profile.name,
          picture_url: profile.picture_url,
        })
        const session = sessions.create(user.id)

        // Three Set-Cookie headers in the success path:
        //   - clear oauth_state (used + done)
        //   - clear invite cookie if it was present (regardless of consume
        //     outcome — once we're past the allowlist check it's spent)
        //   - issue the long-lived session cookie
        const h = new Headers({ location: '/' })
        h.append('set-cookie', buildClearStateCookie({ secure: cookieSecure }))
        if (inviteToken) {
          h.append('set-cookie', buildClearInviteCookie({ secure: cookieSecure }))
        }
        h.append('set-cookie', buildSessionCookie(session.token, { secure: cookieSecure }))
        if (consumedInviteEmail) {
          // Quiet success signal in headers, mostly to make tests legible.
          h.set('x-voice-clip-signup', 'invite')
        }
        return new Response(null, { status: 302, headers: h })
      }

      // ---- /download/latest ----
      // PWA "Download Mac app" button. Serves the .dmg straight from the
      // VPS mirror (so it keeps working with a private repo). Falls back to
      // GH Releases until the next desktop-v* tag populates the mirror.
      if (pathname === '/download/latest') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        return serveDesktopArtifact('voice-clip.dmg', 'application/x-apple-diskimage', LATEST_DMG_URL)
      }

      // ---- /desktop/voice-clip.dmg ----
      // Stable URL for the .dmg, served off the VPS mirror with the same
      // disk-then-302 behaviour as /download/latest. Currently only used by
      // /download/latest itself, but exposed independently so external
      // links (release notes, support emails, etc.) survive going private.
      if (pathname === '/desktop/voice-clip.dmg') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        return serveDesktopArtifact('voice-clip.dmg', 'application/x-apple-diskimage', LATEST_DMG_URL)
      }

      // ---- /desktop/voice-clip.app.tar.gz ----
      // The URL embedded in latest.json after the CI rewrite. The Tauri
      // updater downloads this tarball, verifies its Ed25519 signature
      // against the one in latest.json, and unpacks it over the installed
      // .app bundle.
      if (pathname === '/desktop/voice-clip.app.tar.gz') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        return serveDesktopArtifact('voice-clip.app.tar.gz', 'application/gzip', LATEST_APP_TARBALL_URL)
      }

      // ---- /desktop/update.json ----
      // Tauri auto-updater endpoint (unauthenticated). Serves the signed
      // manifest from the VPS mirror; the platforms.*.url inside is
      // rewritten by CI to point at /desktop/voice-clip.dmg on this host so
      // the updater never touches GitHub Releases when the repo is private.
      // Falls back to the GH manifest until the first desktop-v* tag after
      // this change populates the mirror.
      if (pathname === '/desktop/update.json') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        return serveDesktopArtifact('latest.json', 'application/json; charset=utf-8', LATEST_UPDATE_MANIFEST_URL)
      }

      // ---- /desktop/auth/start ----
      // Mirrors /auth/google/start but the redirect_uri is the desktop
      // completion route. The Tauri app opens this in the default browser.
      if (pathname === '/desktop/auth/start') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        if (!oauth) return new Response('OAuth not configured', { status: 503 })
        // Honor an app-supplied one-time `state` so the app can correlate the
        // voiceclip:// callback with the launch that initiated it; otherwise
        // mint our own. Either way it doubles as the OAuth CSRF state.
        const requested = url.searchParams.get('state')
        const state =
          requested && requested.length > 0 ? requested : randomBytes(16).toString('hex')
        const authUrl = oauth.getAuthUrl(state, desktopRedirectUri)
        return new Response(null, {
          status: 302,
          headers: {
            location: authUrl,
            'set-cookie': buildStateCookie(state, { secure: cookieSecure }),
          },
        })
      }

      // ---- /desktop/auth/complete ----
      // Mirrors /auth/google/callback, but instead of a session cookie + 302 /
      // it creates a DEVICE row and 302s to the voiceclip:// deep link the
      // Tauri app intercepts. No browser session is established here.
      if (pathname === '/desktop/auth/complete') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        if (!oauth) return new Response('OAuth not configured', { status: 503 })

        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const cookieState = parseStateCookie(req.headers.get('cookie'))
        if (!code || !state) return new Response('Missing code/state', { status: 400 })
        if (!cookieState || cookieState !== state) {
          return new Response('State mismatch', {
            status: 400,
            headers: { 'set-cookie': buildClearStateCookie({ secure: cookieSecure }) },
          })
        }

        let profile: Awaited<ReturnType<GoogleOAuth['exchangeCode']>>
        try {
          profile = await oauth.exchangeCode(code, desktopRedirectUri)
        } catch (e) {
          return new Response(`OAuth exchange failed: ${(e as Error).message}`, {
            status: 400,
            headers: { 'set-cookie': buildClearStateCookie({ secure: cookieSecure }) },
          })
        }

        if (!allowedEmails.isAllowed(profile.email)) {
          return new Response(renderAccessDenied(profile.email), {
            status: 403,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'set-cookie': buildClearStateCookie({ secure: cookieSecure }),
            },
          })
        }

        const user = users.upsertByGoogleSub({
          sub: profile.sub,
          email: profile.email,
          name: profile.name,
          picture_url: profile.picture_url,
        })
        const device = devices.create(user.id)

        const deepLink =
          `voiceclip://callback?token=${encodeURIComponent(device.device_token)}` +
          `&state=${encodeURIComponent(state)}`
        const h = new Headers({ location: deepLink })
        h.append('set-cookie', buildClearStateCookie({ secure: cookieSecure }))
        return new Response(null, { status: 302, headers: h })
      }

      // ---- /events (SSE; device-token auth) ----
      // Long-lived Server-Sent-Events stream the Mac app holds open. Each
      // connection registers its ReadableStream controller in the live-bus
      // keyed by device id; /upload fan-out enqueues clip frames here.
      if (pathname === '/events') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        const device = resolveDeviceFromRequest(req, devices)
        if (!device) return unauthorized()
        devices.touch(device.id)

        const enc = new TextEncoder()
        // Heartbeat keeps the otherwise-idle SSE connection alive so neither
        // Bun's idleTimeout nor any proxy in the path (Cloudflare tunnel)
        // reaps it. Cleared in cancel(), and on the first failed enqueue
        // (which means the controller was already closed/errored).
        let heartbeat: ReturnType<typeof setInterval> | null = null
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Prelude comment so proxies flush headers and the client sees
            // the connection is live immediately.
            controller.enqueue(enc.encode(': connected\n\n'))

            // Replay anything queued while this Mac was offline, oldest-first
            // (seq ASC), BEFORE subscribing to the live bus — so a clip the
            // phone uploads mid-flush can never interleave ahead of the
            // backlog. Each replayed frame uses the SAME payload shape as the
            // /upload fan-out so the Mac handles them identically.
            const queued = pendingDeliveries.listByDevice(device.id)
            if (queued.length > 0) {
              const seqs = new Set(queued.map((q) => q.seq))
              const minSeq = queued[0]!.seq
              for (const clip of history.listSince(device.user_id, minSeq - 1)) {
                if (!seqs.has(clip.seq)) continue
                const payload = {
                  seq: clip.seq,
                  text: clip.text,
                  recordedAt: clip.recordedAt,
                  source: clip.source,
                  costUsd: clip.costUsd,
                }
                controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
              }
            }

            liveBus.subscribe(device.id, controller)

            // SSE comment ping every 25s (well under the 255s idleTimeout).
            heartbeat = setInterval(() => {
              try {
                controller.enqueue(enc.encode(': ping\n\n'))
              } catch {
                // Controller already closed/errored (e.g. device revoked) —
                // stop pinging; cancel() may not fire for an errored stream.
                if (heartbeat) clearInterval(heartbeat)
                heartbeat = null
              }
            }, 25_000)
          },
          cancel() {
            if (heartbeat) clearInterval(heartbeat)
            heartbeat = null
            liveBus.unsubscribe(device.id)
          },
        })
        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
          },
        })
      }

      // ---- /events/ack (device-token auth) ----
      // The Mac app POSTs { seq } after a successful pbcopy. The seq deletes
      // the matching pending_deliveries row so the clip is not replayed on
      // the next reconnect. The body is optional/best-effort — a missing or
      // malformed body still acks liveness (bumps last_seen_at) and never
      // 500s.
      if (pathname === '/events/ack') {
        if (method !== 'POST') return new Response('Method Not Allowed', { status: 405 })
        const device = resolveDeviceFromRequest(req, devices)
        if (!device) return unauthorized()
        let parsed: unknown
        try {
          parsed = await req.json()
        } catch {
          // ignore — liveness ack does not depend on the body
        }
        const seq =
          parsed && typeof parsed === 'object' && typeof (parsed as { seq?: unknown }).seq === 'number'
            ? (parsed as { seq: number }).seq
            : undefined
        if (seq !== undefined) pendingDeliveries.deleteBySeq(device.id, seq)
        devices.touch(device.id)
        return Response.json({ ok: true })
      }

      // ---- / (root) ----
      // The home shell is static and identical for every user. Auth is
      // resolved client-side by app.ts via /me — on 401 the client
      // redirects to /login. This lets the service worker precache `/`
      // as one immutable blob and serve it offline-first. See
      // docs/adr/0001-pwa-boot-architecture.md for the full design.
      if (pathname === '/') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        return htmlResponse(homeHtmlStatic)
      }
      // Dedicated login URL. Anonymous users land here via the client's
      // 401-redirect; the OAuth start link on this page kicks off the
      // existing /auth/google/start flow, whose callback puts the user
      // back at `/`.
      // ---- /pro ---- (placeholder upgrade page, no auth required)
      if (pathname === '/pro') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        return htmlResponse(proHtml)
      }

      if (pathname === '/login') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        return htmlResponse(loginHtml)
      }

      return new Response('Not Found', { status: 404 })
  }

  return {
    port: server.port ?? deps.port ?? 0,
    stop: () => {
      server.stop(true)
    },
  }
}
