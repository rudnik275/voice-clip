import { join } from 'node:path'
import { config } from './config'
import { createAudioStorage, type AudioStorage } from './storage'
import { transcribeAudio } from './transcribe'
import { copyToClipboard } from './macos'
import { calcCostUsd } from './pricing'
import { createCostStore, type CostStore } from './cost-store'
import { createHistoryStore, type HistoryItem, type HistoryStore } from './history-store'
import { createUsersStore, type UsersStore, type User } from './users-store'
import { createInvitesStore, type InvitesStore } from './invites-store'
import { createMagicLinksStore, type MagicLinksStore } from './magic-links-store'
import { createSessionsStore, type SessionsStore } from './sessions-store'
import { createPendingClipsStore, type PendingClipsStore } from './pending-clips-store'
import { createLiveBus, type LiveBus } from './live-bus'
import {
  clearSessionCookieHeader,
  forbidden,
  resolveSession,
  setSessionCookieHeader,
  unauthorized,
} from './auth'
import indexPage from '../web/index.html'
import offlinePage from '../web/offline.html'

const SW_PATH = new URL('../web/sw.js', import.meta.url).pathname
const SIGNUP_PATH = new URL('../web/signup.html', import.meta.url).pathname
const SIGNUP_NEEDED_PATH = new URL('../web/signup-needed.html', import.meta.url).pathname
const LOGIN_PATH = new URL('../web/login.html', import.meta.url).pathname
const DAEMON_SRC_PATH = new URL('../daemon/index.ts', import.meta.url).pathname
const DAEMON_PLIST_PATH = new URL('../daemon/com.voiceclip.daemon.plist.tmpl', import.meta.url).pathname
const DAEMON_INSTALL_PATH = new URL('../daemon/install.sh.tmpl', import.meta.url).pathname

const APP_VERSION = 'v11'

export interface ServerDeps {
  dataDir?: string
  users?: UsersStore
  invites?: InvitesStore
  magicLinks?: MagicLinksStore
  sessions?: SessionsStore
  audio?: AudioStorage
  aggregateCosts?: CostStore
  liveBus?: LiveBus
  transcribe?: typeof transcribeAudio
  copyToClipboard?: typeof copyToClipboard
  port?: number
  certPath?: string
  keyPath?: string
  useTls?: boolean
  adminToken?: string
  publicUrl?: string
}

function guessExt(mime: string): string {
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a'
  if (mime.includes('webm')) return '.webm'
  if (mime.includes('ogg')) return '.ogg'
  if (mime.includes('wav')) return '.wav'
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3'
  return '.bin'
}

async function tlsOrNull(
  certPath: string,
  keyPath: string,
): Promise<{ cert: ReturnType<typeof Bun.file>; key: ReturnType<typeof Bun.file> } | undefined> {
  const certFile = Bun.file(certPath)
  const keyFile = Bun.file(keyPath)
  const haveBoth = (await certFile.exists()) && (await keyFile.exists())
  if (!haveBoth) {
    console.warn(
      `[tls] no cert at ${certPath} / ${keyPath} — starting HTTP. ` +
        `iPhone microphone will NOT work over HTTP. Run: bun run cert`,
    )
    return undefined
  }
  return { cert: certFile, key: keyFile }
}

