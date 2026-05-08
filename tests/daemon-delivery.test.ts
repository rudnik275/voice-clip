import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsersStore, type User } from '../src/users-store'
import { createSessionsStore, type Session } from '../src/sessions-store'
import { startServer, type ServerDeps } from '../src/server'

interface SseClient {
  events: { id: string; text: string }[]
  abort: () => void
  done: Promise<void>
}

// Streams /events?token=... and pushes parsed `data:` records to client.events.
// Returns when the response body finishes (e.g. server closes) or abort() called.
function openEventStream(baseUrl: string, daemonToken: string): SseClient {
  const events: { id: string; text: string }[] = []
  const ctrl = new AbortController()

  const done = (async () => {
    let r: Response
    try {
      r = await fetch(`${baseUrl}/events?token=${encodeURIComponent(daemonToken)}`, {
        headers: { Accept: 'text/event-stream' },
        signal: ctrl.signal,
      })
    } catch {
      return
    }
    if (!r.ok || !r.body) return
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      let value: Uint8Array | undefined
      let done = false
      try {
        const chunk = await reader.read()
        value = chunk.value as Uint8Array | undefined
        done = chunk.done
      } catch {
        break
      }
      if (done) break
      if (!value) continue
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop()!
      for (const block of parts) {
        const trimmed = block.trim()
        if (!trimmed || trimmed.startsWith(':')) continue // ignore keepalive/comment
        const dataLine = trimmed.replace(/^data:\s*/m, '')
        try {
          events.push(JSON.parse(dataLine))
        } catch {
          // ignore malformed lines
        }
      }
    }
  })()

  return { events, abort: () => ctrl.abort(), done }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500, intervalMs = 10): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

function uploadForm(bytes: number[] = [1, 2, 3]): FormData {
  const fd = new FormData()
  fd.append('audio', new Blob([new Uint8Array(bytes)], { type: 'audio/mp4' }))
  fd.append('source', 'online')
  fd.append('recordedAt', '2026-05-08T10:00:00Z')
  return fd
}

describe('daemon delivery via SSE', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string
  let alice: User
  let aliceSession: Session
  let aliceCookie: string
  let bob: User
  let bobSession: Session
  let bobCookie: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-daemon-'))
    const users = createUsersStore(dir)
    const sessions = createSessionsStore(dir)
    alice = await users.create({ name: 'alice' })
    aliceSession = await sessions.create(alice.id)
    aliceCookie = `session=${aliceSession.token}`
    bob = await users.create({ name: 'bob' })
    bobSession = await sessions.create(bob.id)
    bobCookie = `session=${bobSession.token}`

    const deps: ServerDeps = {
      dataDir: dir,
      users,
      sessions,
      transcribe: async (_buf, _name) => ({
        text: `text-${Math.random().toString(36).slice(2, 7)}`,
        usage: { audioTokens: 100, textTokens: 50, outputTokens: 20 },
      }),
      copyToClipboard: async () => undefined,
      port: 0,
      useTls: false,
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
  })

  afterEach(async () => {
    server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('GET /events without token → 403', async () => {
    const r = await fetch(`${baseUrl}/events`)
    expect(r.status).toBe(403)
  })

  test('GET /events with bad token → 403', async () => {
    const r = await fetch(`${baseUrl}/events?token=not-a-token`)
    expect(r.status).toBe(403)
  })

  test('live upload pushes to a connected daemon', async () => {
    const stream = openEventStream(baseUrl, alice.daemonToken)
    // Give the SSE handler a tick to register the subscriber before we publish.
    await new Promise((r) => setTimeout(r, 50))

    const r = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: aliceCookie },
      body: uploadForm(),
    })
    expect(r.ok).toBe(true)

    await waitFor(() => stream.events.length >= 1)
    expect(stream.events[0]?.text).toMatch(/^text-/)

    stream.abort()
    await stream.done
  })

  test('disconnected daemon: uploads queue → reconnect replays them', async () => {
    // Two uploads while no daemon is connected.
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: aliceCookie },
      body: uploadForm([1]),
    })
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: aliceCookie },
      body: uploadForm([2]),
    })

    // Now connect — server should replay both as "data:" frames before any new
    // event arrives.
    const stream = openEventStream(baseUrl, alice.daemonToken)
    await waitFor(() => stream.events.length >= 2, 2000)
    expect(stream.events).toHaveLength(2)

    stream.abort()
    await stream.done
  })

  test('ACK removes a clip from the replay set', async () => {
    // First upload + connect + receive the clip
    const upl = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: aliceCookie },
      body: uploadForm([1]),
    })
    const data = (await upl.json()) as { id: string }

    const stream1 = openEventStream(baseUrl, alice.daemonToken)
    await waitFor(() => stream1.events.length >= 1)
    expect(stream1.events[0]?.id).toBe(data.id)
    stream1.abort()
    await stream1.done

    // ACK the clip
    const ack = await fetch(`${baseUrl}/events/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Daemon-Token': alice.daemonToken },
      body: JSON.stringify({ ids: [data.id] }),
    })
    expect(ack.ok).toBe(true)
    const ackData = (await ack.json()) as { acked: number }
    expect(ackData.acked).toBe(1)

    // Reconnect — no replay, since the only clip is acked.
    const stream2 = openEventStream(baseUrl, alice.daemonToken)
    // Give the server time to enumerate pending and decide to send nothing.
    await new Promise((r) => setTimeout(r, 100))
    expect(stream2.events).toHaveLength(0)
    stream2.abort()
    await stream2.done
  })

  test('isolation: alice daemon does NOT receive bob upload', async () => {
    const aliceStream = openEventStream(baseUrl, alice.daemonToken)
    await new Promise((r) => setTimeout(r, 50))

    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: bobCookie },
      body: uploadForm(),
    })

    // Wait long enough that any leak would land.
    await new Promise((r) => setTimeout(r, 150))
    expect(aliceStream.events).toHaveLength(0)

    aliceStream.abort()
    await aliceStream.done
  })

  test('offline upload does NOT push to daemon (server pbcopy contract — only online clips get delivered)', async () => {
    const stream = openEventStream(baseUrl, alice.daemonToken)
    await new Promise((r) => setTimeout(r, 50))

    const fd = new FormData()
    fd.append('audio', new Blob([new Uint8Array([1])], { type: 'audio/mp4' }))
    fd.append('source', 'offline')
    fd.append('recordedAt', '2026-05-08T08:00:00Z')

    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: aliceCookie },
      body: fd,
    })

    await new Promise((r) => setTimeout(r, 150))
    expect(stream.events).toHaveLength(0)

    stream.abort()
    await stream.done
  })

  test('/events/ack without daemon token → 403', async () => {
    const r = await fetch(`${baseUrl}/events/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['anything'] }),
    })
    expect(r.status).toBe(403)
  })
})
