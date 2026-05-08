import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionsStore, type SessionsStore } from '../src/sessions-store'

describe('sessions-store', () => {
  let dir: string
  let store: SessionsStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-sessions-'))
    store = createSessionsStore(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('create() returns session with token + userId + createdAt; resolves via get()', async () => {
    const s = await store.create('user-1')
    expect(s.token).toMatch(/^[a-f0-9]+$/)
    expect(s.userId).toBe('user-1')
    expect(s.createdAt).toBeString()
    expect(await store.get(s.token)).toEqual(s)
  })

  test('get() returns null for missing/empty token', async () => {
    expect(await store.get('')).toBeNull()
    expect(await store.get('unknown')).toBeNull()
  })

  test('delete() removes session and returns true', async () => {
    const s = await store.create('user-1')
    expect(await store.delete(s.token)).toBe(true)
    expect(await store.get(s.token)).toBeNull()
    expect(await store.delete(s.token)).toBe(false)
  })

  test('two sessions for the same user coexist independently', async () => {
    const a = await store.create('user-1')
    const b = await store.create('user-1')
    expect(a.token).not.toBe(b.token)
    expect(await store.get(a.token)).toEqual(a)
    expect(await store.get(b.token)).toEqual(b)
    await store.delete(a.token)
    expect(await store.get(b.token)).toEqual(b)
  })
})
