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

function audioForm(text: string, recordedAt: string): FormData {
  const fd = new FormData()
  fd.set('audio', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }), 'clip.webm')
  fd.set('recordedAt', recordedAt)
  // `text` rides along only so the stub transcribe can echo something deterministic.
  fd.set('__stub_text', text)
  return fd
}

describe('upload flow: /upload + /history + /cost', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  async function start(transcribe?: ServerDeps['transcribe']) {
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com'],
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      transcribe:
        transcribe ??
        (async (_bytes: Uint8Array, _name: string): Promise<TranscriptionResult> => ({
          text: 'stubbed transcript',
          usage: { audioTokens: 1000, textTokens: 10, outputTokens: 20 },
        })),
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-upload-'))
  })
  afterEach(async () => {
    if (server) server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('POST /upload unauthenticated → 401', async () => {
    await start()
    const r = await fetch(`${baseUrl}/upload`, { method: 'POST', body: audioForm('x', '2026-05-17T10:00:00.000Z') })
    expect(r.status).toBe(401)
  })

  test('POST /upload → 200 { text, seq, recordedAt, cost }, history row + costs incremented', async () => {
    await start(async () => ({
      text: 'привет мир',
      usage: { audioTokens: 1_000_000, textTokens: 0, outputTokens: 0 },
    }))
    const token = await signIn(baseUrl)

    const up = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${token}` },
      body: audioForm('привет мир', '2026-05-17T10:00:00.000Z'),
    })
    expect(up.status).toBe(200)
    const body = (await up.json()) as { text: string; seq: number; recordedAt: string; cost: number }
    expect(body.text).toBe('привет мир')
    expect(body.seq).toBeGreaterThan(0)
    expect(body.recordedAt).toBe('2026-05-17T10:00:00.000Z')
    // 1M audio tokens @ $6/1M = $6.00
    expect(body.cost).toBeCloseTo(6.0, 6)

    // History has the row.
    const histR = await fetch(`${baseUrl}/history`, { headers: { cookie: `session=${token}` } })
    expect(histR.status).toBe(200)
    const hist = (await histR.json()) as { items: Array<{ seq: number; text: string; source: string }> }
    expect(hist.items).toHaveLength(1)
    expect(hist.items[0]?.text).toBe('привет мир')
    expect(hist.items[0]?.seq).toBe(body.seq)
    expect(hist.items[0]?.source).toBe('online')

    // Cost reflects per-user + aggregate.
    const costR = await fetch(`${baseUrl}/cost`, { headers: { cookie: `session=${token}` } })
    const cost = (await costR.json()) as { user: number; aggregate: number }
    expect(cost.user).toBeCloseTo(6.0, 6)
    expect(cost.aggregate).toBeCloseTo(6.0, 6)
  })

  test('GET /history?since=&limit= paginates with a cursor', async () => {
    await start()
    const token = await signIn(baseUrl)
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${baseUrl}/upload`, {
        method: 'POST',
        headers: { cookie: `session=${token}` },
        body: audioForm(`clip ${i}`, `2026-05-17T10:0${i}:00.000Z`),
      })
      expect(r.status).toBe(200)
    }
    const p1 = (await (
      await fetch(`${baseUrl}/history?limit=2`, { headers: { cookie: `session=${token}` } })
    ).json()) as { items: Array<{ seq: number }>; nextSince?: number }
    expect(p1.items).toHaveLength(2)
    expect(p1.nextSince).toBeDefined()

    const p2 = (await (
      await fetch(`${baseUrl}/history?limit=2&since=${p1.nextSince}`, {
        headers: { cookie: `session=${token}` },
      })
    ).json()) as { items: Array<{ seq: number }>; nextSince?: number }
    expect(p2.items).toHaveLength(2)
    // No overlap between pages.
    const s1 = new Set(p1.items.map((i) => i.seq))
    expect(p2.items.every((i) => !s1.has(i.seq))).toBe(true)
  })

  test('DELETE /history clears the user history but /cost aggregate is preserved', async () => {
    await start(async () => ({
      text: 'spend',
      usage: { audioTokens: 500_000, textTokens: 0, outputTokens: 0 },
    }))
    const token = await signIn(baseUrl)
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${token}` },
      body: audioForm('spend', '2026-05-17T10:00:00.000Z'),
    })

    const before = (await (
      await fetch(`${baseUrl}/cost`, { headers: { cookie: `session=${token}` } })
    ).json()) as { user: number; aggregate: number }
    expect(before.aggregate).toBeGreaterThan(0)

    const del = await fetch(`${baseUrl}/history`, {
      method: 'DELETE',
      headers: { cookie: `session=${token}` },
    })
    expect(del.status).toBe(200)

    const hist = (await (
      await fetch(`${baseUrl}/history`, { headers: { cookie: `session=${token}` } })
    ).json()) as { items: unknown[] }
    expect(hist.items).toHaveLength(0)

    const after = (await (
      await fetch(`${baseUrl}/cost`, { headers: { cookie: `session=${token}` } })
    ).json()) as { user: number; aggregate: number }
    expect(after.aggregate).toBeCloseTo(before.aggregate, 8)
    expect(after.user).toBeCloseTo(before.user, 8)
  })

  test('legacy /app.ts route is gone (SPA bundles live under /assets, built by Vite)', async () => {
    // The boot-time Bun.build(app.ts) serving was removed in #100 — the Vue
    // SPA is built ahead of time by `vite build` and served from web/dist/
    // under content-hashed /assets/* URLs. /app.ts no longer routes.
    await start()
    const r = await fetch(`${baseUrl}/app.ts`)
    expect(r.status).toBe(404)
  })
})
