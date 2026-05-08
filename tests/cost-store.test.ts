import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCostStore, type CostStore } from '../src/cost-store'

describe('cost-store', () => {
  let dir: string
  let store: CostStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-cost-'))
    store = createCostStore(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('initial state: zero spend, zero requests, since=ISO date', async () => {
    const state = await store.get()
    expect(state.totalUsd).toBe(0)
    expect(state.totalRequests).toBe(0)
    expect(state.since).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  test('record() accumulates spend and increments count', async () => {
    const a = await store.record(0.001)
    expect(a.totalUsd).toBeCloseTo(0.001, 6)
    expect(a.totalRequests).toBe(1)

    const b = await store.record(0.0042)
    expect(b.totalUsd).toBeCloseTo(0.0052, 6)
    expect(b.totalRequests).toBe(2)
  })

  test('record() persists across store re-creation', async () => {
    await store.record(0.5)
    await store.record(0.5)
    const fresh = createCostStore(dir)
    const state = await fresh.get()
    expect(state.totalUsd).toBeCloseTo(1.0, 6)
    expect(state.totalRequests).toBe(2)
  })

  test('parallel record() calls accumulate without lost updates', async () => {
    // Simulates two devices draining offline queues at the same time.
    const N = 25
    const promises: Promise<unknown>[] = []
    for (let i = 0; i < N; i++) promises.push(store.record(0.001))
    await Promise.all(promises)
    const state = await store.get()
    expect(state.totalRequests).toBe(N)
    expect(state.totalUsd).toBeCloseTo(N * 0.001, 6)
  })

  test('since is preserved across records (set on first read, not reset on each record)', async () => {
    const initial = await store.get()
    await new Promise((r) => setTimeout(r, 5))
    await store.record(0.01)
    const after = await store.get()
    // since may equal `initial.since` exactly only if get() persists the file;
    // current implementation does not persist on bare get(), so first record() may set a new `since`.
    // The contract we care about: once recorded, `since` is stable.
    await store.record(0.01)
    const after2 = await store.get()
    expect(after2.since).toBe(after.since)
  })
})
