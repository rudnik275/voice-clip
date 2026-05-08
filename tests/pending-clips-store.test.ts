import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPendingClipsStore, type PendingClipsStore } from '../src/pending-clips-store'

describe('pending-clips-store', () => {
  let dir: string
  let store: PendingClipsStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-pending-'))
    store = createPendingClipsStore(dir, 'user-1')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('listUnacked() empty initially', async () => {
    expect(await store.listUnacked()).toEqual([])
  })

  test('enqueue + listUnacked returns insertion order', async () => {
    await store.enqueue({ id: 'a', text: 'first' })
    await store.enqueue({ id: 'b', text: 'second' })
    const items = await store.listUnacked()
    expect(items.map((c) => c.id)).toEqual(['a', 'b'])
    expect(items.every((c) => !c.ackedAt)).toBe(true)
  })

  test('ack() marks clip as delivered; subsequent listUnacked excludes it', async () => {
    await store.enqueue({ id: 'a', text: 'hello' })
    expect(await store.ack('a')).toBe(true)
    expect(await store.listUnacked()).toEqual([])
    // Repeat ack returns false (already acked)
    expect(await store.ack('a')).toBe(false)
  })

  test('ack() returns false for unknown id', async () => {
    expect(await store.ack('nope')).toBe(false)
  })

  test('per-user isolation: two stores in same dataDir do not share state', async () => {
    const userA = createPendingClipsStore(dir, 'user-A')
    const userB = createPendingClipsStore(dir, 'user-B')
    await userA.enqueue({ id: 'x', text: 'for A' })
    expect(await userA.listUnacked()).toHaveLength(1)
    expect(await userB.listUnacked()).toHaveLength(0)
  })

  test('pruneAcked() drops only acked clips older than the cutoff', async () => {
    await store.enqueue({ id: 'old', text: 'old' })
    await store.enqueue({ id: 'recent', text: 'recent' })
    await store.enqueue({ id: 'unacked', text: 'unacked' })
    await store.ack('old')
    await store.ack('recent')

    // Manually backdate 'old' so it's older than the cutoff. We bypass the
    // store's API here just to set up the test; this isn't part of the contract.
    const file = join(dir, 'users', 'user-1', 'pending-clips.json')
    const raw = await Bun.file(file).text()
    const items = JSON.parse(raw) as Array<{ id: string; ackedAt?: string }>
    const old = items.find((c) => c.id === 'old')!
    old.ackedAt = '2020-01-01T00:00:00.000Z'
    await Bun.write(file, JSON.stringify(items, null, 2))

    const removed = await store.pruneAcked(new Date('2021-01-01T00:00:00.000Z'))
    expect(removed).toBe(1)
    // 'unacked' must remain regardless of age; 'recent' was acked just now (after cutoff).
    const remaining = (await store.listUnacked()).map((c) => c.id)
    expect(remaining).toEqual(['unacked'])
  })
})
