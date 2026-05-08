import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface User {
  id: string
  name: string
  createdAt: string
  daemonToken: string
}

export interface UsersStore {
  list(): Promise<User[]>
  get(id: string): Promise<User | null>
  getByName(name: string): Promise<User | null>
  getByDaemonToken(token: string): Promise<User | null>
  create(input: { name: string }): Promise<User>
  regenerateDaemonToken(id: string): Promise<User | null>
}

function randHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createUsersStore(dataDir: string): UsersStore {
  const FILE = join(dataDir, 'users.json')

  let writeLock: Promise<unknown> = Promise.resolve()

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeLock.then(fn, fn)
    writeLock = next.catch(() => undefined)
    return next
  }

  async function load(): Promise<User[]> {
    try {
      const raw = await readFile(FILE, 'utf8')
      const parsed = JSON.parse(raw) as User[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async function save(items: User[]): Promise<void> {
    await mkdir(dataDir, { recursive: true })
    await writeFile(FILE, JSON.stringify(items, null, 2))
  }

  return {
    async list() {
      return load()
    },

    async get(id) {
      const items = await load()
      return items.find((u) => u.id === id) ?? null
    },

    async getByName(name) {
      const items = await load()
      return items.find((u) => u.name === name) ?? null
    },

    async getByDaemonToken(token) {
      if (!token) return null
      const items = await load()
      return items.find((u) => u.daemonToken === token) ?? null
    },

    async create(input) {
      return withLock(async () => {
        const items = await load()
        const user: User = {
          id: randHex(8),
          name: input.name,
          createdAt: new Date().toISOString(),
          daemonToken: randHex(24),
        }
        items.push(user)
        await save(items)
        return user
      })
    },

    async regenerateDaemonToken(id) {
      return withLock(async () => {
        const items = await load()
        const u = items.find((x) => x.id === id)
        if (!u) return null
        u.daemonToken = randHex(24)
        await save(items)
        return u
      })
    },
  }
}
