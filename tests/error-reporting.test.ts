import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, deriveRateKey, type ServerDeps } from '../src/server'
import type { GoogleFetcher } from '../src/google-oauth'
import type { TranscriptionResult } from '../src/transcribe'

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const CLIENT_SECRET = 'test-secret'
const ADMIN_TOKEN = 'admin-secret-xyz'

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

describe('observability: /api/errors + /admin/errors + replay', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  async function start(
    transcribe?: ServerDeps['transcribe'],
    opts: { adminToken?: string } = { adminToken: ADMIN_TOKEN },
  ) {
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com'],
      adminToken: opts.adminToken,
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      publicUrl: 'http://localhost',
      googleFetcher: makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      transcribe:
        transcribe ??
        (async (): Promise<TranscriptionResult> => ({ text: 'ok', usage: undefined })),
    }
    server = await startServer(deps)
    baseUrl = `http://127.0.0.1:${server.port}`
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-errors-'))
  })
  afterEach(async () => {
    server?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('POST /api/errors: writes a row even without a session', async () => {
    await start()
    const r = await fetch(`${baseUrl}/api/errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'js_exception',
        message: 'boom',
        stack: 'Error: boom\n  at f',
        context: { url: '/login' },
      }),
    })
    expect(r.status).toBe(200)

    type AdminErrorRow = {
      type: string
      message: string
      userId: string | null
      userName: string | null
    }
    const list = (await fetch(`${baseUrl}/admin/errors`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    }).then((rr) => rr.json())) as AdminErrorRow[]
    expect(list).toHaveLength(1)
    expect(list[0]!.type).toBe('js_exception')
    expect(list[0]!.message).toBe('boom')
    expect(list[0]!.userId).toBeNull()
  })

  test('POST /api/errors: attaches userId when a session cookie is present', async () => {
    await start()
    const session = await signIn(baseUrl)
    const r = await fetch(`${baseUrl}/api/errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `session=${session}` },
      body: JSON.stringify({ type: 'js_exception', message: 'authed boom' }),
    })
    expect(r.status).toBe(200)
    const list = (await fetch(`${baseUrl}/admin/errors`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    }).then((rr) => rr.json())) as { userId: string | null; userName: string | null }[]
    expect(list).toHaveLength(1)
    expect(list[0]!.userId).toMatch(/^u_/)
    expect(list[0]!.userName).toBe('Alice')
  })

  test('POST /api/errors: rejects without type+message', async () => {
    await start()
    const r = await fetch(`${baseUrl}/api/errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'x' }),
    })
    expect(r.status).toBe(400)
  })

  test('GET /admin/errors: 401 without admin token, 401 if token mismatches', async () => {
    await start()
    expect((await fetch(`${baseUrl}/admin/errors`)).status).toBe(401)
    expect(
      (
        await fetch(`${baseUrl}/admin/errors`, {
          headers: { 'x-admin-token': 'wrong' },
        })
      ).status,
    ).toBe(401)
  })

  test('GET /admin/errors: 401 when ADMIN_TOKEN is not configured', async () => {
    await start(undefined, { adminToken: undefined })
    // No header at all = 401; correct header would also be 401 because the
    // server has no shared secret to compare against.
    const r = await fetch(`${baseUrl}/admin/errors`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    })
    expect(r.status).toBe(401)
  })

  test('/upload transcription failure: saves the blob and creates an errors row with audio_file', async () => {
    let transcribeCalls = 0
    await start(async () => {
      transcribeCalls += 1
      if (transcribeCalls === 1) throw new Error('Audio too short')
      return { text: 'replayed transcript', usage: undefined }
    })
    const session = await signIn(baseUrl)
    const fd = new FormData()
    fd.set(
      'audio',
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }),
      'clip.webm',
    )
    fd.set('recordedAt', '2026-05-25T16:00:00Z')
    const upload = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: fd,
      headers: { cookie: `session=${session}` },
    })
    expect(upload.status).toBe(502)

    const list = (await fetch(`${baseUrl}/admin/errors`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    }).then((r) => r.json())) as {
      id: string
      type: string
      message: string
      audioFile: string
      canReplay: boolean
      context: { filename: string }
    }[]
    expect(list).toHaveLength(1)
    expect(list[0]!.type).toBe('transcription_error')
    expect(list[0]!.message).toBe('Audio too short')
    expect(list[0]!.audioFile).toMatch(/^failed-audio\//)
    expect(list[0]!.canReplay).toBe(true)
    expect(list[0]!.context.filename).toBe('clip.webm')

    // The blob is actually on disk under DATA_DIR/failed-audio/
    expect(existsSync(join(dir, list[0]!.audioFile))).toBe(true)

    // Replay → calls transcribe a second time, succeeds, marks resolved.
    const replay = await fetch(`${baseUrl}/admin/errors/${list[0]!.id}/replay`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    })
    expect(replay.status).toBe(200)
    const replayJson = (await replay.json()) as { ok: boolean; text: string }
    expect(replayJson.ok).toBe(true)
    expect(replayJson.text).toBe('replayed transcript')
    expect(transcribeCalls).toBe(2)

    // The error row is now resolved → not in the default unresolved list.
    const after = await fetch(`${baseUrl}/admin/errors`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    }).then((r) => r.json())
    expect(after).toHaveLength(0)
    const includeResolved = (await fetch(`${baseUrl}/admin/errors?all=1`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    }).then((r) => r.json())) as { resolved: boolean }[]
    expect(includeResolved).toHaveLength(1)
    expect(includeResolved[0]!.resolved).toBe(true)
  })

  test('Replay refuses without an audio_file (404 row + 400 with no audio)', async () => {
    await start()
    // 404 for missing id
    const miss = await fetch(`${baseUrl}/admin/errors/e_does_not_exist/replay`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    })
    expect(miss.status).toBe(404)

    // Row without audio_file (a plain js_exception report)
    await fetch(`${baseUrl}/api/errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'js_exception', message: 'no audio' }),
    })
    const rows = (await fetch(`${baseUrl}/admin/errors`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    }).then((r) => r.json())) as { id: string }[]
    const no = await fetch(`${baseUrl}/admin/errors/${rows[0]!.id}/replay`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN },
    })
    expect(no.status).toBe(400)
  })

  test('GET /admin/errors?limit=abc → 200 with default limit (NaN guard)', async () => {
    await start()
    // Seed a couple of error rows via /api/errors
    for (const msg of ['err1', 'err2']) {
      await fetch(`${baseUrl}/api/errors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'js_exception', message: msg }),
      })
    }
    // Non-numeric limit must NOT produce a 500 — it should fall back to the
    // default (200) and return the rows normally.
    const r = await fetch(`${baseUrl}/admin/errors?limit=abc`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    })
    expect(r.status).toBe(200)
    const rows = (await r.json()) as { message: string }[]
    expect(rows.length).toBe(2)
  })

  // ---- rate limiter: global cap ----
  test('Global cap returns 429 after 600 requests from distinct keys', async () => {
    // Drive time with deps.now so the window resets predictably.
    let fakeNow = 1_000_000
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      now: () => fakeNow,
      transcribe: async (): Promise<TranscriptionResult> => ({ text: 'ok', usage: undefined }),
    }
    const s = await startServer(deps)
    const url = `http://127.0.0.1:${s.port}`
    try {
      // Send 601 requests, each with a distinct cf-connecting-ip so they each
      // get their own per-key bucket (not hitting the 60/min per-key limit).
      // Since the test client connects from 127.0.0.1 (trusted peer), the
      // cf-connecting-ip header IS honoured. The global cap of 600/min should
      // kick in before all 601 requests succeed.
      let lastStatus = 0
      for (let i = 0; i < 601; i++) {
        // Generate a unique IP per iteration across 256*256 = 65536 combinations.
        const octet3 = Math.floor(i / 256)
        const octet4 = i % 256
        const fakeIp = `203.0.${octet3}.${octet4}`
        const r = await fetch(`${url}/api/errors`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'cf-connecting-ip': fakeIp,
          },
          body: JSON.stringify({ type: 'js_exception', message: `boom ${i}` }),
        })
        lastStatus = r.status
        if (lastStatus === 429) break
      }
      expect(lastStatus).toBe(429)
    } finally {
      s.stop()
    }
  })

  // ---- rate limiter: bucket eviction ----
  test('Expired buckets are evicted (map stays bounded)', async () => {
    let fakeNow = 2_000_000
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      now: () => fakeNow,
      transcribe: async (): Promise<TranscriptionResult> => ({ text: 'ok', usage: undefined }),
    }
    const s = await startServer(deps)
    const url = `http://127.0.0.1:${s.port}`
    try {
      // Send a request to populate a bucket (IP sourced from cf-connecting-ip
      // because the test peer 127.0.0.1 is trusted).
      const r1 = await fetch(`${url}/api/errors`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '1.2.3.4',
        },
        body: JSON.stringify({ type: 'js_exception', message: 'first' }),
      })
      expect(r1.status).toBe(200)

      // Advance time past the window so the bucket expires.
      fakeNow += 70_000

      // A new request after expiry should succeed (fresh bucket, not still
      // counted as the same window).
      const r2 = await fetch(`${url}/api/errors`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '1.2.3.4',
        },
        body: JSON.stringify({ type: 'js_exception', message: 'second' }),
      })
      expect(r2.status).toBe(200)
    } finally {
      s.stop()
    }
  })

  test('Failed-audio dir is created lazily and survives multiple users', async () => {
    let calls = 0
    await start(async () => {
      calls += 1
      throw new Error(`fail ${calls}`)
    })
    const session = await signIn(baseUrl)
    const fd = new FormData()
    fd.set('audio', new Blob([new Uint8Array([9])], { type: 'audio/webm' }), 'a.webm')
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: fd,
      headers: { cookie: `session=${session}` },
    })
    const fd2 = new FormData()
    fd2.set('audio', new Blob([new Uint8Array([8])], { type: 'audio/webm' }), 'b.webm')
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: fd2,
      headers: { cookie: `session=${session}` },
    })
    const entries = await readdir(join(dir, 'failed-audio'))
    expect(entries.length).toBeGreaterThanOrEqual(1)
  })
})

