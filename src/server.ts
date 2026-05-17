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
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { openDb, type DB } from './db'
import { createUsersStore, type UsersStore } from './users-store'
import { createSessionsStore, type SessionsStore } from './sessions-store'
import { createHistoryStore, type HistoryStore } from './history-store'
import { createCostStore, type CostStore } from './cost-store'
import { createDevicesStore, type DevicesStore } from './devices-store'
import {
  createPendingDeliveriesStore,
  type PendingDeliveriesStore,
} from './pending-deliveries-store'
import { createLiveBus, type LiveBus } from './live-bus'
import type { TranscriptionResult } from './transcribe'
import { calcCostUsd } from './pricing'
import { createAllowlist, type Allowlist } from './allowlist'
import { createGoogleOAuth, type GoogleFetcher, type GoogleOAuth } from './google-oauth'
import {
  buildClearSessionCookie,
  buildClearStateCookie,
  buildSessionCookie,
  buildStateCookie,
  parseStateCookie,
  resolveUserFromRequest,
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
  allowlist?: readonly string[] | Allowlist
  googleFetcher?: GoogleFetcher
  googleClientId?: string
  googleClientSecret?: string
  publicUrl?: string
  // Test seams
  users?: UsersStore
  sessions?: SessionsStore
  history?: HistoryStore
  costs?: CostStore
  devices?: DevicesStore
  pendingDeliveries?: PendingDeliveriesStore
  liveBus?: LiveBus
  transcribe?: (input: Uint8Array, filename: string) => Promise<TranscriptionResult>
  db?: DB
  now?: () => number
}

// The GitHub Releases asset the PWA #download-cta points at via
// /download/latest. `releases/latest/download/<asset>` always resolves to
// the newest published release's asset of that name.
const LATEST_DMG_URL =
  'https://github.com/rudnik275/voice-clip/releases/latest/download/voice-clip.dmg'

export interface RunningServer {
  port: number
  stop(): void
}

const WEB_DIR = new URL('../web/', import.meta.url).pathname

function asAllowlist(a: ServerDeps['allowlist']): Allowlist {
  if (!a) return createAllowlist([])
  if (Array.isArray(a)) return createAllowlist(a)
  if (typeof (a as Allowlist).isAllowed === 'function') return a as Allowlist
  return createAllowlist(a as readonly string[])
}

async function readWebFile(name: string): Promise<string> {
  return readFile(join(WEB_DIR, name), 'utf8')
}

