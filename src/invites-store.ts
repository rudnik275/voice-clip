import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Invite {
  token: string
  createdAt: string
  usedAt?: string
  usedBy?: string
}

export interface InvitesStore {
  list(): Promise<Invite[]>
  create(): Promise<Invite>
  // Atomic check-and-mark: returns the invite if it exists and is unused;
  // returns null if it's missing or already used. Marks usedAt+usedBy on success.
  consume(token: string, userId: string): Promise<Invite | null>
}

function randHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createInvitesStore(dataDir: string): InvitesStore {
  const FILE = join(dataDir, 'invites.json')

  let writeLock: Promise<unknown> = Promise.resolve()

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeLock.then(fn, fn)
    writeLock = next.catch(() => undefined)
    return next
  }

  async function load(): Promise<Invite[]> {
    try {
      const raw = await readFile(FILE, 'utf8')
      const parsed = JSON.parse(raw) as Invite[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async function save(items: Invite[]): Promise<void> {
    await mkdir(dataDir, { recursive: true })
    await writeFile(FILE, JSON.stringify(items, null, 2))
  }

  return {
    async list() {
      return load()
    },

    async create() {
      return withLock(async () => {
        const items = await load()
        const invite: Invite = {
          token: randHex(20),
          createdAt: new Date().toISOString(),
        }
        items.push(invite)
        await save(items)
        return invite
      })
    },

    async consume(token, userId) {
      return withLock(async () => {
        const items = await load()
        const invite = items.find((x) => x.token === token)
        if (!invite) return null
        if (invite.usedAt) return null
        invite.usedAt = new Date().toISOString()
        invite.usedBy = userId
        await save(items)
        return invite
      })
    },
  }
}
