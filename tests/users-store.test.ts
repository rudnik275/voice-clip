import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsersStore, type UsersStore } from '../src/users-store'

describe('users-store', () => {
  let dir: string
  let store: UsersStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-users-'))
    store = createUsersStore(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('list() empty initially', async () => {
    expect(await store.list()).toEqual([])
  })

  test('create() persists user with id, name, daemonToken, createdAt', async () => {
    const u = await store.create({ name: 'dima' })
    expect(u.id).toMatch(/^[a-f0-9]+$/)
    expect(u.name).toBe('dima')
    expect(u.daemonToken).toMatch(/^[a-f0-9]+$/)
    expect(u.createdAt).toBeString()
    const fresh = createUsersStore(dir)
    expect(await fresh.list()).toEqual([u])
  })

  test('get(), getByName(), getByDaemonToken() lookups', async () => {
    const a = await store.create({ name: 'alice' })
    const b = await store.create({ name: 'bob' })
    expect(await store.get(a.id)).toEqual(a)
    expect(await store.get('nope')).toBeNull()
    expect(await store.getByName('bob')).toEqual(b)
    expect(await store.getByName('zzz')).toBeNull()
    expect(await store.getByDaemonToken(a.daemonToken)).toEqual(a)
    expect(await store.getByDaemonToken('')).toBeNull()
    expect(await store.getByDaemonToken('not-a-token')).toBeNull()
  })

  test('regenerateDaemonToken() rotates the token', async () => {
    const u = await store.create({ name: 'rot' })
    const oldToken = u.daemonToken
    const updated = await store.regenerateDaemonToken(u.id)
    expect(updated?.daemonToken).not.toBe(oldToken)
    // Old token no longer resolves
    expect(await store.getByDaemonToken(oldToken)).toBeNull()
    expect(await store.getByDaemonToken(updated!.daemonToken)).toEqual(updated)
  })

  test('regenerateDaemonToken() returns null for missing user', async () => {
    expect(await store.regenerateDaemonToken('nope')).toBeNull()
  })

  test('parallel creates do not lose users', async () => {
    const ops: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) ops.push(store.create({ name: `u${i}` }))
    await Promise.all(ops)
    const list = await store.list()
    expect(list).toHaveLength(10)
    expect(new Set(list.map((u) => u.id)).size).toBe(10)
    expect(new Set(list.map((u) => u.daemonToken)).size).toBe(10)
  })
})
