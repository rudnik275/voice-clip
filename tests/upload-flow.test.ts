import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistoryStore, type HistoryItem } from '../src/history-store'
import { createCostStore } from '../src/cost-store'
import { createAudioStorage } from '../src/storage'
import { startServer, type ServerDeps } from '../src/server'

interface UploadResponse {
  id: string
  text: string
  costUsd?: number
  totalUsd?: number
  totalRequests?: number
  source: 'online' | 'offline'
}

describe('upload flow + history sync', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string
  let clipboardCalls: string[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-server-'))
    clipboardCalls = []
    const deps: ServerDeps = {
      history: createHistoryStore(dir),
      costs: createCostStore(dir),
      audio: createAudioStorage(dir),
      transcribe: async () => ({
        text: 'mocked transcript',
        usage: { audioTokens: 100, textTokens: 50, outputTokens: 20 },
      }),
      copyToClipboard: async (text: string) => {
        clipboardCalls.push(text)
      },
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

  function makeFormData(opts: {
    bytes?: number[]
    mime?: string
    source: 'online' | 'offline'
    recordedAt: string
  }): FormData {
    const fd = new FormData()
    fd.append(
      'audio',
      new Blob([new Uint8Array(opts.bytes ?? [1, 2, 3])], { type: opts.mime ?? 'audio/mp4' }),
    )
    fd.append('source', opts.source)
    fd.append('recordedAt', opts.recordedAt)
    return fd
  }

  async function listHistory(): Promise<HistoryItem[]> {
    const r = await fetch(`${baseUrl}/history`)
    return (await r.json()) as HistoryItem[]
  }

  test('online upload → clipboard called, item saved with readAt (auto-read)', async () => {
    const r = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: makeFormData({ source: 'online', recordedAt: '2026-05-08T10:00:00Z' }),
    })
    expect(r.ok).toBe(true)

    const data = (await r.json()) as UploadResponse
    expect(data.text).toBe('mocked transcript')
    expect(data.source).toBe('online')
    expect(data.costUsd).toBeGreaterThan(0)
    expect(clipboardCalls).toEqual(['mocked transcript'])

    const items = await listHistory()
    expect(items).toHaveLength(1)
    expect(items[0]?.source).toBe('online')
    expect(items[0]?.readAt).toBeString()
    expect(items[0]?.recordedAt).toBe('2026-05-08T10:00:00Z')
  })

  test('offline upload → clipboard NOT called, item without readAt (stays unread)', async () => {
    const r = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: makeFormData({ source: 'offline', recordedAt: '2026-05-08T08:30:00Z' }),
    })
    expect(r.ok).toBe(true)

    expect(clipboardCalls).toHaveLength(0)

    const items = await listHistory()
    expect(items).toHaveLength(1)
    expect(items[0]?.source).toBe('offline')
    expect(items[0]?.readAt).toBeUndefined()
    expect(items[0]?.recordedAt).toBe('2026-05-08T08:30:00Z')
  })

  test('multi-device drain: parallel offline uploads from two devices all land in history', async () => {
    // Phone + tablet draining their offline queues at the same time.
    const N = 6
    const promises: Promise<Response>[] = []
    for (let i = 0; i < N; i++) {
      promises.push(
        fetch(`${baseUrl}/upload`, {
          method: 'POST',
          body: makeFormData({
            bytes: [i],
            source: 'offline',
            recordedAt: `2026-05-08T08:${String(i).padStart(2, '0')}:00Z`,
          }),
        }),
      )
    }
    const responses = await Promise.all(promises)
    expect(responses.every((r) => r.ok)).toBe(true)

    const items = await listHistory()
    expect(items).toHaveLength(N)
    // No clipboard calls — all offline.
    expect(clipboardCalls).toHaveLength(0)
    // Every item carries source=offline.
    expect(items.every((i) => i.source === 'offline')).toBe(true)
    // All recordedAt values preserved (no lost items from concurrent writes).
    const stamps = new Set(items.map((i) => i.recordedAt))
    expect(stamps.size).toBe(N)
  })

  test('mixed online + offline order: only offline items count as unread', async () => {
    // Offline (recorded earlier, synced later)
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: makeFormData({ source: 'offline', recordedAt: '2026-05-08T08:00:00Z' }),
    })
    // Online (live)
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: makeFormData({ source: 'online', recordedAt: '2026-05-08T10:00:00Z' }),
    })

    const items = await listHistory()
    expect(items).toHaveLength(2)

    const unread = items.filter((i) => !i.readAt)
    expect(unread).toHaveLength(1)
    expect(unread[0]?.source).toBe('offline')

    expect(clipboardCalls).toEqual(['mocked transcript']) // only the online one
  })

  test('mark-all-read updates only the offline (unread) items', async () => {
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: makeFormData({ source: 'online', recordedAt: '2026-05-08T10:00:00Z' }),
    })
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: makeFormData({ source: 'offline', recordedAt: '2026-05-08T08:00:00Z' }),
    })

    const r = await fetch(`${baseUrl}/history/read-all`, { method: 'POST' })
    const result = (await r.json()) as { updated: number }
    expect(result.updated).toBe(1)

    const items = await listHistory()
    expect(items.every((i) => i.readAt)).toBe(true)
  })

  test('mark single item as read', async () => {
    const upload = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: makeFormData({ source: 'offline', recordedAt: '2026-05-08T08:00:00Z' }),
    })
    const data = (await upload.json()) as UploadResponse

    const r = await fetch(`${baseUrl}/history/${encodeURIComponent(data.id)}/read`, {
      method: 'POST',
    })
    expect(r.ok).toBe(true)

    const items = await listHistory()
    expect(items[0]?.readAt).toBeString()
  })

  test('GET /cost reflects accumulated spend', async () => {
    const before = await (await fetch(`${baseUrl}/cost`)).json()
    expect(before).toMatchObject({ totalUsd: 0, totalRequests: 0 })

    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: makeFormData({ source: 'online', recordedAt: '2026-05-08T10:00:00Z' }),
    })
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: makeFormData({ source: 'offline', recordedAt: '2026-05-08T08:00:00Z' }),
    })

    const after = (await (await fetch(`${baseUrl}/cost`)).json()) as {
      totalUsd: number
      totalRequests: number
    }
    expect(after.totalRequests).toBe(2)
    expect(after.totalUsd).toBeGreaterThan(0)
  })

  test('end-to-end scenario: online → offline → online drain', async () => {
    // 1. Online recording (auto-read, clipboard called)
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: makeFormData({ source: 'online', recordedAt: '2026-05-08T10:00:00Z' }),
    })

    // 2. Two messages recorded "offline" (later synced as a drained queue)
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: makeFormData({ source: 'offline', recordedAt: '2026-05-08T11:00:00Z' }),
    })
    await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: makeFormData({ source: 'offline', recordedAt: '2026-05-08T11:30:00Z' }),
    })

    const items = await listHistory()
    expect(items).toHaveLength(3)

    // The online one was auto-marked-read; offline ones remain unread.
    const unread = items.filter((i) => !i.readAt)
    expect(unread).toHaveLength(2)
    expect(unread.every((i) => i.source === 'offline')).toBe(true)

    // Only the online one touched the Mac clipboard.
    expect(clipboardCalls).toEqual(['mocked transcript'])
  })
})
