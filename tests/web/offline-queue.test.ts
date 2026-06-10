// Tests for issue #140 — offline queue wiring in the recorder store.
//
// The queue LOGIC (enqueue rules, drain order, single-flight, delete-on-2xx)
// is unit-tested in tests/core/offline-sync.test.ts with fakes. Here we test
// the Pinia wiring seam with a stubbed queue (Bun has no `indexedDB`, so the
// real IndexedDB adapter is covered by the manual airplane-mode check):
//   1. store init (app load) drains the queue → POST /upload with
//      source=offline + the original recordedAt, item deleted on 2xx;
//   2. the window 'online' event triggers another drain.

import { test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import type { OfflineQueue, QueuedClip } from '../../core/offline-sync'

// ---- minimal browser globals (same pattern as session-store.test.ts), with
//      addEventListener so the store can register its 'online' drain trigger --
const onlineHandlers: Array<() => void> = []
;(globalThis as unknown as { window: unknown }).window = {
  location: { href: '' },
  addEventListener(type: string, handler: () => void) {
    if (type === 'online') onlineHandlers.push(handler)
  },
} as unknown as Window & typeof globalThis

// Import AFTER window is in place (tauri-runtime reads window.__TAURI__ at module init).
const { useRecorderStore, __setOfflineQueueFactory } = await import('../../web/src/stores/recorder')

/** In-memory fake of the OfflineQueue port. */
function fakeQueue(initial: QueuedClip[] = []): OfflineQueue & { items: Map<string, QueuedClip> } {
  const items = new Map(initial.map((i) => [i.localId, i]))
  return {
    items,
    async put(item) {
      items.set(item.localId, item)
    },
    async list() {
      return [...items.values()]
    },
    async delete(id) {
      items.delete(id)
    },
  }
}

function queuedItem(over: Partial<QueuedClip> = {}): QueuedClip {
  return {
    localId: 'q1',
    blob: new Blob([new Uint8Array([7, 7, 7])], { type: 'audio/mp4' }),
    mime: 'audio/mp4',
    recordedAt: 1_700_000_222_000,
    durationMs: 2500,
    ...over,
  }
}

const realFetch = globalThis.fetch

type Captured = { url: string; form: FormData }
function stubUploadFetch(captured: Captured[]): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    captured.push({ url, form: init?.body as FormData })
    return Response.json({ text: 'drained' })
  }) as unknown as typeof fetch
}

/** Let the async drain (queue.list → fetch → queue.delete) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  setActivePinia(createPinia())
  onlineHandlers.length = 0
})

afterEach(() => {
  globalThis.fetch = realFetch
  __setOfflineQueueFactory(() => null)
})

test('store init drains the queue: source=offline + original recordedAt, item removed on 2xx', async () => {
  const q = fakeQueue([queuedItem()])
  __setOfflineQueueFactory(() => q)
  const captured: Captured[] = []
  stubUploadFetch(captured)

  useRecorderStore() // store setup = app-load drain trigger
  await settle()

  expect(captured.length).toBe(1)
  expect(captured[0]!.url).toBe('/upload')
  const form = captured[0]!.form
  expect(form).toBeInstanceOf(FormData)
  expect(form.get('source')).toBe('offline')
  expect(form.get('recordedAt')).toBe('1700000222000')
  expect(form.get('durationMs')).toBe('2500')
  expect(form.get('audio')).toBeInstanceOf(Blob)
  expect(q.items.size).toBe(0) // removed only after the 2xx
})

test("window 'online' event triggers a drain", async () => {
  const q = fakeQueue()
  __setOfflineQueueFactory(() => q)
  const captured: Captured[] = []
  stubUploadFetch(captured)

  useRecorderStore()
  await settle()
  expect(captured.length).toBe(0) // queue was empty on init — nothing sent
  expect(onlineHandlers.length).toBeGreaterThan(0) // listener registered

  // connectivity returns with an item waiting
  await q.put(queuedItem({ localId: 'q2', recordedAt: 1_700_000_333_000 }))
  for (const h of onlineHandlers) h()
  await settle()

  expect(captured.length).toBe(1)
  expect(captured[0]!.form.get('source')).toBe('offline')
  expect(captured[0]!.form.get('recordedAt')).toBe('1700000333000')
  expect(q.items.size).toBe(0)
})

test('without a queue (no indexedDB) the store still constructs and registers nothing', async () => {
  __setOfflineQueueFactory(() => null)
  const captured: Captured[] = []
  stubUploadFetch(captured)

  const store = useRecorderStore()
  await settle()

  expect(store.state).toBe('idle')
  expect(captured.length).toBe(0)
  expect(onlineHandlers.length).toBe(0)
})
