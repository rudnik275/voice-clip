import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Session {
  token: string
  userId: string
  createdAt: string
}

export interface SessionsStore {
  create(userId: string): Promise<Session>
  get(token: string): Promise<Session | null>
  delete(token: string): Promise<boolean>
}

function randHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createSessionsStore(dataDir: string): SessionsStore {
  const FILE = join(dataDir, 'sessions.json')

  let writeLock: Promise<unknown> = Promise.resolve()

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeLock.then(fn, fn)
    writeLock = next.catch(() => undefined)
    return next
  }

  async function load(): Promise<Session[]> {
    try {
      const raw = await readFile(FILE, 'utf8')
      const parsed = JSON.parse(raw) as Session[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async function save(items: Session[]): Promise<void> {
    await mkdir(dataDir, { recursive: true })
    await writeFile(FILE, JSON.stringify(items, null, 2))
  }

  return {
    async create(userId) {
      return withLock(async () => {
        const items = await load()
        const session: Session = {
          token: randHex(32),
          userId,
          createdAt: new Date().toISOString(),
        }
        items.push(session)
        await save(items)
        return session
      })
    },

    async get(token) {
      if (!token) return null
      const items = await load()
      return items.find((s) => s.token === token) ?? null
    },

    async delete(token) {
      return withLock(async () => {
        const items = await load()
        const idx = items.findIndex((s) => s.token === token)
        if (idx < 0) return false
        items.splice(idx, 1)
        await save(items)
        return true
      })
    },
  }
}
