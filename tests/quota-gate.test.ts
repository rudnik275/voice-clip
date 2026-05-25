import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerDeps } from '../src/server'
import type { GoogleFetcher } from '../src/google-oauth'
import type { TranscriptionResult } from '../src/transcribe'

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const CLIENT_SECRET = 'test-secret'

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

async function signIn(baseUrl: string): Promise<string> {
  const startR = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' })
  const state = startR.headers
    .getSetCookie()
    .find((c) => c.startsWith('oauth_state='))!
    .split(';')[0]!
    .split('=')[1]!
  const cbR = await fetch(`${baseUrl}/auth/google/callback?code=fake&state=${state}`, {
    headers: { cookie: `oauth_state=${state}` },
    redirect: 'manual',
  })
  return cbR.headers
    .getSetCookie()
    .find((c) => c.startsWith('session='))!
    .split(';')[0]!
    .split('=')[1]!
}

function audioForm(): FormData {
  const fd = new FormData()
  fd.set('audio', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }), 'clip.webm')
  fd.set('recordedAt', new Date().toISOString())
  return fd
}

describe('quota gate (free tier monthly limit)', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  async function start(limit: number) {
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com'],
      freeTierMonthlyLimit: limit,
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      publicUrl: 'http://localhost',
      googleFetcher: googleFetcher({
        sub: 'g1',
        email: 'alice@example.com',
        name: 'Alice',
      }),
      transcribe: async (): Promise<TranscriptionResult> => ({ text: 'stub', usage: undefined }),
    }
    server = await startServer(deps)
    baseUrl = `http://127.0.0.1:${server.port}`
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-quota-'))
  })
  afterEach(async () => {
    server?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('free user under the cap can upload', async () => {
    await start(3)
    const s = await signIn(baseUrl)
    const r = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${s}` },
      body: audioForm(),
    })
    expect(r.status).toBe(200)
  })

  test('free user at the cap is refused with 402 + usage payload', async () => {
    await start(2)
    const s = await signIn(baseUrl)
    expect((await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { cookie: `session=${s}` }, body: audioForm() })).status).toBe(200)
    expect((await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { cookie: `session=${s}` }, body: audioForm() })).status).toBe(200)
    const blocked = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${s}` },
      body: audioForm(),
    })
    expect(blocked.status).toBe(402)
    const body = (await blocked.json()) as { code: string; used: number; limit: number; plan: string }
    expect(body.code).toBe('quota_exceeded')
    expect(body.plan).toBe('free')
    expect(body.used).toBe(2)
    expect(body.limit).toBe(2)
  })

  test('/me reports current usage + free_monthly_limit', async () => {
    await start(5)
    const s = await signIn(baseUrl)
    await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { cookie: `session=${s}` }, body: audioForm() })
    const me = (await fetch(`${baseUrl}/me`, { headers: { cookie: `session=${s}` } }).then((r) => r.json())) as {
      plan: string
      usage: { clips_this_month: number; free_monthly_limit: number | null }
    }
    expect(me.plan).toBe('free')
    expect(me.usage.clips_this_month).toBe(1)
    expect(me.usage.free_monthly_limit).toBe(5)
  })

  test('limit=0 disables the gate (unlimited free)', async () => {
    await start(0)
    const s = await signIn(baseUrl)
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${baseUrl}/upload`, {
        method: 'POST',
        headers: { cookie: `session=${s}` },
        body: audioForm(),
      })
      expect(r.status).toBe(200)
    }
  })

  test('Pro plan bypasses the cap (set via plans store before upload)', async () => {
    await start(1)
    const s = await signIn(baseUrl)
    // First upload uses the slot; second would normally 402.
    expect((await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { cookie: `session=${s}` }, body: audioForm() })).status).toBe(200)

    // Promote the user to Pro via /me to find the id, then mutate via deps.
    // (No public setPlan endpoint yet — the test reaches in directly.)
    const me = (await fetch(`${baseUrl}/me`, { headers: { cookie: `session=${s}` } }).then((r) => r.json())) as { id: string }
    server.stop()
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com'],
      freeTierMonthlyLimit: 1,
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      publicUrl: 'http://localhost',
      googleFetcher: googleFetcher({
        sub: 'g1',
        email: 'alice@example.com',
        name: 'Alice',
      }),
      transcribe: async (): Promise<TranscriptionResult> => ({ text: 'stub', usage: undefined }),
    }
    server = await startServer(deps)
    baseUrl = `http://127.0.0.1:${server.port}`
    // Sign in again on the new server (same DATA_DIR → same sqlite file).
    const s2 = await signIn(baseUrl)

    // Direct DB poke: we don't have a public endpoint to flip plan yet, but
    // the same DATA_DIR persistence means we can shell into the store the
    // same way. Reach for the bun:sqlite Database directly.
    const { Database } = await import('bun:sqlite')
    const sqlite = new Database(join(dir, 'voice-clip.sqlite'))
    sqlite.prepare(
      `INSERT INTO user_plans (user_id, plan, updated_at)
       VALUES (?, 'pro', ?)
       ON CONFLICT(user_id) DO UPDATE SET plan='pro'`,
    ).run(me.id, Date.now())
    sqlite.close()

    // Now Pro → quota check skipped, more uploads succeed.
    const r2 = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${s2}` },
      body: audioForm(),
    })
    expect(r2.status).toBe(200)
  })

  test('/pro page renders with brutalism CTA', async () => {
    await start(10)
    const r = await fetch(`${baseUrl}/pro`)
    expect(r.status).toBe(200)
    const html = await r.text()
    expect(html).toContain('Get')
    expect(html).toContain('$5')
    expect(html).toContain('Coming soon')
  })
})
