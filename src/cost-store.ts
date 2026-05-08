import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface CostState {
  totalUsd: number
  totalRequests: number
  since: string // ISO date of first record
}

export interface CostStore {
  get(): Promise<CostState>
  record(usd: number): Promise<CostState>
}

export function createCostStore(dataDir: string): CostStore {
  const FILE = join(dataDir, 'cost.json')

  // Same write-serialization contract as history-store: concurrent uploads from
  // multiple devices must accumulate cleanly without lost updates.
  let writeLock: Promise<unknown> = Promise.resolve()

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeLock.then(fn, fn)
    writeLock = next.catch(() => undefined)
    return next
  }

  async function load(): Promise<CostState> {
    try {
      const raw = await readFile(FILE, 'utf8')
      const parsed = JSON.parse(raw) as Partial<CostState>
      return {
        totalUsd: typeof parsed.totalUsd === 'number' ? parsed.totalUsd : 0,
        totalRequests: typeof parsed.totalRequests === 'number' ? parsed.totalRequests : 0,
        since: typeof parsed.since === 'string' ? parsed.since : new Date().toISOString(),
      }
    } catch {
      return { totalUsd: 0, totalRequests: 0, since: new Date().toISOString() }
    }
  }

  async function save(state: CostState): Promise<void> {
    await mkdir(dataDir, { recursive: true })
    await writeFile(FILE, JSON.stringify(state, null, 2))
  }

  return {
    async get() {
      return load()
    },

    async record(usd: number) {
      return withLock(async () => {
        const state = await load()
        state.totalUsd += usd
        state.totalRequests += 1
        await save(state)
        return state
      })
    },
  }
}
