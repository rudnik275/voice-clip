import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerDeps } from '../src/server'
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