export async function startServer(deps: ServerDeps = {}) {
  const dataDir = deps.dataDir ?? config.dataDir
  const users = deps.users ?? createUsersStore(dataDir)
  const invites = deps.invites ?? createInvitesStore(dataDir)
  const magicLinks = deps.magicLinks ?? createMagicLinksStore(dataDir)
  const sessions = deps.sessions ?? createSessionsStore(dataDir)
  const audio = deps.audio ?? createAudioStorage(dataDir)
  const aggregateCosts = deps.aggregateCosts ?? createCostStore(dataDir)
  const liveBus = deps.liveBus ?? createLiveBus()
  const transcribe = deps.transcribe ?? transcribeAudio
  const copy = deps.copyToClipboard ?? copyToClipboard
  const port = deps.port ?? config.port
  const certPath = deps.certPath ?? config.certPath
  const keyPath = deps.keyPath ?? config.keyPath
  const useTls = deps.useTls ?? config.useTls
  const adminToken = deps.adminToken ?? config.adminToken
  const publicUrl = deps.publicUrl ?? config.publicUrl

  const tls = useTls ? await tlsOrNull(certPath, keyPath) : undefined

  // Per-user store cache: each store holds its own write-mutex Promise chain;
  // we MUST cache so concurrent requests for the same user share that lock.
  const historyCache = new Map<string, HistoryStore>()
  const userCostCache = new Map<string, CostStore>()
  const pendingCache = new Map<string, PendingClipsStore>()

  function getHistory(userId: string): HistoryStore {
    let s = historyCache.get(userId)
    if (!s) {
      s = createHistoryStore(join(dataDir, 'users', userId))
      historyCache.set(userId, s)
    }
    return s
  }
  function getUserCosts(userId: string): CostStore {
    let s = userCostCache.get(userId)
    if (!s) {
      s = createCostStore(join(dataDir, 'users', userId))
      userCostCache.set(userId, s)
    }
    return s
  }
  function getPending(userId: string): PendingClipsStore {
    let s = pendingCache.get(userId)
    if (!s) {
      s = createPendingClipsStore(dataDir, userId)
      pendingCache.set(userId, s)
    }
    return s
  }

  // Cookie Secure flag: required by browsers when serving over HTTPS, illegal
  // (cookie ignored) over HTTP. Match the transport.
  const secureCookie = useTls

  async function authed(req: Request): Promise<{ user: User; sessionToken: string } | Response> {
    const auth = await resolveSession(req, sessions, users)
    if (!auth) return unauthorized()
    return auth
  }

  function checkAdmin(req: Request): true | Response {
    if (!adminToken) return forbidden('Admin disabled (ADMIN_TOKEN not set)')
    if (req.headers.get('x-admin-token') !== adminToken) return forbidden()
    return true
  }

  function htmlResponse(body: ReturnType<typeof Bun.file>, status = 200): Response {
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
    })
  }

  return Bun.serve({
    port,
    // Bun's default idleTimeout is 10s — too short for SSE streams. With 10s
    // the /events connection gets killed before our keepalive can cover it
    // and Tailscale Funnel returns 502 to the daemon. 120s gives the
    // application-level keepalive (20s) room to breathe.
    idleTimeout: 120,
    ...(tls ? { tls } : {}),
    routes: {
      '/': indexPage,
      '/offline': offlinePage,
      '/signup-needed': () =>
        new Response(Bun.file(SIGNUP_NEEDED_PATH), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
        }),
      '/sw.js': () =>
        new Response(Bun.file(SW_PATH), {
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Service-Worker-Allowed': '/',
            'Cache-Control': 'no-cache',
          },
        }),
      '/version': () =>
        new Response(APP_VERSION, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
        }),
      '/signup/:invite': {
        GET: async (req) => {
          const all = await invites.list()
          const inv = all.find((i) => i.token === req.params.invite)
          if (!inv || inv.usedAt) {
            return htmlResponse(Bun.file(SIGNUP_NEEDED_PATH), 410)
          }
          return htmlResponse(Bun.file(SIGNUP_PATH), 200)
        },
        POST: async (req) => {
          const all = await invites.list()
          const inv = all.find((i) => i.token === req.params.invite)
          if (!inv || inv.usedAt) return Response.json({ error: 'Invite invalid' }, { status: 410 })

          let name = ''
          const ct = req.headers.get('content-type') ?? ''
          if (ct.includes('application/json')) {
            const body = (await req.json().catch(() => ({}))) as { name?: string }
            name = (body.name ?? '').trim()
          } else {
            const form = await req.formData()
            const v = form.get('name')
            if (typeof v === 'string') name = v.trim()
          }
          if (!name) return Response.json({ error: 'Name required' }, { status: 400 })
          if (name.length > 40) return Response.json({ error: 'Name too long' }, { status: 400 })

          const user = await users.create({ name })
          const consumed = await invites.consume(req.params.invite, user.id)
          if (!consumed) {
            // Race: someone else consumed between our check and consume. Roll back the user.
            // (Simpler than a transaction; orphaned users are harmless and rare.)
            return Response.json({ error: 'Invite already used' }, { status: 410 })
          }
          const session = await sessions.create(user.id)
          return Response.json(
            { id: user.id, name: user.name },
            {
              status: 200,
              headers: { 'Set-Cookie': setSessionCookieHeader(session.token, secureCookie) },
            },
          )
        },
      },
      '/me': {
        GET: async (req) => {
          const auth = await authed(req)
          if (auth instanceof Response) return auth
          return Response.json({
            id: auth.user.id,
            name: auth.user.name,
            daemonToken: auth.user.daemonToken,
          })
        },
      },
      '/logout': {
        POST: async (req) => {
          const auth = await resolveSession(req, sessions, users)
          if (auth) await sessions.delete(auth.sessionToken)
          return new Response(null, {
            status: 204,
            headers: { 'Set-Cookie': clearSessionCookieHeader(secureCookie) },
          })
        },
      },
      '/admin/invites': {
        GET: async (req) => {
          const ok = checkAdmin(req)
          if (ok !== true) return ok
          return Response.json(await invites.list())
        },
        POST: async (req) => {
          const ok = checkAdmin(req)
          if (ok !== true) return ok
          const inv = await invites.create()
          const url = publicUrl ? `${publicUrl}/signup/${inv.token}` : `/signup/${inv.token}`
          return Response.json({ token: inv.token, url, createdAt: inv.createdAt })
        },
      },
      '/admin/magic-link': {
        // Generate a one-time login URL that signs an EXISTING user into a
        // new browser/device. Solves "I'm signed in on my phone, how do I
        // also use the PWA on my iPad without creating a second account?".
        // Body: { userId, ttlSec? } — ttlSec defaults to 300 (5 min).
        POST: async (req) => {
          const ok = checkAdmin(req)
          if (ok !== true) return ok
          const body = (await req.json().catch(() => ({}))) as {
            userId?: string
            ttlSec?: number
          }
          if (!body.userId) return Response.json({ error: 'userId required' }, { status: 400 })
          const user = await users.get(body.userId)
          if (!user) return Response.json({ error: 'user not found' }, { status: 404 })
          const ttl = typeof body.ttlSec === 'number' && body.ttlSec > 0 ? body.ttlSec : 300
          const link = await magicLinks.create(user.id, ttl)
          const url = publicUrl ? `${publicUrl}/login/${link.token}` : `/login/${link.token}`
          return Response.json({
            token: link.token,
            url,
            userId: user.id,
            userName: user.name,
            expiresAt: link.expiresAt,
          })
        },
      },
      '/login/:magicToken': {
        // GET renders a "Continue" page WITHOUT consuming the token. POST
        // is what actually consumes + sets the cookie. This split prevents
        // link-preview bots in iMessage / Slack / Telegram (which do GET to
        // render rich previews) from burning the single-use token before
        // the human gets a chance to click.
        GET: async (req) => {
          const link = await magicLinks.peek(req.params.magicToken)
          if (!link) {
            return htmlResponse(Bun.file(SIGNUP_NEEDED_PATH), 410)
          }
          return htmlResponse(Bun.file(LOGIN_PATH), 200)
        },
        POST: async (req) => {
          const link = await magicLinks.consume(req.params.magicToken)
          if (!link) {
            return Response.json({ error: 'magic-link expired or already used' }, { status: 410 })
          }
          const session = await sessions.create(link.userId)
          return new Response(null, {
            status: 303,
            headers: {
              Location: '/',
              'Set-Cookie': setSessionCookieHeader(session.token, secureCookie),
            },
          })
        },
      },
      '/login/:magicToken/peek': {
        // Read-only metadata for the GET-rendered login page (so it can show
        // "Привет, <name>"). Does NOT consume the token. Safe to call any
        // number of times.
        GET: async (req) => {
          const link = await magicLinks.peek(req.params.magicToken)
          if (!link) return Response.json({ error: 'invalid' }, { status: 410 })
          const user = await users.get(link.userId)
          if (!user) return Response.json({ error: 'invalid' }, { status: 410 })
          return Response.json({ userId: user.id, userName: user.name, expiresAt: link.expiresAt })
        },
      },
      '/cost': {
        GET: async (req) => {
          const auth = await authed(req)
          if (auth instanceof Response) return auth
          // Aggregate across all users — both Dima and Olya see the same total.
          return Response.json(await aggregateCosts.get())
        },
      },
      '/history': {
        GET: async (req) => {
          const auth = await authed(req)
          if (auth instanceof Response) return auth
          return Response.json(await getHistory(auth.user.id).list())
        },
        DELETE: async (req) => {
          const auth = await authed(req)
          if (auth instanceof Response) return auth
          const removed = await getHistory(auth.user.id).clear()
          return Response.json({ removed })
        },
      },
      '/history/read-all': {
        POST: async (req) => {
          const auth = await authed(req)
          if (auth instanceof Response) return auth
          const updated = await getHistory(auth.user.id).markAllRead()
          return Response.json({ updated })
        },
      },
      '/history/:id': {
        DELETE: async (req) => {
          const auth = await authed(req)
          if (auth instanceof Response) return auth
          const ok = await getHistory(auth.user.id).remove(req.params.id)
          return Response.json({ ok }, { status: ok ? 200 : 404 })
        },
      },
      '/history/:id/read': {
        POST: async (req) => {
          const auth = await authed(req)
          if (auth instanceof Response) return auth
          const item = await getHistory(auth.user.id).markRead(req.params.id)
          return item ? Response.json(item) : Response.json({ error: 'not found' }, { status: 404 })
        },
      },
      '/upload': {
        POST: async (req) => {
          const auth = await authed(req)
          if (auth instanceof Response) return auth
          const userId = auth.user.id
          try {
            await audio.runDailyCleanupIfNeeded()
            const form = await req.formData()
            const audioBlob = form.get('audio')
            if (!(audioBlob instanceof Blob)) {
              return Response.json({ error: 'no audio field' }, { status: 400 })
            }
            const sourceField = form.get('source')
            const source: 'online' | 'offline' = sourceField === 'offline' ? 'offline' : 'online'
            const recordedAtField = form.get('recordedAt')
            const recordedAt = typeof recordedAtField === 'string' ? recordedAtField : undefined

            const buf = new Uint8Array(await audioBlob.arrayBuffer())
            const ext = guessExt(audioBlob.type)
            const { base } = await audio.saveAudio(buf, ext)

            const result = await transcribe(buf, `voice${ext}`)
            const text = result.text.trim()

            let costUsd: number | undefined
            let totalUsd: number | undefined
            let totalRequests: number | undefined
            if (result.usage) {
              costUsd = calcCostUsd(result.usage)
              // Per-user accounting
              await getUserCosts(userId).record(costUsd)
              // Aggregate (the number shown in everyone's total-pill)
              const agg = await aggregateCosts.record(costUsd)
              totalUsd = agg.totalUsd
              totalRequests = agg.totalRequests
            }

            const ts = new Date().toISOString()
            if (text) {
              const item: HistoryItem = {
                id: base,
                ts,
                ...(recordedAt ? { recordedAt } : {}),
                text,
                ...(costUsd !== undefined ? { costUsd } : {}),
                source,
                ...(source === 'online' ? { readAt: ts } : {}),
              }
              await getHistory(userId).append(item)
              if (source === 'online') {
                // Direct pbcopy on the SERVER's Mac: only useful for the legacy
                // single-user / local-Mac deployment. In the multi-user / NAS
                // deployment this is a no-op (no pbcopy on Linux), and clipboard
                // delivery happens via the per-user Mac daemon over /events.
                await copy(text).catch((err) => {
                  console.error('[upload] pbcopy failed:', err)
                })
                // Push to the user's daemon (if any) and queue for replay if not.
                await getPending(userId).enqueue({ id: base, text })
                liveBus.publish(userId, { id: base, text })
              }
            }

            console.log(
              `[upload] user=${auth.user.name} ${base}${ext} (${source}) → ${text.length} chars` +
                (costUsd !== undefined ? ` · $${costUsd.toFixed(5)} (total $${totalUsd?.toFixed(4)})` : ''),
            )
            return Response.json({ id: base, text, costUsd, totalUsd, totalRequests, source })
          } catch (err) {
            console.error('[upload] error:', err)
            const msg = err instanceof Error ? err.message : 'internal error'
            return Response.json({ error: msg }, { status: 500 })
          }
        },
      },
      '/events': {
        GET: async (req) => {
          const url = new URL(req.url)
          const token = url.searchParams.get('token') ?? ''
          const user = await users.getByDaemonToken(token)
          if (!user) return forbidden()
          const userId = user.id
          const pending = getPending(userId)

          let unsubscribe: (() => void) | null = null

          const stream = new ReadableStream({
            async start(controller) {
              const enc = new TextEncoder()
              const send = (clip: { id: string; text: string }): void => {
                try {
                  controller.enqueue(enc.encode(`data: ${JSON.stringify(clip)}\n\n`))
                } catch {
                  // controller closed — ignore
                }
              }

              // Replay everything not yet acked.
              for (const clip of await pending.listUnacked()) {
                send({ id: clip.id, text: clip.text })
              }
              // Subscribe to live events.
              unsubscribe = liveBus.subscribe(userId, send)

              // Heartbeat every 20s — keeps Tailscale Funnel + Bun.serve's
              // idleTimeout (120s) from declaring the stream idle. Setting
              // this lower than the smallest upstream timeout / 4 leaves
              // plenty of margin for jitter.
              const hb = setInterval(() => {
                try {
                  controller.enqueue(enc.encode(`: keepalive\n\n`))
                } catch {
                  clearInterval(hb)
                }
              }, 20_000)

              const onAbort = (): void => {
                clearInterval(hb)
                unsubscribe?.()
                try {
                  controller.close()
                } catch {
                  // already closed
                }
              }
              req.signal.addEventListener('abort', onAbort, { once: true })
            },
            cancel() {
              unsubscribe?.()
            },
          })

          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              Connection: 'keep-alive',
              // Disables buffering at any nginx/cloudflare proxy in front.
              'X-Accel-Buffering': 'no',
            },
          })
        },
      },
      '/events/ack': {
        POST: async (req) => {
          const token = req.headers.get('x-daemon-token') ?? ''
          const user = await users.getByDaemonToken(token)
          if (!user) return forbidden()
          const body = (await req.json().catch(() => ({}))) as { ids?: string[] }
          const ids = Array.isArray(body.ids) ? body.ids : []
          const pending = getPending(user.id)
          let acked = 0
          for (const id of ids) {
            if (await pending.ack(id)) acked++
          }
          return Response.json({ acked })
        },
      },
      '/install/voice-clip-daemon': {
        GET: async (req) => {
          // Auth: daemon-token in URL (curl-from-Mac doesn't have a session
          // cookie). The token is the long-lived secret the daemon will use
          // anyway; if it leaks here it's no worse than if it leaks anywhere.
          const url = new URL(req.url)
          const token = url.searchParams.get('token') ?? ''
          const user = await users.getByDaemonToken(token)
          if (!user) return forbidden()
          const target = publicUrl || `${url.protocol}//${url.host}`
          const [installTmpl, daemonSrc, plistTmpl] = await Promise.all([
            Bun.file(DAEMON_INSTALL_PATH).text(),
            Bun.file(DAEMON_SRC_PATH).text(),
            Bun.file(DAEMON_PLIST_PATH).text(),
          ])
          // Plist template uses __HOME__ placeholders that launchctl resolves
          // at install time via the bash heredoc — we substitute __URL__ /
          // __TOKEN__ / __BUN_PATH__ on the server, the rest by the install
          // shell script via parameter expansion. Keep this responsive to the
          // template fields above.
          const plistRendered = plistTmpl
            .replaceAll('__URL__', target)
            .replaceAll('__TOKEN__', token)
          const installScript = installTmpl
            .replaceAll('__URL__', target)
            .replaceAll('__TOKEN__', token)
            .replace('__DAEMON_SOURCE__', daemonSrc.trimEnd())
            .replace('__PLIST_BODY__', plistRendered.trimEnd())
          return new Response(installScript, {
            headers: {
              'Content-Type': 'text/x-shellscript; charset=utf-8',
              'Cache-Control': 'no-cache',
            },
          })
        },
      },
    },
  })
}