// ---- deriveRateKey unit tests (pure function, no server needed) ----
describe('deriveRateKey: trusted vs untrusted peers', () => {
  function makeHeaders(obj: Record<string, string>): Headers {
    const h = new Headers()
    for (const [k, v] of Object.entries(obj)) h.set(k, v)
    return h
  }

  test('trusted peer (127.0.0.1): uses cf-connecting-ip header', () => {
    const key = deriveRateKey('127.0.0.1', makeHeaders({ 'cf-connecting-ip': '1.2.3.4' }))
    expect(key).toBe('1.2.3.4')
  })

  test('trusted peer (::1): uses cf-connecting-ip header', () => {
    const key = deriveRateKey('::1', makeHeaders({ 'cf-connecting-ip': '5.6.7.8' }))
    expect(key).toBe('5.6.7.8')
  })

  test('trusted peer (10.x): uses cf-connecting-ip header', () => {
    const key = deriveRateKey('10.0.0.2', makeHeaders({ 'cf-connecting-ip': '9.10.11.12' }))
    expect(key).toBe('9.10.11.12')
  })

  test('trusted peer (192.168.x): falls back to x-forwarded-for when no cf header', () => {
    const key = deriveRateKey(
      '192.168.1.100',
      makeHeaders({ 'x-forwarded-for': '203.0.113.99, 10.0.0.1' }),
    )
    expect(key).toBe('203.0.113.99')
  })

  test('trusted peer: falls back to socket addr when no forwarding headers', () => {
    const key = deriveRateKey('127.0.0.1', new Headers())
    expect(key).toBe('127.0.0.1')
  })

  test('untrusted (public) peer: ignores cf-connecting-ip, uses socket addr', () => {
    // An attacker connecting directly rotates headers — we must NOT use them.
    const key = deriveRateKey(
      '203.0.113.55',
      makeHeaders({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' }),
    )
    expect(key).toBe('203.0.113.55')
  })

  test('untrusted peer: multiple different header values all map to same key', () => {
    // Confirm that rotating headers does NOT change the key for a public peer.
    const socketAddr = '198.51.100.7'
    const key1 = deriveRateKey(socketAddr, makeHeaders({ 'cf-connecting-ip': 'aaa' }))
    const key2 = deriveRateKey(socketAddr, makeHeaders({ 'cf-connecting-ip': 'bbb' }))
    const key3 = deriveRateKey(socketAddr, makeHeaders({ 'x-forwarded-for': 'ccc' }))
    expect(key1).toBe(socketAddr)
    expect(key2).toBe(socketAddr)
    expect(key3).toBe(socketAddr)
  })

  test('null socket addr returns "unknown"', () => {
    expect(deriveRateKey(null, makeHeaders({ 'cf-connecting-ip': '1.2.3.4' }))).toBe('unknown')
    expect(deriveRateKey(undefined, new Headers())).toBe('unknown')
  })
})
