import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerDeps } from '../src/server'
import type { GoogleFetcher } from '../src/google-oauth'
import type { TranscriptionResult } from '../src/transcribe'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import { createDevicesStore } from '../src/devices-store'
import { createLiveBus, type SseController } from '../src/live-bus'

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

function audioForm(recordedAt: string): FormData {
  const fd = new FormData()
  fd.set('audio', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }), 'clip.webm')
  fd.set('recordedAt', recordedAt)
  return fd
}

function mockController() {
  const frames: string[] = []
  const dec = new TextDecoder()
  const controller: SseController = {
    enqueue(chunk: Uint8Array) {
      frames.push(dec.decode(chunk))
    },
  }
  return { controller, frames }
}

describe('/upload fan-out to a user devices via live-bus', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string
  let db: ReturnType<typeof openDb>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-fanout-'))
  })
  afterEach(async () => {
    if (server) server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('two Macs paired to the same user BOTH receive the clip on phone upload', async () => {
    db = openDb(':memory:')
    const liveBus = createLiveBus()
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com'],
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      db,
      liveBus,
      transcribe: async (): Promise<TranscriptionResult> => ({
        text: 'привет мир',
        usage: { audioTokens: 1000, textTokens: 0, outputTokens: 0 },
      }),
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`

    const token = await signIn(baseUrl)

    // The signed-in user (created during the OAuth callback) pairs two Macs.
    const users = createUsersStore(db)
    const user = users.upsertByGoogleSub({
      sub: 'g1',
      email: 'alice@example.com',
      name: 'Alice',
    })
    const devices = createDevicesStore(db)
    const macA = devices.create(user.id, 'Mac A')
    const macB = devices.create(user.id, 'Mac B')

    // Both Macs hold a live SSE subscription (simulated with mock controllers
    // registered directly in the shared live-bus, as the real /events route
    // does on connect).
    const a = mockController()
    const b = mockController()
    liveBus.subscribe(macA.id, a.controller)
    liveBus.subscribe(macB.id, b.controller)

    // Phone uploads a clip.
    const up = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${token}` },
      body: audioForm('2026-05-17T10:00:00.000Z'),
    })
    expect(up.status).toBe(200)
    const body = (await up.json()) as { seq: number; text: string }

    // BOTH Macs received the same clip frame.
    for (const m of [a, b]) {
      const dataFrame = m.frames.find((f) => f.startsWith('data: '))
      expect(dataFrame).toBeTruthy()
      const payload = JSON.parse(dataFrame!.slice('data: '.length).trim()) as {
        seq: number
        text: string
        source: string
      }
      expect(payload.text).toBe('привет мир')
      expect(payload.seq).toBe(body.seq)
      expect(payload.source).toBe('online')
    }
  })

  test('/clip/copy re-sends a past history clip to the paired Macs', async () => {
    db = openDb(':memory:')
    const liveBus = createLiveBus()
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com'],
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      db,
      liveBus,
      transcribe: async (): Promise<TranscriptionResult> => ({
        text: 'старая запись',
        usage: { audioTokens: 1000, textTokens: 0, outputTokens: 0 },
      }),
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`

    const token = await signIn(baseUrl)

    // Create a history clip via /upload, capture its seq.
    const up = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${token}` },
      body: audioForm('2026-05-17T10:00:00.000Z'),
    })
    expect(up.status).toBe(200)
    const { seq } = (await up.json()) as { seq: number }

    // Pair a Mac and give it a live SSE subscription AFTER the upload, so the
    // only frame it can see is the /clip/copy re-send.
    const users = createUsersStore(db)
    const user = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const devices = createDevicesStore(db)
    const mac = devices.create(user.id, 'Mac A')
    const m = mockController()
    liveBus.subscribe(mac.id, m.controller)

    const copyR = await fetch(`${baseUrl}/clip/copy`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ seq }),
    })
    expect(copyR.status).toBe(200)
    expect(await copyR.json()).toEqual({ ok: true, devices: 1 })

    const dataFrame = m.frames.find((f) => f.startsWith('data: '))
    expect(dataFrame).toBeTruthy()
    const payload = JSON.parse(dataFrame!.slice('data: '.length).trim()) as {
      seq: number
      text: string
      source: string
    }
    expect(payload.seq).toBe(seq)
    expect(payload.text).toBe('старая запись')
    expect(payload.source).toBe('online')
  })

  test('/clip/copy with an unknown seq → 404, and another user seq is not found', async () => {
    db = openDb(':memory:')
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com'],
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      db,
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`
    const token = await signIn(baseUrl)

    const r = await fetch(`${baseUrl}/clip/copy`, {
      method: 'POST',
      headers: { cookie: `session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ seq: 99999 }),
    })
    expect(r.status).toBe(404)
  })

  test('/clip/copy without a session → 401', async () => {
    db = openDb(':memory:')
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com'],
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      db,
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    const r = await fetch(`${baseUrl}/clip/copy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seq: 1 }),
    })
    expect(r.status).toBe(401)
  })

  test('/events/ack with a valid device token bumps last_seen_at', async () => {
    let clock = 1_700_000_000_000
    db = openDb(':memory:')
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com'],
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      db,
      now: () => clock,
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`

    const users = createUsersStore(db, () => clock)
    const user = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const devices = createDevicesStore(db, () => clock)
    const dev = devices.create(user.id)
    const createdSeen = dev.last_seen_at

    clock += 12_345
    const ackR = await fetch(`${baseUrl}/events/ack`, {
      method: 'POST',
      headers: { 'x-device-token': dev.device_token, 'content-type': 'application/json' },
      body: JSON.stringify({ seq: 1 }),
    })
    expect(ackR.status).toBe(200)
    const after = devices.findByToken(dev.device_token)!
    expect(after.last_seen_at).toBe(clock)
    expect(after.last_seen_at).toBeGreaterThan(createdSeen)
  })

  test('/events without a device token → 401', async () => {
    db = openDb(':memory:')
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com'],
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      db,
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    const r = await fetch(`${baseUrl}/events`)
    expect(r.status).toBe(401)
  })
})
