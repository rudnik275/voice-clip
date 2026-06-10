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
import { createPendingDeliveriesStore } from '../src/pending-deliveries-store'
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

// Read SSE frames off a live /events response until `count` `data:` frames
// have arrived (or timeout). The server flushes pending rows synchronously in
// the stream's start(), so the replay frames are available immediately.
async function readDataFrames(res: Response, count: number, timeoutMs = 2000): Promise<unknown[]> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  const payloads: unknown[] = []
  let buf = ''
  const deadline = Date.now() + timeoutMs
  while (payloads.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, nl)
      buf = buf.slice(nl + 2)
      if (frame.startsWith('data: ')) payloads.push(JSON.parse(frame.slice('data: '.length)))
    }
  }
  await reader.cancel()
  return payloads
}

describe('offline-clip replay for disconnected Macs', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string
  let db: ReturnType<typeof openDb>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-replay-'))
  })
  afterEach(async () => {
    if (server) server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('one Mac live, one offline: live gets it instantly, offline gets a pending row, reconnect replays it in order, ack empties the queue', async () => {
    db = openDb(':memory:')
    const liveBus = createLiveBus()
    const pendingDeliveries = createPendingDeliveriesStore(db)
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
      pendingDeliveries,
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

    const users = createUsersStore(db)
    const user = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const devices = createDevicesStore(db)
    const macLive = devices.create(user.id, 'Mac live')
    const macOffline = devices.create(user.id, 'Mac offline')

    // Only the live Mac holds an SSE subscription. The offline Mac is NOT
    // subscribed — it will get a pending row instead.
    const live = mockController()
    liveBus.subscribe(macLive.id, live.controller)

    // Phone uploads a clip.
    const up = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${token}` },
      body: audioForm('2026-05-17T10:00:00.000Z'),
    })
    expect(up.status).toBe(200)
    const body = (await up.json()) as { seq: number; text: string }

    // Live Mac received it instantly over the bus.
    const liveFrame = live.frames.find((f) => f.startsWith('data: '))
    expect(liveFrame).toBeTruthy()
    const livePayload = JSON.parse(liveFrame!.slice('data: '.length).trim()) as { seq: number }
    expect(livePayload.seq).toBe(body.seq)

    // Offline Mac has exactly one queued row (the same seq).
    expect(pendingDeliveries.listByDevice(macOffline.id)).toEqual([{ seq: body.seq }])
    // At-least-once: the live Mac ALSO gets a pending row — live push is
    // best-effort, so the row stays until the Mac acks the pbcopy.
    expect(pendingDeliveries.listByDevice(macLive.id)).toEqual([{ seq: body.seq }])

    // Live Mac acks after pbcopy → its pending row is deleted.
    const liveAck = await fetch(`${baseUrl}/events/ack`, {
      method: 'POST',
      headers: {
        'x-device-token': macLive.device_token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ seq: body.seq }),
    })
    expect(liveAck.status).toBe(200)
    expect(pendingDeliveries.listByDevice(macLive.id)).toEqual([])

    // Offline Mac reconnects — its queued clip is replayed into the stream.
    const evRes = await fetch(`${baseUrl}/events?device_token=${macOffline.device_token}`)
    expect(evRes.status).toBe(200)
    const replayed = (await readDataFrames(evRes, 1)) as Array<{
      seq: number
      text: string
      source: string
    }>
    expect(replayed).toHaveLength(1)
    expect(replayed[0]!.seq).toBe(body.seq)
    expect(replayed[0]!.text).toBe('привет мир')
    expect(replayed[0]!.source).toBe('online')

    // The Mac pbcopy'd it and acks the seq → the pending row is deleted.
    const ackR = await fetch(`${baseUrl}/events/ack`, {
      method: 'POST',
      headers: {
        'x-device-token': macOffline.device_token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ seq: body.seq }),
    })
    expect(ackR.status).toBe(200)
    expect(pendingDeliveries.listByDevice(macOffline.id)).toEqual([])
  })

  test('live-delivered but never-acked clip is replayed on the next /events connect (at-least-once)', async () => {
    db = openDb(':memory:')
    const liveBus = createLiveBus()
    const pendingDeliveries = createPendingDeliveriesStore(db)
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
      pendingDeliveries,
      transcribe: async (): Promise<TranscriptionResult> => ({
        text: 'потерянный клип',
        usage: { audioTokens: 1000, textTokens: 0, outputTokens: 0 },
      }),
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`

    const token = await signIn(baseUrl)
    const users = createUsersStore(db)
    const user = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const devices = createDevicesStore(db)
    const mac = devices.create(user.id, 'Half-dead Mac')

    // The Mac LOOKS live (subscribed controller, enqueue succeeds) — but the
    // connection is half-dead and the client never receives the frame, so it
    // never acks. The clip must NOT be lost.
    const m = mockController()
    liveBus.subscribe(mac.id, m.controller)

    const up = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${token}` },
      body: audioForm('2026-05-17T10:00:00.000Z'),
    })
    expect(up.status).toBe(200)
    const body = (await up.json()) as { seq: number }

    // The live push did go into the (doomed) stream buffer…
    expect(m.frames.find((f) => f.startsWith('data: '))).toBeTruthy()
    // …but the pending row survives because no ack arrived.
    expect(pendingDeliveries.listByDevice(mac.id)).toEqual([{ seq: body.seq }])

    // The Mac reconnects — the unacked clip is replayed.
    const evRes = await fetch(`${baseUrl}/events?device_token=${mac.device_token}`)
    expect(evRes.status).toBe(200)
    const replayed = (await readDataFrames(evRes, 1)) as Array<{ seq: number; text: string }>
    expect(replayed).toHaveLength(1)
    expect(replayed[0]!.seq).toBe(body.seq)
    expect(replayed[0]!.text).toBe('потерянный клип')

    // Ack from the new connection finally deletes the row.
    await fetch(`${baseUrl}/events/ack`, {
      method: 'POST',
      headers: { 'x-device-token': mac.device_token, 'content-type': 'application/json' },
      body: JSON.stringify({ seq: body.seq }),
    })
    expect(pendingDeliveries.listByDevice(mac.id)).toEqual([])
  })

  test('multiple queued clips replay oldest-first in seq order', async () => {
    db = openDb(':memory:')
    const liveBus = createLiveBus()
    const pendingDeliveries = createPendingDeliveriesStore(db)
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
      pendingDeliveries,
      transcribe: async (_b, _n): Promise<TranscriptionResult> => ({
        text: 'clip',
        usage: { audioTokens: 100, textTokens: 0, outputTokens: 0 },
      }),
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`

    const token = await signIn(baseUrl)
    const users = createUsersStore(db)
    const user = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const devices = createDevicesStore(db)
    const mac = devices.create(user.id, 'Offline Mac')

    // No subscriber → three uploads each enqueue a pending row.
    const seqs: number[] = []
    for (let i = 0; i < 3; i++) {
      const up = await fetch(`${baseUrl}/upload`, {
        method: 'POST',
        headers: { cookie: `session=${token}` },
        body: audioForm(`2026-05-17T10:0${i}:00.000Z`),
      })
      const b = (await up.json()) as { seq: number }
      seqs.push(b.seq)
    }
    expect(pendingDeliveries.listByDevice(mac.id)).toEqual(seqs.map((seq) => ({ seq })))

    // Reconnect — all three replay in ascending seq order.
    const evRes = await fetch(`${baseUrl}/events?device_token=${mac.device_token}`)
    const replayed = (await readDataFrames(evRes, 3)) as Array<{ seq: number }>
    expect(replayed.map((p) => p.seq)).toEqual([...seqs].sort((a, b) => a - b))

    // Ack only the first → queue keeps the rest.
    await fetch(`${baseUrl}/events/ack`, {
      method: 'POST',
      headers: { 'x-device-token': mac.device_token, 'content-type': 'application/json' },
      body: JSON.stringify({ seq: seqs[0] }),
    })
    expect(pendingDeliveries.listByDevice(mac.id)).toEqual(seqs.slice(1).map((seq) => ({ seq })))
  })

  test('/events/ack with a missing/malformed body still acks liveness (does not 500)', async () => {
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

    const users = createUsersStore(db)
    const user = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const devices = createDevicesStore(db)
    const mac = devices.create(user.id)

    const r = await fetch(`${baseUrl}/events/ack`, {
      method: 'POST',
      headers: { 'x-device-token': mac.device_token, 'content-type': 'application/json' },
      body: 'not json{',
    })
    expect(r.status).toBe(200)
    expect((await r.json()) as { ok: boolean }).toEqual({ ok: true })
  })
})
