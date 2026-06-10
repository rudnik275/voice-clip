import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerDeps } from '../src/server'
import type { GoogleFetcher } from '../src/google-oauth'
import { openDb } from '../src/db'
import { createDevicesStore } from '../src/devices-store'

// The PWA-facing routes /me, /upload, /history, /cost used to require a
// session cookie. The Tauri desktop app now records voice on the Mac too,
// so it needs the same routes — but it carries its Keychain-stored
// device_token, not a session cookie. This file pins the dual-auth shape:
// either credential should resolve the same user.

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const CLIENT_SECRET = 'test-secret'

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
function makeIdToken(p: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(p))}.sig`
}
function googleFetcherFor(p: Record<string, unknown>): GoogleFetcher {
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

describe('device-token auth on PWA routes', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string
  let db: ReturnType<typeof openDb>
  let deviceToken: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-devauth-'))
    db = openDb(':memory:')
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com'],
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: googleFetcherFor({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      db,
      transcribe: async () => ({
        text: 'transcribed text',
        usage: { audioTokens: 100, textTokens: 10, outputTokens: 20 },
      }),
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`

    // Pair a Tauri device for Alice and stash its token.
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
    deviceToken = new URL(cbR.headers.get('location')!).searchParams.get('token')!
    const dev = createDevicesStore(db).findByToken(deviceToken)
    expect(dev).not.toBeNull()
  })

  afterEach(async () => {
    if (server) server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('/me returns the device owner when called with X-Device-Token', async () => {
    const r = await fetch(`${baseUrl}/me`, { headers: { 'X-Device-Token': deviceToken } })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { email: string; name: string }
    expect(body.email).toBe('alice@example.com')
    expect(body.name).toBe('Alice')
  })

  test('/me without any credential is 401', async () => {
    const r = await fetch(`${baseUrl}/me`)
    expect(r.status).toBe(401)
  })

  test('/me with a bogus device token is 401', async () => {
    const r = await fetch(`${baseUrl}/me`, { headers: { 'X-Device-Token': 'a'.repeat(64) } })
    expect(r.status).toBe(401)
  })

  test('/upload accepts X-Device-Token (transcribes + lands in history)', async () => {
    const form = new FormData()
    form.append('audio', new Blob(['fake-bytes'], { type: 'audio/webm' }), 'clip.webm')
    form.append('source', 'online')
    form.append('recordedAt', new Date().toISOString())
    const up = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { 'X-Device-Token': deviceToken },
      body: form,
    })
    expect(up.status).toBe(200)
    const body = (await up.json()) as { text: string }
    expect(body.text).toBe('transcribed text')

    // History should now contain that clip — fetched via the same token.
    const hist = await fetch(`${baseUrl}/history`, { headers: { 'X-Device-Token': deviceToken } })
    expect(hist.status).toBe(200)
    const histBody = (await hist.json()) as { items: { text: string }[] }
    expect(histBody.items.length).toBe(1)
    expect(histBody.items[0]?.text).toBe('transcribed text')
  })

  test('/cost returns user + aggregate totals via device token', async () => {
    const r = await fetch(`${baseUrl}/cost`, { headers: { 'X-Device-Token': deviceToken } })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { user: number; aggregate: number }
    expect(typeof body.user).toBe('number')
    expect(typeof body.aggregate).toBe('number')
  })

  test('device_token works as a URL query param too (parity with /events)', async () => {
    const r = await fetch(`${baseUrl}/me?device_token=${deviceToken}`)
    expect(r.status).toBe(200)
  })

  test('/devices lists the calling user\'s paired Macs via device token', async () => {
    const r = await fetch(`${baseUrl}/devices`, { headers: { 'X-Device-Token': deviceToken } })
    expect(r.status).toBe(200)
    const list = (await r.json()) as Array<{ id: string }>
    expect(list.length).toBeGreaterThanOrEqual(1)
  })

  test('/events authenticates via X-Device-Token header (header-first precedence)', async () => {
    // The SSE stream is long-lived; just check that the connection is accepted
    // (2xx) when the token is in the header. We abort immediately — we only
    // need the status code, not the stream body.
    const ctrl = new AbortController()
    const r = await fetch(`${baseUrl}/events`, {
      headers: { 'X-Device-Token': deviceToken },
      signal: ctrl.signal,
    }).catch((e: Error) => {
      // AbortError is expected when we cancel immediately after headers arrive.
      if (e.name === 'AbortError') return null
      throw e
    })
    if (r !== null) {
      expect(r.status).toBe(200)
      ctrl.abort()
    }
    // If r is null the abort fired before we could check, which still means
    // the connection was accepted (no 401/403 before abort).
  })

  test('/events without any token is 401', async () => {
    const r = await fetch(`${baseUrl}/events`)
    expect(r.status).toBe(401)
  })

  test('/events still accepts ?device_token= query param (back-compat)', async () => {
    const ctrl = new AbortController()
    const r = await fetch(`${baseUrl}/events?device_token=${deviceToken}`, {
      signal: ctrl.signal,
    }).catch((e: Error) => {
      if (e.name === 'AbortError') return null
      throw e
    })
    if (r !== null) {
      expect(r.status).toBe(200)
      ctrl.abort()
    }
  })

  test('header takes precedence over query param when both are present', async () => {
    // Header = valid token; query param = bogus → should authenticate via header.
    const ctrl = new AbortController()
    const r = await fetch(`${baseUrl}/me?device_token=bogustoken`, {
      headers: { 'X-Device-Token': deviceToken },
      signal: ctrl.signal,
    }).catch((e: Error) => {
      if (e.name === 'AbortError') return null
      throw e
    })
    if (r !== null) {
      expect(r.status).toBe(200)
      ctrl.abort()
    }
  })
})

describe('CORS for Tauri-webview cross-origin requests', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-cors-'))
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
  })

  afterEach(async () => {
    if (server) server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('OPTIONS preflight from tauri://localhost returns 204 + Allow-* headers', async () => {
    const r = await fetch(`${baseUrl}/me`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'tauri://localhost',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-Device-Token',
      },
    })
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-origin')).toBe('tauri://localhost')
    expect(r.headers.get('access-control-allow-methods')).toContain('GET')
    expect(r.headers.get('access-control-allow-headers')).toContain('X-Device-Token')
    // PWA fetches pass credentials:'include' which the Tauri webview honours.
    // Without Allow-Credentials the browser blocks the request before it leaves.
    expect(r.headers.get('access-control-allow-credentials')).toBe('true')
  })

  test('Tauri-origin GET response carries Allow-Origin + Allow-Credentials', async () => {
    const r = await fetch(`${baseUrl}/version`, { headers: { Origin: 'tauri://localhost' } })
    expect(r.status).toBe(200)
    expect(r.headers.get('access-control-allow-origin')).toBe('tauri://localhost')
    expect(r.headers.get('access-control-allow-credentials')).toBe('true')
    expect(r.headers.get('vary')?.toLowerCase()).toContain('origin')
  })

  test('Non-Tauri Origin (the PWA itself) does NOT get the CORS header', async () => {
    // PWA's same-origin requests don't carry Origin from the same host
    // we serve from, but cross-origin curl-style probing should be
    // refused unless from a Tauri scheme.
    const r = await fetch(`${baseUrl}/version`, { headers: { Origin: 'https://evil.example.com' } })
    expect(r.status).toBe(200)
    expect(r.headers.get('access-control-allow-origin')).toBeNull()
  })
})
