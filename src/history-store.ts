import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface HistoryItem {
  id: string
  ts: string             // ISO of when transcription was created on server
  recordedAt?: string    // ISO of when audio was recorded on phone (may differ for offline)
  text: string
  costUsd?: number
  source: 'online' | 'offline'
  readAt?: string
}

export interface HistoryStore {
  list(): Promise<HistoryItem[]>
  append(item: HistoryItem): Promise<void>
  markRead(id: string): Promise<HistoryItem | null>
  markAllRead(): Promise<number>
  remove(id: string): Promise<boolean>
  clear(): Promise<number>
}

export function createHistoryStore(dataDir: string): HistoryStore {
  const FILE = join(dataDir, 'history.json')

  // Serialize all write operations through a single Promise chain so concurrent
  // uploads (e.g. phone and tablet draining offline queues at the same time)
  // can't lose items via load → mutate → save races.
  let writeLock: Promise<unknown> = Promise.resolve()

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeLock.then(fn, fn)
    writeLock = next.catch(() => undefined)
    return next
  }

  async function load(): Promise<HistoryItem[]> {
    try {
      const raw = await readFile(FILE, 'utf8')
      const parsed = JSON.parse(raw) as HistoryItem[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async function save(items: HistoryItem[]): Promise<void> {
    await mkdir(dataDir, { recursive: true })
    await writeFile(FILE, JSON.stringify(items, null, 2))
  }

  return {
    async list() {
      return load()
    },

    async append(item) {
      return withLock(async () => {
        const items = await load()
        items.push(item)
        await save(items)
      })
    },

    async markRead(id) {
      return withLock(async () => {
        const items = await load()
        const item = items.find((x) => x.id === id)
        if (!item) return null
        item.readAt = new Date().toISOString()
        await save(items)
        return item
      })
    },

    async markAllRead() {
      return withLock(async () => {
        const items = await load()
        const now = new Date().toISOString()
        let updated = 0
        for (const item of items) {
          if (!item.readAt) {
            item.readAt = now
            updated++
          }
        }
        if (updated > 0) await save(items)
        return updated
      })
    },

    async remove(id) {
      return withLock(async () => {
        const items = await load()
        const idx = items.findIndex((x) => x.id === id)
        if (idx < 0) return false
        items.splice(idx, 1)
        await save(items)
        return true
      })
    },

    async clear() {
      return withLock(async () => {
        const items = await load()
        const n = items.length
        await save([])
        return n
      })
    },
  }
}
