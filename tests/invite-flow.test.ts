import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerDeps } from '../src/server'
import type { GoogleFetcher } from '../src/google-oauth'

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const CLIENT_SECRET = 'test-secret'
const OWNER_EMAIL = 'owner@example.com'

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
function makeIdToken(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.sig`
}
function googleFetcher(p: Record<string, unknown>): GoogleFetcher {
  return async () =>
    new Response(
      JSON.stringify({
        id_token: makeIdToken({
          iss: 'https://accounts.google.com',
          aud: CLIENT_ID,
          exp: Math.floor(Date.now() / 1000) + 3600,
          email_verified: true,
          ...p,
        }),
        access_token: 'fake',
        token_type: 'Bearer',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
}

function extractCookie(setCookies: string[], name: string): string | null {
  const found = setCookies.find((c) => c.startsWith(`${name}=`))
  if (!found) return null
  const v = found.split(';')[0]!.split('=')[1]!
  return v.length > 0 ? v : null
}

// Drives the full /auth/google/start → callback round-trip with cookie state
// preserved. Returns the final session token if signup succeeded, or
// the final response if it didn't.
async function runOAuth(
  baseUrl: string,
  fetcher: GoogleFetcher,
  initialCookies: string = '',
): Promise<{ session: string | null; status: number; cookies: string[] }> {
  const startR = await fetch(`${baseUrl}/auth/google/start`, {
    redirect: 'manual',
    headers: initialCookies ? { cookie: initialCookies } : {},
  })
  const stateCookies = startR.headers.getSetCookie()
  const state = extractCookie(stateCookies, 'oauth_state')!

  // We pass BOTH the existing invite cookie AND the new oauth_state cookie
  // back on the callback — that's what a real browser does.
  const cookiesToCarry = [initialCookies, `oauth_state=${state}`]
    .filter((s) => s.length > 0)
    .join('; ')
  const cbR = await fetch(`${baseUrl}/auth/google/callback?code=fake&state=${state}`, {
    headers: { cookie: cookiesToCarry },
    redirect: 'manual',
  })
  const cbCookies = cbR.headers.getSetCookie()
  return {
    session: extractCookie(cbCookies, 'session'),
    status: cbR.status,
    cookies: cbCookies,
  }
}

describe('invite-link signup flow', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  async function start(opts: { ownerEmail?: string; allowlist?: string[] } = {}) {
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: opts.allowlist ?? [],
      ownerEmail: opts.ownerEmail,
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      publicUrl: 'http://localhost',
      googleFetcher: googleFetcher({
        sub: 'will-be-overridden',
        email: 'owner@example.com',
        name: 'Owner',
      }),
    }
    server = await startServer(deps)
    baseUrl = `http://127.0.0.1:${server.port}`
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-invite-'))
  })
  afterEach(async () => {
    server?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('owner signs in (allowlist seeded from env) → session cookie', async () => {
    await start({ allowlist: [OWNER_EMAIL] })
    const r = await runOAuth(
      baseUrl,
      googleFetcher({ sub: 'g-owner', email: OWNER_EMAIL, name: 'Owner' }),
    )
    // We override the fetcher per-server, so the static one above wins —
    // but the email matches `OWNER_EMAIL` either way for the allowlist gate.
    expect(r.status).toBe(302)
    expect(r.session).not.toBeNull()
  })

  test('non-allowlisted email without an invite → 403 access denied', async () => {
    await start({ allowlist: [OWNER_EMAIL] })
    // Override fetcher to return a stranger
    server.stop()
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: [OWNER_EMAIL],
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      publicUrl: 'http://localhost',
      googleFetcher: googleFetcher({
        sub: 'g-stranger',
        email: 'stranger@example.com',
        name: 'Stranger',
      }),
    }
    server = await startServer(deps)
    baseUrl = `http://127.0.0.1:${server.port}`

    const r = await runOAuth(baseUrl, deps.googleFetcher!)
    expect(r.status).toBe(403)
    expect(r.session).toBeNull()
  })

  test('owner generates an invite → friend opens /invite/:token → signs in → allowlist row added', async () => {
    await start({ allowlist: [OWNER_EMAIL], ownerEmail: OWNER_EMAIL })

    // Step 1: owner signs in.
    const ownerLogin = await runOAuth(
      baseUrl,
      googleFetcher({ sub: 'g-owner', email: OWNER_EMAIL, name: 'Owner' }),
    )
    expect(ownerLogin.session).not.toBeNull()

    // Step 2: owner POSTs /admin/invites via their session.
    const genR = await fetch(`${baseUrl}/admin/invites`, {
      method: 'POST',
      headers: { cookie: `session=${ownerLogin.session}` },
    })
    expect(genR.status).toBe(200)
    const gen = (await genR.json()) as { token: string; url: string }
    expect(gen.token).toMatch(/^[0-9a-f]{64}$/)
    expect(gen.url).toContain(`/invite/${gen.token}`)

    // Step 3: friend opens /invite/<token> — gets the invite cookie + 302.
    const friendVisit = await fetch(`${baseUrl}/invite/${gen.token}`, {
      redirect: 'manual',
    })
    expect(friendVisit.status).toBe(302)
    const inviteCookie = extractCookie(friendVisit.headers.getSetCookie(), 'invite')
    expect(inviteCookie).toBe(gen.token)
    expect(friendVisit.headers.get('location')).toBe('/auth/google/start')

    // Step 4: friend completes Google OAuth carrying the invite cookie.
    server.stop()
    const friendDeps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: [OWNER_EMAIL],
      ownerEmail: OWNER_EMAIL,
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      publicUrl: 'http://localhost',
      googleFetcher: googleFetcher({
        sub: 'g-friend',
        email: 'Friend@Example.com',
        name: 'Friend',
      }),
    }
    server = await startServer(friendDeps)
    baseUrl = `http://127.0.0.1:${server.port}`

    const friendCallback = await runOAuth(
      baseUrl,
      friendDeps.googleFetcher!,
      `invite=${gen.token}`,
    )
    expect(friendCallback.status).toBe(302)
    expect(friendCallback.session).not.toBeNull()
    // Confirm the access-denied path was NOT taken: there's a session.

    // Step 5: friend's /me reports their identity (and is_owner=false).
    const meR = await fetch(`${baseUrl}/me`, {
      headers: { cookie: `session=${friendCallback.session}` },
    })
    const me = (await meR.json()) as {
      email: string
      is_owner: boolean
    }
    expect(me.email.toLowerCase()).toBe('friend@example.com')
    expect(me.is_owner).toBe(false)
  })

  test('opening the same invite twice → first wins, second 410', async () => {
    await start({ allowlist: [OWNER_EMAIL], ownerEmail: OWNER_EMAIL })
    const ownerLogin = await runOAuth(
      baseUrl,
      googleFetcher({ sub: 'g-owner', email: OWNER_EMAIL, name: 'Owner' }),
    )
    const genR = await fetch(`${baseUrl}/admin/invites`, {
      method: 'POST',
      headers: { cookie: `session=${ownerLogin.session}` },
    })
    const gen = (await genR.json()) as { token: string }

    // Friend #1 consumes the invite (full flow with a fresh server).
    server.stop()
    const f1Deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: [OWNER_EMAIL],
      ownerEmail: OWNER_EMAIL,
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      publicUrl: 'http://localhost',
      googleFetcher: googleFetcher({
        sub: 'g-f1',
        email: 'f1@example.com',
        name: 'Friend One',
      }),
    }
    server = await startServer(f1Deps)
    baseUrl = `http://127.0.0.1:${server.port}`
    const f1 = await runOAuth(baseUrl, f1Deps.googleFetcher!, `invite=${gen.token}`)
    expect(f1.session).not.toBeNull()

    // Friend #2 tries to open the same invite link → 410 Gone.
    const f2Visit = await fetch(`${baseUrl}/invite/${gen.token}`, {
      redirect: 'manual',
    })
    expect(f2Visit.status).toBe(410)
  })

  test('/admin/invites: 401 without owner session and without admin token', async () => {
    await start({ allowlist: [OWNER_EMAIL] })
    expect((await fetch(`${baseUrl}/admin/invites`, { method: 'POST' })).status).toBe(401)
  })

  test('/admin/invites: 200 with X-Admin-Token even without an owner session', async () => {
    await start({ allowlist: [OWNER_EMAIL] })
    server.stop()
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: [OWNER_EMAIL],
      adminToken: 'token-abc',
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      publicUrl: 'http://localhost',
      googleFetcher: googleFetcher({
        sub: 'g-owner',
        email: OWNER_EMAIL,
        name: 'Owner',
      }),
    }
    server = await startServer(deps)
    baseUrl = `http://127.0.0.1:${server.port}`
    const r = await fetch(`${baseUrl}/admin/invites`, {
      method: 'POST',
      headers: { 'x-admin-token': 'token-abc' },
    })
    expect(r.status).toBe(200)
  })

  test('/me reports is_owner=true only for the OWNER_EMAIL session', async () => {
    await start({ allowlist: [OWNER_EMAIL], ownerEmail: OWNER_EMAIL })
    const r = await runOAuth(
      baseUrl,
      googleFetcher({ sub: 'g-owner', email: OWNER_EMAIL, name: 'Owner' }),
    )
    const me = (await fetch(`${baseUrl}/me`, {
      headers: { cookie: `session=${r.session}` },
    }).then((rr) => rr.json())) as { is_owner: boolean }
    expect(me.is_owner).toBe(true)
  })
})
