import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInvitesStore, type InvitesStore } from '../src/invites-store'

describe('invites-store', () => {
  let dir: string
  let store: InvitesStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-invites-'))
    store = createInvitesStore(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('create() returns invite with token + createdAt; persists across re-open', async () => {
    const inv = await store.create()
    expect(inv.token).toMatch(/^[a-f0-9]+$/)
    expect(inv.createdAt).toBeString()
    expect(inv.usedAt).toBeUndefined()
    const fresh = createInvitesStore(dir)
    expect(await fresh.list()).toEqual([inv])
  })

  test('consume() marks invite used and returns it on first call', async () => {
    const inv = await store.create()
    const result = await store.consume(inv.token, 'user-1')
    expect(result).not.toBeNull()
    expect(result?.usedAt).toBeString()
    expect(result?.usedBy).toBe('user-1')
  })

  test('consume() returns null on second call (single-use guarantee)', async () => {
    const inv = await store.create()
    expect(await store.consume(inv.token, 'first')).not.toBeNull()
    expect(await store.consume(inv.token, 'second')).toBeNull()
  })

  test('consume() returns null for unknown token', async () => {
    expect(await store.consume('unknown', 'user')).toBeNull()
  })

  test('parallel consume() of the same token: only one wins', async () => {
    const inv = await store.create()
    const ops = Array.from({ length: 10 }, (_, i) => store.consume(inv.token, `user-${i}`))
    const results = await Promise.all(ops)
    const wins = results.filter((r) => r !== null)
    expect(wins).toHaveLength(1)
  })
})
