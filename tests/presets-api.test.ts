// Integration tests for preset API routes and post-processing in /upload.
// Spins up startServer with stubbed transcribe + postProcess deps so no
// real OpenAI calls are made.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerDeps } from '../src/server'
import type { GoogleFetcher } from '../src/google-oauth'
import type { TranscriptionResult } from '../src/transcribe'
import type { PostProcessResult } from '../src/transcribe'

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

function audioForm(text: string, recordedAt: string, presetId?: string): FormData {
  const fd = new FormData()
  fd.set('audio', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }), 'clip.webm')
  fd.set('recordedAt', recordedAt)
  fd.set('__stub_text', text)
  if (presetId) fd.set('presetId', presetId)
  return fd
}

describe('presets API + /upload post-processing', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  async function start(
    transcribe?: ServerDeps['transcribe'],
    postProcess?: ServerDeps['postProcess'],
  ) {
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
          text: 'raw transcript',
          usage: { audioTokens: 100, textTokens: 0, outputTokens: 10 },
        })),
      postProcess,
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-presets-'))
  })
  afterEach(async () => {
    if (server) server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  // ---- auth guard ----
  test('GET /api/presets without session → 401', async () => {
    await start()
    const r = await fetch(`${baseUrl}/api/presets`)
    expect(r.status).toBe(401)
  })

  // ---- CRUD ----
  test('GET /api/presets returns empty list + null activeId for new user', async () => {
    await start()
    const token = await signIn(baseUrl)
    const r = await fetch(`${baseUrl}/api/presets`, { headers: { cookie: `session=${token}` } })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { presets: unknown[]; activeId: string | null }
    expect(body.presets).toHaveLength(0)
    expect(body.activeId).toBeNull()
  })

  test('POST /api/presets creates preset, GET returns it', async () => {
    await start()
    const token = await signIn(baseUrl)

    const cr = await fetch(`${baseUrl}/api/presets`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'French', prompt: 'Translate to French' }),
    })
    expect(cr.status).toBe(201)
    const created = (await cr.json()) as { id: string; name: string; prompt: string }
    expect(created.id).toMatch(/^p_/)
    expect(created.name).toBe('French')
    expect(created.prompt).toBe('Translate to French')

    const lr = await fetch(`${baseUrl}/api/presets`, { headers: { cookie: `session=${token}` } })
    const list = (await lr.json()) as { presets: Array<{ id: string; name: string }>; activeId: string | null }
    expect(list.presets).toHaveLength(1)
    expect(list.presets[0]!.id).toBe(created.id)
    expect(list.activeId).toBeNull()
  })

  test('POST /api/presets without name → 400', async () => {
    await start()
    const token = await signIn(baseUrl)
    const r = await fetch(`${baseUrl}/api/presets`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', prompt: 'something' }),
    })
    expect(r.status).toBe(400)
  })

  test('POST /api/presets/active sets the active preset', async () => {
    await start()
    const token = await signIn(baseUrl)

    const cr = await fetch(`${baseUrl}/api/presets`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Summary', prompt: 'Summarize' }),
    })
    const { id } = (await cr.json()) as { id: string }

    const ar = await fetch(`${baseUrl}/api/presets/active`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    expect(ar.status).toBe(200)
    const ar_body = (await ar.json()) as { ok: boolean; activeId: string }
    expect(ar_body.activeId).toBe(id)

    // Verify it's reflected in list
    const lr = await fetch(`${baseUrl}/api/presets`, { headers: { cookie: `session=${token}` } })
    const list_body = (await lr.json()) as { activeId: string | null }
    expect(list_body.activeId).toBe(id)
  })

  test('POST /api/presets/active with null clears active', async () => {
    await start()
    const token = await signIn(baseUrl)

    const cr = await fetch(`${baseUrl}/api/presets`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', prompt: 'x' }),
    })
    const { id } = (await cr.json()) as { id: string }
    await fetch(`${baseUrl}/api/presets/active`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })

    const clearR = await fetch(`${baseUrl}/api/presets/active`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: null }),
    })
    expect(clearR.status).toBe(200)
    const lr = await fetch(`${baseUrl}/api/presets`, { headers: { cookie: `session=${token}` } })
    expect(((await lr.json()) as { activeId: string | null }).activeId).toBeNull()
  })

  test('POST /api/presets/active with unknown id → 404', async () => {
    await start()
    const token = await signIn(baseUrl)
    const r = await fetch(`${baseUrl}/api/presets/active`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'p_notexist' }),
    })
    expect(r.status).toBe(404)
  })

  test('DELETE /api/presets/:id removes the preset', async () => {
    await start()
    const token = await signIn(baseUrl)

    const cr = await fetch(`${baseUrl}/api/presets`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Temp', prompt: 'del me' }),
    })
    const { id } = (await cr.json()) as { id: string }

    const dr = await fetch(`${baseUrl}/api/presets/${id}`, {
      method: 'DELETE',
      headers: { cookie: `session=${token}` },
    })
    expect(dr.status).toBe(200)
    const dr_body = (await dr.json()) as { ok: boolean }
    expect(dr_body.ok).toBe(true)

    const lr = await fetch(`${baseUrl}/api/presets`, { headers: { cookie: `session=${token}` } })
    expect(((await lr.json()) as { presets: unknown[] }).presets).toHaveLength(0)
  })

  test('DELETE /api/presets/:id also clears it as active', async () => {
    await start()
    const token = await signIn(baseUrl)

    const cr = await fetch(`${baseUrl}/api/presets`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Active preset', prompt: 'do something' }),
    })
    const { id } = (await cr.json()) as { id: string }
    await fetch(`${baseUrl}/api/presets/active`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })

    await fetch(`${baseUrl}/api/presets/${id}`, {
      method: 'DELETE',
      headers: { cookie: `session=${token}` },
    })

    const lr = await fetch(`${baseUrl}/api/presets`, { headers: { cookie: `session=${token}` } })
    expect(((await lr.json()) as { activeId: string | null }).activeId).toBeNull()
  })

  test('DELETE /api/presets/:id not found → 404', async () => {
    await start()
    const token = await signIn(baseUrl)
    const r = await fetch(`${baseUrl}/api/presets/p_ghost`, {
      method: 'DELETE',
      headers: { cookie: `session=${token}` },
    })
    expect(r.status).toBe(404)
  })

  // ---- /upload post-processing ----

  test('/upload without presetId behaves as before — no post-processing called', async () => {
    let ppCalled = false
    await start(
      async () => ({ text: 'raw text', usage: { audioTokens: 100, textTokens: 0, outputTokens: 5 } }),
      async (): Promise<PostProcessResult> => {
        ppCalled = true
        return { text: 'post-processed' }
      },
    )
    const token = await signIn(baseUrl)
    const r = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${token}` },
      body: audioForm('raw text', '2026-05-30T10:00:00.000Z'),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { text: string }
    expect(body.text).toBe('raw text')
    expect(ppCalled).toBe(false)
  })

  test('/upload with valid presetId transforms text via postProcess stub', async () => {
    await start(
      async () => ({ text: 'привет мир', usage: { audioTokens: 100, textTokens: 0, outputTokens: 10 } }),
      async (text, _prompt): Promise<PostProcessResult> => ({
        text: `[transformed] ${text}`,
        usage: { inputTokens: 50, outputTokens: 15 },
      }),
    )
    const token = await signIn(baseUrl)

    // Create a preset
    const cr = await fetch(`${baseUrl}/api/presets`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Summarize', prompt: 'Summarize this' }),
    })
    const { id: presetId } = (await cr.json()) as { id: string }

    const r = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${token}` },
      body: audioForm('привет мир', '2026-05-30T10:00:00.000Z', presetId),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { text: string; presetId?: string }
    // The transformed text should be returned
    expect(body.text).toBe('[transformed] привет мир')
    expect(body.presetId).toBe(presetId)

    // History should store the transformed text
    const histR = await fetch(`${baseUrl}/history`, { headers: { cookie: `session=${token}` } })
    const hist = (await histR.json()) as { items: Array<{ text: string }> }
    expect(hist.items[0]!.text).toBe('[transformed] привет мир')
  })

  test('/upload with valid presetId sums both transcription + postProcess costs', async () => {
    await start(
      async () => ({
        text: 'hello',
        // 1M audio tokens = $6.00 transcription cost
        usage: { audioTokens: 1_000_000, textTokens: 0, outputTokens: 0 },
      }),
      async (_text, _prompt): Promise<PostProcessResult> => ({
        text: 'hello transformed',
        // 1M input + 1M output = $0.15 + $0.60 = $0.75
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      }),
    )
    const token = await signIn(baseUrl)

    const cr = await fetch(`${baseUrl}/api/presets`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Translate', prompt: 'Translate to French' }),
    })
    const { id: presetId } = (await cr.json()) as { id: string }

    const r = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${token}` },
      body: audioForm('hello', '2026-05-30T10:00:00.000Z', presetId),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { cost: number }
    // $6.00 transcription + $0.75 post-process = $6.75
    expect(body.cost).toBeCloseTo(6.75, 4)

    const costR = await fetch(`${baseUrl}/cost`, { headers: { cookie: `session=${token}` } })
    const cost = (await costR.json()) as { user: number; aggregate: number }
    expect(cost.user).toBeCloseTo(6.75, 4)
  })

  test('/upload with presetId for wrong user ignores the preset', async () => {
    let ppCalled = false
    await start(
      async () => ({ text: 'raw text', usage: { audioTokens: 100, textTokens: 0, outputTokens: 5 } }),
      async (): Promise<PostProcessResult> => {
        ppCalled = true
        return { text: 'post-processed' }
      },
    )
    const token = await signIn(baseUrl)

    // Upload with a totally fake / non-existent presetId
    const r = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${token}` },
      body: audioForm('raw text', '2026-05-30T10:00:00.000Z', 'p_nonexistent'),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { text: string }
    // Falls back to raw text — no post-processing
    expect(body.text).toBe('raw text')
    expect(ppCalled).toBe(false)
  })

  test('/upload: postProcess failure falls back to raw transcript gracefully', async () => {
    await start(
      async () => ({ text: 'original text', usage: { audioTokens: 100, textTokens: 0, outputTokens: 5 } }),
      async (): Promise<PostProcessResult> => {
        throw new Error('OpenAI quota exceeded')
      },
    )
    const token = await signIn(baseUrl)

    const cr = await fetch(`${baseUrl}/api/presets`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Risky', prompt: 'may fail' }),
    })
    const { id: presetId } = (await cr.json()) as { id: string }

    const r = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${token}` },
      body: audioForm('original text', '2026-05-30T10:00:00.000Z', presetId),
    })
    // Should still return 200 with the raw transcript
    expect(r.status).toBe(200)
    const body = (await r.json()) as { text: string }
    expect(body.text).toBe('original text')
  })

  test('/upload presetId at record time applies even when active preset changes later', async () => {
    // This tests the "offline record-time preset" semantic: the client sends
    // the presetId it captured at record time (even for offline-drained clips).
    let capturedPrompt = ''
    await start(
      async () => ({ text: 'input', usage: { audioTokens: 100, textTokens: 0, outputTokens: 5 } }),
      async (_text, prompt): Promise<PostProcessResult> => {
        capturedPrompt = prompt
        return { text: 'processed', usage: { inputTokens: 10, outputTokens: 5 } }
      },
    )
    const token = await signIn(baseUrl)

    // Create preset at record time
    const cr = await fetch(`${baseUrl}/api/presets`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'RecordTime', prompt: 'record-time prompt' }),
    })
    const { id: recordTimePresetId } = (await cr.json()) as { id: string }

    // Create second preset (active "now" at drain time)
    const cr2 = await fetch(`${baseUrl}/api/presets`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'DrainTime', prompt: 'drain-time prompt' }),
    })
    const { id: drainTimePresetId } = (await cr2.json()) as { id: string }
    // Set as active
    await fetch(`${baseUrl}/api/presets/active`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: drainTimePresetId }),
    })

    // Upload with the record-time presetId (not the active one)
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${token}` },
      body: audioForm('input', '2026-05-30T10:00:00.000Z', recordTimePresetId),
    })

    // The post-process call must have used the record-time prompt
    expect(capturedPrompt).toBe('record-time prompt')
    void drainTimePresetId // suppress unused variable warning
  })
})
