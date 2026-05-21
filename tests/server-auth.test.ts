import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerDeps } from '../src/server'
import type { GoogleFetcher } from '../src/google-oauth'
import { APP_VERSION } from '../src/version'

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const CLIENT_SECRET = 'test-secret'

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function makeIdToken(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  return `${header}.${body}.fake-signature`
}

function makeGoogleFetcher(idTokenPayload: Record<string, unknown>): GoogleFetcher {
  return async () => {
    const idToken = makeIdToken({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      email_verified: true,
      ...idTokenPayload,
    })
    return new Response(
      JSON.stringify({ id_token: idToken, access_token: 'fake', token_type: 'Bearer' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
}

function extractCookie(setCookieHeaders: string[], name: string): string | null {
  for (const sc of setCookieHeaders) {
    const first = sc.split(';')[0]?.trim() ?? ''
    if (first.startsWith(`${name}=`)) {
      return first.slice(name.length + 1)
    }
  }
  return null
}

describe('server: end-to-end Google OAuth + sessions + /me', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  async function startWith(googleFetcher: GoogleFetcher, allowlist: string[] = ['alice@example.com']) {
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist,
      googleFetcher,
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      publicUrl: `http://placeholder`,
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    // Use the actual baseUrl as publicUrl for redirect_uri match — restart.
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-server-'))
  })

  afterEach(async () => {
    if (server) server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('GET /version returns plain text APP_VERSION', async () => {
    await startWith(makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }))
    const r = await fetch(`${baseUrl}/version`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/plain')
    expect(await r.text()).toBe(APP_VERSION)
  })

  test('GET /login → sign-in page (200, has Sign in with Google)', async () => {
    // The Google OAuth start button lives on /login now — the unauth
    // landing page. `/` itself is the static home shell. See
    // docs/adr/0001-pwa-boot-architecture.md.
    await startWith(makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }))
    const r = await fetch(`${baseUrl}/login`, { redirect: 'manual' })
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html.toLowerCase()).toContain('sign in with google')
  })

  test('GET /me unauthenticated → 401', async () => {
    await startWith(makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }))
    const r = await fetch(`${baseUrl}/me`)
    expect(r.status).toBe(401)
  })

  test('GET /auth/google/start → 302 to accounts.google.com + sets oauth_state cookie', async () => {
    await startWith(makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }))
    const r = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' })
    expect(r.status).toBe(302)
    const location = r.headers.get('location')
    expect(location).toContain('https://accounts.google.com/o/oauth2/v2/auth')
    expect(location).toContain('client_id=')
    expect(location).toContain('scope=openid+email+profile')
    expect(location).toContain('state=')
    const setCookie = r.headers.getSetCookie()
    const state = extractCookie(setCookie, 'oauth_state')
    expect(state).toBeTruthy()
    expect(state?.length).toBeGreaterThan(8)
  })

  test('OAuth callback (allowlisted email) → sets session cookie, redirects to /', async () => {
    await startWith(makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }))

    // 1. Start flow to get state cookie.
    const startR = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' })
    const stateCookieHeader = startR.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))!
    const state = stateCookieHeader.split(';')[0]!.split('=')[1]!

    // 2. Hit callback with matching state + code.
    const cbR = await fetch(
      `${baseUrl}/auth/google/callback?code=fake-code&state=${state}`,
      {
        headers: { cookie: `oauth_state=${state}` },
        redirect: 'manual',
      },
    )
    expect(cbR.status).toBe(302)
    expect(cbR.headers.get('location')).toBe('/')

    const setCookies = cbR.headers.getSetCookie()
    const sessionToken = extractCookie(setCookies, 'session')
    expect(sessionToken).toBeTruthy()

    // 3. /me with the cookie returns the user.
    const me = await fetch(`${baseUrl}/me`, { headers: { cookie: `session=${sessionToken}` } })
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { id: string; email: string; name: string }
    expect(meBody.email).toBe('alice@example.com')
    expect(meBody.name).toBe('Alice')
  })

  test('OAuth callback (NON-allowlisted email) → 403 access denied, NO session cookie', async () => {
    await startWith(
      makeGoogleFetcher({ sub: 'g2', email: 'evil@example.com', name: 'Evil' }),
      ['alice@example.com'],
    )

    const startR = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' })
    const state = startR.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))!
      .split(';')[0]!.split('=')[1]!

    const cbR = await fetch(
      `${baseUrl}/auth/google/callback?code=fake-code&state=${state}`,
      {
        headers: { cookie: `oauth_state=${state}` },
        redirect: 'manual',
      },
    )
    expect(cbR.status).toBe(403)
    const setCookies = cbR.headers.getSetCookie()
    const sessionToken = extractCookie(setCookies, 'session')
    expect(sessionToken).toBeNull()
    const html = await cbR.text()
    expect(html.toLowerCase()).toContain('access denied')
  })

  test('OAuth callback with mismatched state → 400, no session', async () => {
    await startWith(makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }))
    const r = await fetch(
      `${baseUrl}/auth/google/callback?code=fake-code&state=bogus`,
      {
        headers: { cookie: `oauth_state=different-state` },
        redirect: 'manual',
      },
    )
    expect(r.status).toBe(400)
  })

  test('POST /logout clears session cookie + subsequent /me is 401', async () => {
    await startWith(makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }))

    // Sign in.
    const startR = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' })
    const state = startR.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))!
      .split(';')[0]!.split('=')[1]!
    const cbR = await fetch(`${baseUrl}/auth/google/callback?code=fake&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
      redirect: 'manual',
    })
    const sessionToken = cbR.headers.getSetCookie().find((c) => c.startsWith('session='))!
      .split(';')[0]!.split('=')[1]!

    // Logout.
    const out = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: { cookie: `session=${sessionToken}` },
    })
    expect(out.status).toBe(200)
    const clearHeader = out.headers.getSetCookie().find((c) => c.startsWith('session='))
    expect(clearHeader).toContain('Max-Age=0')

    // /me with the now-deleted token → 401.
    const me = await fetch(`${baseUrl}/me`, { headers: { cookie: `session=${sessionToken}` } })
    expect(me.status).toBe(401)
  })

  test('GET / always returns the static shell; user name comes from /me', async () => {
    // Per docs/adr/0001-pwa-boot-architecture.md the home shell is
    // identical for every user — the name is hydrated client-side by
    // calling /me. So we assert the shell renders + /me reports the
    // signed-in user.
    await startWith(makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }))

    const startR = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' })
    const state = startR.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))!
      .split(';')[0]!.split('=')[1]!
    const cbR = await fetch(`${baseUrl}/auth/google/callback?code=fake&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
      redirect: 'manual',
    })
    const sessionToken = cbR.headers.getSetCookie().find((c) => c.startsWith('session='))!
      .split(';')[0]!.split('=')[1]!

    const home = await fetch(`${baseUrl}/`, {
      headers: { cookie: `session=${sessionToken}` },
    })
    expect(home.status).toBe(200)
    const html = await home.text()
    // Shell is identical regardless of auth: it MUST NOT carry user data.
    expect(html).not.toContain('Alice')
    // It DOES carry the empty placeholder span the client hydrates.
    expect(html).toContain('id="user-pill-name"')

    const me = await fetch(`${baseUrl}/me`, {
      headers: { cookie: `session=${sessionToken}` },
    })
    expect(me.status).toBe(200)
    const body = (await me.json()) as { name: string }
    expect(body.name).toBe('Alice')
  })

  test('GET / unauthenticated also returns the static shell (client redirects to /login)', async () => {
    await startWith(makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }))
    // No session cookie.
    const home = await fetch(`${baseUrl}/`)
    expect(home.status).toBe(200)
    const html = await home.text()
    expect(html).toContain('id="user-pill-name"')
    // The OAuth button is on /login, NOT on the shell.
    expect(html).not.toContain('/auth/google/start')

    const login = await fetch(`${baseUrl}/login`)
    expect(login.status).toBe(200)
    expect(await login.text()).toContain('/auth/google/start')
  })

  test('session persists across multiple requests (refresh-on-access)', async () => {
    await startWith(makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }))

    const startR = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' })
    const state = startR.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))!
      .split(';')[0]!.split('=')[1]!
    const cbR = await fetch(`${baseUrl}/auth/google/callback?code=fake&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
      redirect: 'manual',
    })
    const sessionToken = cbR.headers.getSetCookie().find((c) => c.startsWith('session='))!
      .split(';')[0]!.split('=')[1]!

    for (let i = 0; i < 3; i++) {
      const me = await fetch(`${baseUrl}/me`, { headers: { cookie: `session=${sessionToken}` } })
      expect(me.status).toBe(200)
    }
  })
})

describe('server: cookieSecure derives from publicUrl scheme, not useTls', () => {
  // Production topology: Cloudflare Tunnel terminates TLS at the edge and
  // forwards plain HTTP to Bun. useTls=false in prod, but cookies MUST still
  // carry the Secure flag because the browser-facing scheme is https.
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-cookie-secure-'))
  })

  afterEach(async () => {
    if (server) server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('publicUrl=https:// → Set-Cookie has Secure flag (prod behind Cloudflare Tunnel)', async () => {
    server = await startServer({
      dataDir: dir,
      port: 0,
      useTls: false,
      publicUrl: 'https://voice.example.com',
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      allowlist: ['alice@example.com'],
    })
    const r = await fetch(`http://localhost:${server.port}/auth/google/start`, { redirect: 'manual' })
    const oauthState = r.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))
    expect(oauthState).toBeDefined()
    expect(oauthState).toContain('Secure')
  })

  test('publicUrl=http:// → Set-Cookie omits Secure flag (local dev)', async () => {
    server = await startServer({
      dataDir: dir,
      port: 0,
      useTls: false,
      publicUrl: 'http://localhost:8080',
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      allowlist: ['alice@example.com'],
    })
    const r = await fetch(`http://localhost:${server.port}/auth/google/start`, { redirect: 'manual' })
    const oauthState = r.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))
    expect(oauthState).toBeDefined()
    expect(oauthState).not.toContain('Secure')
  })

  test('session cookie also carries Secure when publicUrl=https', async () => {
    server = await startServer({
      dataDir: dir,
      port: 0,
      useTls: false,
      publicUrl: 'https://voice.example.com',
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      allowlist: ['alice@example.com'],
    })
    const baseUrl = `http://localhost:${server.port}`
    const startR = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' })
    const stateRaw = startR.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))!
    const state = stateRaw.split(';')[0]!.split('=')[1]!
    const cbR = await fetch(`${baseUrl}/auth/google/callback?code=fake&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
      redirect: 'manual',
    })
    const sessionCookie = cbR.headers.getSetCookie().find((c) => c.startsWith('session='))
    expect(sessionCookie).toBeDefined()
    expect(sessionCookie).toContain('Secure')
  })
})
