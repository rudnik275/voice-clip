import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerDeps } from '../src/server'
import type { GoogleFetcher } from '../src/google-oauth'
import { openDb } from '../src/db'
import { createDevicesStore } from '../src/devices-store'

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const CLIENT_SECRET = 'test-secret'

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
function makeIdToken(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.sig`
}
function makeGoogleFetcher(p: Record<string, unknown>): GoogleFetcher {
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

describe('desktop pairing handshake + /download/latest', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string
  let db: ReturnType<typeof openDb>

  async function start(p: Record<string, unknown>, allowlist = ['alice@example.com']) {
    db = openDb(':memory:')
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist,
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: makeGoogleFetcher(p),
      db,
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-pairing-'))
  })
  afterEach(async () => {
    if (server) server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('GET /desktop/auth/start → 302 to Google + sets oauth_state cookie', async () => {
    await start({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const r = await fetch(`${baseUrl}/desktop/auth/start`, { redirect: 'manual' })
    expect(r.status).toBe(302)
    const location = r.headers.get('location')!
    expect(location).toContain('https://accounts.google.com/o/oauth2/v2/auth')
    expect(location).toContain('client_id=')
    expect(location).toContain('state=')
    // redirect_uri must target the desktop completion route
    expect(decodeURIComponent(location)).toContain('/desktop/auth/complete')
    const stateCookie = r.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))
    expect(stateCookie).toBeTruthy()
  })

  test('GET /desktop/auth/complete (allowlisted) → 302 voiceclip://callback?token=&state=, device row created', async () => {
    await start({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })

    const startR = await fetch(`${baseUrl}/desktop/auth/start`, { redirect: 'manual' })
    const state = startR.headers
      .getSetCookie()
      .find((c) => c.startsWith('oauth_state='))!
      .split(';')[0]!
      .split('=')[1]!

    const cbR = await fetch(`${baseUrl}/desktop/auth/complete?code=fake&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
      redirect: 'manual',
    })
    expect(cbR.status).toBe(302)
    const loc = cbR.headers.get('location')!
    expect(loc.startsWith('voiceclip://callback?')).toBe(true)
    const u = new URL(loc)
    const token = u.searchParams.get('token')!
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(u.searchParams.get('state')).toBe(state)

    // The device row exists and its token matches the deep-link token.
    const devices = createDevicesStore(db)
    const dev = devices.findByToken(token)
    expect(dev).not.toBeNull()
    // No session cookie is set for the desktop flow.
    const sessionCookie = cbR.headers.getSetCookie().find((c) => c.startsWith('session='))
    expect(sessionCookie).toBeUndefined()
  })

  test('GET /desktop/auth/complete (NON-allowlisted) → 403, NO device created', async () => {
    await start({ sub: 'g2', email: 'evil@example.com', name: 'Evil' }, ['alice@example.com'])

    const startR = await fetch(`${baseUrl}/desktop/auth/start`, { redirect: 'manual' })
    const state = startR.headers
      .getSetCookie()
      .find((c) => c.startsWith('oauth_state='))!
      .split(';')[0]!
      .split('=')[1]!

    const cbR = await fetch(`${baseUrl}/desktop/auth/complete?code=fake&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
      redirect: 'manual',
    })
    expect(cbR.status).toBe(403)
    expect(cbR.headers.get('location')).toBeNull()

    const rows = db.query('SELECT COUNT(*) AS n FROM devices').get() as { n: number }
    expect(rows.n).toBe(0)
  })

  test('GET /desktop/auth/complete with mismatched state → 400, no device', async () => {
    await start({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const r = await fetch(`${baseUrl}/desktop/auth/complete?code=fake&state=bogus`, {
      headers: { cookie: 'oauth_state=different' },
      redirect: 'manual',
    })
    expect(r.status).toBe(400)
    const rows = db.query('SELECT COUNT(*) AS n FROM devices').get() as { n: number }
    expect(rows.n).toBe(0)
  })

  test('GET /download/latest → 302 to GitHub Releases latest .dmg', async () => {
    await start({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const r = await fetch(`${baseUrl}/download/latest`, { redirect: 'manual' })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe(
      'https://github.com/rudnik275/voice-clip/releases/latest/download/voice-clip.dmg',
    )
  })

  test('GET /desktop/update.json (unauthenticated) → 302 to latest.json', async () => {
    await start({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const r = await fetch(`${baseUrl}/desktop/update.json`, { redirect: 'manual' })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe(
      'https://github.com/rudnik275/voice-clip/releases/latest/download/latest.json',
    )
  })

  test('pairing triggers lazy prune: stale device gone after second pairing >60d later', async () => {
    // Use a controllable clock so we can simulate >60 days elapsing.
    // Start at a fixed epoch.
    let clock = 1_000_000_000_000

    db = openDb(':memory:')
    const googleFetcher = makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com'],
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher,
      db,
      now: () => clock,
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`

    // First pairing at t=0.
    const startR1 = await fetch(`${baseUrl}/desktop/auth/start`, { redirect: 'manual' })
    const state1 = startR1.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))!.split(';')[0]!.split('=')[1]!
    const cb1 = await fetch(`${baseUrl}/desktop/auth/complete?code=fake&state=${state1}`, {
      headers: { cookie: `oauth_state=${state1}` },
      redirect: 'manual',
    })
    expect(cb1.status).toBe(302)
    const token1 = new URL(cb1.headers.get('location')!).searchParams.get('token')!
    const devices = createDevicesStore(db)
    expect(devices.findByToken(token1)).not.toBeNull()

    // Advance clock by 61 days (past the 60-day staleness window).
    clock += 61 * 24 * 60 * 60 * 1000

    // Two pairings within 24h of each other: only one prune should fire.
    // Second pairing triggers the prune (clock advanced >24h since last prune).
    const startR2 = await fetch(`${baseUrl}/desktop/auth/start`, { redirect: 'manual' })
    const state2 = startR2.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))!.split(';')[0]!.split('=')[1]!
    const cb2 = await fetch(`${baseUrl}/desktop/auth/complete?code=fake&state=${state2}`, {
      headers: { cookie: `oauth_state=${state2}` },
      redirect: 'manual',
    })
    expect(cb2.status).toBe(302)

    // The stale first device must have been pruned.
    expect(devices.findByToken(token1)).toBeNull()
  })

  test('pairing within 24h of a previous prune does not prune again', async () => {
    let clock = 1_000_000_000_000

    db = openDb(':memory:')
    const googleFetcher = makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com'],
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher,
      db,
      now: () => clock,
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`

    // First pairing triggers first prune (nothing to prune yet).
    const startR1 = await fetch(`${baseUrl}/desktop/auth/start`, { redirect: 'manual' })
    const state1 = startR1.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))!.split(';')[0]!.split('=')[1]!
    await fetch(`${baseUrl}/desktop/auth/complete?code=fake&state=${state1}`, {
      headers: { cookie: `oauth_state=${state1}` },
      redirect: 'manual',
    })

    // Advance only 1 hour — below the 24h prune interval.
    clock += 60 * 60 * 1000

    // Second pairing within the same 24h window — prune guard fires, no DB sweep.
    const startR2 = await fetch(`${baseUrl}/desktop/auth/start`, { redirect: 'manual' })
    const state2 = startR2.headers.getSetCookie().find((c) => c.startsWith('oauth_state='))!.split(';')[0]!.split('=')[1]!
    const cb2 = await fetch(`${baseUrl}/desktop/auth/complete?code=fake&state=${state2}`, {
      headers: { cookie: `oauth_state=${state2}` },
      redirect: 'manual',
    })
    // Second pairing must still succeed regardless of the prune guard.
    expect(cb2.status).toBe(302)

    // Both devices should still exist (nothing was old enough to prune).
    const devices = createDevicesStore(db)
    expect(devices.list(
      devices.findByToken(new URL(cb2.headers.get('location')!).searchParams.get('token')!)!.user_id
    )).toHaveLength(2)
  })
})
