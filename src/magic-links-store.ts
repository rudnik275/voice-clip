import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface MagicLink {
  token: string
  userId: string
  createdAt: string
  expiresAt: string
  usedAt?: string
}

export interface MagicLinksStore {
  create(userId: string, ttlSec: number): Promise<MagicLink>
  // Atomic consume: returns the link only if it exists, isn't used, and
  // hasn't expired. Marks usedAt on success.
  consume(token: string): Promise<MagicLink | null>
}

function randHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createMagicLinksStore(dataDir: string): MagicLinksStore {
  const FILE = join(dataDir, 'magic-links.json')

  let writeLock: Promise<unknown> = Promise.resolve()

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeLock.then(fn, fn)
    writeLock = next.catch(() => undefined)
    return next
  }

  async function load(): Promise<MagicLink[]> {
    try {
      const raw = await readFile(FILE, 'utf8')
      const parsed = JSON.parse(raw) as MagicLink[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async function save(items: MagicLink[]): Promise<void> {
    await mkdir(dataDir, { recursive: true })
    await writeFile(FILE, JSON.stringify(items, null, 2))
  }

  return {
    async create(userId, ttlSec) {
      return withLock(async () => {
        const items = await load()
        const now = new Date()
        const link: MagicLink = {
          token: randHex(20),
          userId,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + ttlSec * 1000).toISOString(),
        }
        items.push(link)
        await save(items)
        return link
      })
    },

    async consume(token) {
      return withLock(async () => {
        const items = await load()
        const link = items.find((x) => x.token === token)
        if (!link) return null
        if (link.usedAt) return null
        if (new Date(link.expiresAt).getTime() < Date.now()) return null
        link.usedAt = new Date().toISOString()
        await save(items)
        return link
      })
    },
  }
}
