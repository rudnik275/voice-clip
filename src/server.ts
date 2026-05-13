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
import { createAllowlist, type Allowlist } from './allowlist'
import { createGoogleOAuth, type GoogleFetcher, type GoogleOAuth } from './google-oauth'
import {
  buildClearSessionCookie,
  buildClearStateCookie,
  buildSessionCookie,
  buildStateCookie,
  parseStateCookie,
  resolveUserFromRequest,
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
  db?: DB
  now?: () => number
}

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
  const cookieSecure = useTls // tests run plain HTTP; prod runs behind CF Tunnel
  const allowlist = asAllowlist(deps.allowlist)

  const db = deps.db ?? openDb(join(deps.dataDir, 'voice-clip.sqlite'))
  const users = deps.users ?? createUsersStore(db, deps.now)
  const sessions = deps.sessions ?? createSessionsStore(db, deps.now)

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
  const redirectUri = oauthReady ? `${deps.publicUrl!.replace(/\/$/, '')}/auth/google/callback` : ''

  // ----- prebuilt static pages -----
  const loginHtml = (await readWebFile('login.html')).replace('__APP_VERSION__', APP_VERSION)
  const accessDeniedTpl = await readWebFile('access-denied.html')
  const homeTpl = await readWebFile('home.html')
  const styleCss = await readWebFile('style.css')
  const manifestJson = await readWebFile('manifest.webmanifest')

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