function htmlResponse(html: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders },
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
  const allowlist = asAllowlist(deps.allowlist)

  const db = deps.db ?? openDb(join(deps.dataDir, 'voice-clip.sqlite'))
  const users = deps.users ?? createUsersStore(db, deps.now)
  const sessions = deps.sessions ?? createSessionsStore(db, deps.now)
  const history = deps.history ?? createHistoryStore(db, deps.now)
  const costs = deps.costs ?? createCostStore(db)
  const devices = deps.devices ?? createDevicesStore(db, deps.now)
  const pendingDeliveries =
    deps.pendingDeliveries ?? createPendingDeliveriesStore(db, deps.now)
  const liveBus = deps.liveBus ?? createLiveBus()
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
  const loginHtml = (await readWebFile('login.html')).replace('__APP_VERSION__', APP_VERSION)
  const accessDeniedTpl = await readWebFile('access-denied.html')
  const homeTpl = await readWebFile('home.html')
  const styleCss = await readWebFile('style.css')
  const manifestJson = await readWebFile('manifest.webmanifest')

  // Bundle + transpile the browser entrypoint once at boot. Bun strips TS
  // types and produces an ES module the browser can load directly via
  // <script type="module" src="/app.ts">.
  const appBuild = await Bun.build({
    entrypoints: [join(WEB_DIR, 'app.ts')],
    target: 'browser',
    minify: false,
  })
  const appJs = appBuild.success ? await appBuild.outputs[0]!.text() : ''
  if (!appBuild.success) {
    // Surface build failures loudly — a broken bundle means a dead PWA.
    console.error('web/app.ts build failed:', appBuild.logs)
  }

  function renderHome(name: string): string {
    return homeTpl.replace('__NAME__', escapeHtml(name)).replace('__APP_VERSION__', APP_VERSION)
  }

  function renderAccessDenied(email: string): string {
    return accessDeniedTpl
      .replace('__EMAIL__', escapeHtml(email))
      .replace('__APP_VERSION__', APP_VERSION)
  }

  const server = Bun.serve({
    port: deps.port ?? 8080,
    development: false,
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
          headers: { 'content-type': 'text/css; charset=utf-8' },
        })
      }
      if (method === 'GET' && pathname === '/manifest.webmanifest') {
        return new Response(manifestJson, {
          status: 200,
          headers: { 'content-type': 'application/manifest+json; charset=utf-8' },
        })
      }
      if (method === 'GET' && pathname === '/app.ts') {
        return new Response(appJs, {
          status: 200,
          headers: { 'content-type': 'text/javascript; charset=utf-8' },
        })
      }

      // ---- /me ----
      if (pathname === '/me') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        const authed = resolveUserFromRequest(req, sessions, users)
        if (!authed) return unauthorized()
        const u = authed.user
        return Response.json({
          id: u.id,
          email: u.email,
          name: u.name,
          picture_url: u.picture_url,
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
        const authed = resolveUserFromRequest(req, sessions, users)
        if (!authed) return unauthorized()

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

        let result: TranscriptionResult
        try {
          result = await transcribe(bytes, filename)
        } catch (e) {
          return Response.json(
            { error: `transcription failed: ${(e as Error).message}` },
            { status: 502 },
          )
        }

        const costUsd = result.usage ? calcCostUsd(result.usage) : 0
        const clip = history.append({
          userId: authed.user.id,
          text: result.text,
          recordedAt,
          source,
          costUsd,
        })
        if (costUsd > 0) costs.add(authed.user.id, costUsd)

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
        const authed = resolveUserFromRequest(req, sessions, users)
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
        const authed = resolveUserFromRequest(req, sessions, users)
        if (!authed) return unauthorized()
        return Response.json({
          user: costs.userTotal(authed.user.id),
          aggregate: costs.aggregateTotal(),
        })
      }

      // ---- /devices (session auth) ----
      // The PWA profile modal lists the user's paired Macs. `label` is the
      // device_name the Tauri app reported at pairing (may be null).
      if (pathname === '/devices') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        const authed = resolveUserFromRequest(req, sessions, users)
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

        if (!allowlist.isAllowed(profile.email)) {
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
        const session = sessions.create(user.id)

        // Two Set-Cookie headers (clear state + set session). Bun's Headers
        // supports append() for repeated names.
        const h = new Headers({ location: '/' })
        h.append('set-cookie', buildClearStateCookie({ secure: cookieSecure }))
        h.append('set-cookie', buildSessionCookie(session.token, { secure: cookieSecure }))
        return new Response(null, { status: 302, headers: h })
      }

      // ---- /download/latest ----
      // The PWA #download-cta (added in #8) links here. 302 to the GitHub
      // Releases "latest" alias so the URL never needs updating per release.
      if (pathname === '/download/latest') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        return new Response(null, { status: 302, headers: { location: LATEST_DMG_URL } })
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

        if (!allowlist.isAllowed(profile.email)) {
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
          },
          cancel() {
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
      if (pathname === '/') {
        if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 })
        const authed = resolveUserFromRequest(req, sessions, users)
        if (!authed) return htmlResponse(loginHtml)
        return htmlResponse(renderHome(authed.user.name))
      }

      return new Response('Not Found', { status: 404 })
    },
  })

  return {
    port: server.port ?? deps.port ?? 0,
    stop: () => {
      server.stop(true)
    },
  }
}
