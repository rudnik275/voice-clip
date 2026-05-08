import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface PendingClip {
  id: string
  text: string
  createdAt: string
  ackedAt?: string
}

export interface PendingClipsStore {
  enqueue(clip: { id: string; text: string }): Promise<void>
  listUnacked(): Promise<PendingClip[]>
  ack(id: string): Promise<boolean>
  // Drop ack'ed entries older than the cutoff (housekeeping; called occasionally).
  pruneAcked(olderThan: Date): Promise<number>
}

export function createPendingClipsStore(dataDir: string, userId: string): PendingClipsStore {
  const userDir = join(dataDir, 'users', userId)
  const FILE = join(userDir, 'pending-clips.json')

  let writeLock: Promise<unknown> = Promise.resolve()

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeLock.then(fn, fn)
    writeLock = next.catch(() => undefined)
    return next
  }

  async function load(): Promise<PendingClip[]> {
    try {
      const raw = await readFile(FILE, 'utf8')
      const parsed = JSON.parse(raw) as PendingClip[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async function save(items: PendingClip[]): Promise<void> {
    await mkdir(userDir, { recursive: true })
    await writeFile(FILE, JSON.stringify(items, null, 2))
  }

  return {
    async enqueue(clip) {
      return withLock(async () => {
        const items = await load()
        items.push({ id: clip.id, text: clip.text, createdAt: new Date().toISOString() })
        await save(items)
      })
    },

    async listUnacked() {
      const items = await load()
      return items.filter((c) => !c.ackedAt)
    },

    async ack(id) {
      return withLock(async () => {
        const items = await load()
        const c = items.find((x) => x.id === id)
        if (!c || c.ackedAt) return false
        c.ackedAt = new Date().toISOString()
        await save(items)
        return true
      })
    },

    async pruneAcked(olderThan) {
      return withLock(async () => {
        const items = await load()
        const cutoff = olderThan.toISOString()
        const before = items.length
        const kept = items.filter((c) => !c.ackedAt || c.ackedAt > cutoff)
        if (kept.length === before) return 0
        await save(kept)
        return before - kept.length
      })
    },
  }
}
