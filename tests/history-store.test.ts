import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHistoryStore, type HistoryItem, type HistoryStore } from '../src/history-store'

function sampleItem(id: string, overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id,
    ts: `2026-05-08T10:00:0${id.slice(-1) || '0'}Z`,
    text: `text-${id}`,
    source: 'online',
    ...overrides,
  }
}

describe('history-store', () => {
  let dir: string
  let store: HistoryStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-history-'))
    store = createHistoryStore(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('list() is empty initially when no file exists', async () => {
    expect(await store.list()).toEqual([])
  })

  test('append() persists item across re-creation of store', async () => {
    const item = sampleItem('a')
    await store.append(item)
    const fresh = createHistoryStore(dir)
    expect(await fresh.list()).toEqual([item])
  })

  test('append() preserves insertion order across many items', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append(sampleItem(String(i)))
    }
    const list = await store.list()
    expect(list.map((x) => x.id)).toEqual(['0', '1', '2', '3', '4'])
  })

  test('append() preserves source=offline and recordedAt for offline items', async () => {
    const item = sampleItem('off-1', {
      source: 'offline',
      recordedAt: '2026-05-08T08:30:00Z',
      ts: '2026-05-08T10:00:00Z', // synced later
      costUsd: 0.0042,
    })
    await store.append(item)
    const [stored] = await store.list()
    expect(stored).toBeDefined()
    expect(stored?.source).toBe('offline')
    expect(stored?.recordedAt).toBe('2026-05-08T08:30:00Z')
    expect(stored?.costUsd).toBe(0.0042)
  })

  test('markRead() sets readAt and persists', async () => {
    await store.append(sampleItem('a'))
    const before = (await store.list())[0]
    expect(before?.readAt).toBeUndefined()

    const updated = await store.markRead('a')
    expect(updated?.readAt).toBeString()

    const fresh = createHistoryStore(dir)
    const after = (await fresh.list())[0]
    expect(after?.readAt).toBeString()
  })

  test('markRead() returns null for unknown id without writing', async () => {
    await store.append(sampleItem('a'))
    const result = await store.markRead('does-not-exist')
    expect(result).toBeNull()
  })

  test('markAllRead() updates only previously-unread items', async () => {
    await store.append(sampleItem('a'))
    await store.append(sampleItem('b', { readAt: '2026-05-07T00:00:00Z' }))
    await store.append(sampleItem('c'))

    const updated = await store.markAllRead()
    expect(updated).toBe(2)

    const list = await store.list()
    // 'b' keeps its original readAt
    expect(list.find((x) => x.id === 'b')?.readAt).toBe('2026-05-07T00:00:00Z')
    // 'a' and 'c' got fresh timestamps
    expect(list.find((x) => x.id === 'a')?.readAt).toBeString()
    expect(list.find((x) => x.id === 'c')?.readAt).toBeString()

    // calling again with all-read returns 0
    expect(await store.markAllRead()).toBe(0)
  })

  test('remove() deletes by id and returns true', async () => {
    await store.append(sampleItem('a'))
    await store.append(sampleItem('b'))
    expect(await store.remove('a')).toBe(true)
    expect((await store.list()).map((x) => x.id)).toEqual(['b'])
  })

  test('remove() returns false for unknown id', async () => {
    await store.append(sampleItem('a'))
    expect(await store.remove('zzz')).toBe(false)
    expect((await store.list()).length).toBe(1)
  })

  test('clear() empties the file and returns previous count', async () => {
    await store.append(sampleItem('a'))
    await store.append(sampleItem('b'))
    expect(await store.clear()).toBe(2)
    expect(await store.list()).toEqual([])
    // file is still valid JSON (empty array)
    const raw = await readFile(join(dir, 'history.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual([])
  })

  test('clear() on empty store returns 0', async () => {
    expect(await store.clear()).toBe(0)
  })

  test('parallel append() calls from multiple devices do not lose items', async () => {
    // Simulates phone + tablet both draining their offline queues at the same time.
    const N = 30
    const promises: Promise<void>[] = []
    for (let i = 0; i < N; i++) {
      promises.push(store.append(sampleItem(`p${i}`)))
    }
    await Promise.all(promises)
    const list = await store.list()
    expect(list).toHaveLength(N)
    const ids = new Set(list.map((x) => x.id))
    expect(ids.size).toBe(N)
  })

  test('parallel mixed mutations (append + markRead + remove) preserve consistency', async () => {
    await store.append(sampleItem('keep-1'))
    await store.append(sampleItem('keep-2'))
    await store.append(sampleItem('to-delete'))

    const ops: Promise<unknown>[] = []
    for (let i = 0; i < 5; i++) ops.push(store.append(sampleItem(`new-${i}`)))
    ops.push(store.markRead('keep-1'))
    ops.push(store.remove('to-delete'))
    await Promise.all(ops)

    const list = await store.list()
    expect(list).toHaveLength(2 + 5) // keep-1, keep-2, new-0..4
    expect(list.find((x) => x.id === 'to-delete')).toBeUndefined()
    expect(list.find((x) => x.id === 'keep-1')?.readAt).toBeString()
  })

  test('handles corrupted history.json gracefully (returns empty list)', async () => {
    // simulate a broken file from a previous version
    await Bun.write(join(dir, 'history.json'), '{not valid json')
    expect(await store.list()).toEqual([])
    // append still works after corruption
    await store.append(sampleItem('a'))
    expect((await store.list()).map((x) => x.id)).toEqual(['a'])
  })
})
