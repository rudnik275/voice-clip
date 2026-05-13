import { describe, expect, test, beforeEach } from 'bun:test'
import { openDb } from '../src/db'
import { createUsersStore, type User } from '../src/users-store'

describe('users-store (SQLite, get-or-create by google_sub)', () => {
  let store: ReturnType<typeof createUsersStore>

  beforeEach(() => {
    const db = openDb(':memory:')
    store = createUsersStore(db)
  })

  test('upsertByGoogleSub creates a new user on first login', () => {
    const u = store.upsertByGoogleSub({
      sub: 'g-sub-1',
      email: 'alice@example.com',
      name: 'Alice',
      picture_url: 'https://lh3/avatar.png',
    })
    expect(u.id).toBeString()
    expect(u.id.length).toBeGreaterThan(0)
    expect(u.google_sub).toBe('g-sub-1')
    expect(u.email).toBe('alice@example.com')
    expect(u.name).toBe('Alice')
    expect(u.picture_url).toBe('https://lh3/avatar.png')
    expect(u.created_at).toBeGreaterThan(0)
    expect(u.updated_at).toBeGreaterThanOrEqual(u.created_at)
  })

  test('upsertByGoogleSub returns the same user id on second login', () => {
    const u1 = store.upsertByGoogleSub({
      sub: 'g-sub-1',
      email: 'alice@example.com',
      name: 'Alice',
      picture_url: 'https://lh3/avatar.png',
    })
    const u2 = store.upsertByGoogleSub({
      sub: 'g-sub-1',
      email: 'alice@example.com',
      name: 'Alice',
      picture_url: 'https://lh3/avatar.png',
    })
    expect(u2.id).toBe(u1.id)
    expect(u2.created_at).toBe(u1.created_at)
  })

  test('upsertByGoogleSub updates email/name/picture_url on each login', () => {
    const u1 = store.upsertByGoogleSub({
      sub: 'g-sub-1',
      email: 'alice@example.com',
      name: 'Alice Old',
      picture_url: 'https://lh3/old.png',
    })
    const u2 = store.upsertByGoogleSub({
      sub: 'g-sub-1',
      email: 'alice.new@example.com',
      name: 'Alice New',
      picture_url: 'https://lh3/new.png',
    })
    expect(u2.id).toBe(u1.id)
    expect(u2.email).toBe('alice.new@example.com')
    expect(u2.name).toBe('Alice New')
    expect(u2.picture_url).toBe('https://lh3/new.png')
    expect(u2.updated_at).toBeGreaterThanOrEqual(u1.updated_at)
  })

  test('picture_url is optional (Google sometimes omits it)', () => {
    const u = store.upsertByGoogleSub({
      sub: 'g-sub-x',
      email: 'noavatar@example.com',
      name: 'No Avatar',
    })
    expect(u.picture_url).toBeNull()
  })

  test('different google_sub → different user rows', () => {
    const a = store.upsertByGoogleSub({ sub: 'g-sub-a', email: 'a@x.com', name: 'A' })
    const b = store.upsertByGoogleSub({ sub: 'g-sub-b', email: 'b@x.com', name: 'B' })
    expect(a.id).not.toBe(b.id)
  })

  test('findById returns the user when present', () => {
    const u = store.upsertByGoogleSub({ sub: 'g-sub-1', email: 'a@x.com', name: 'A' })
    const got = store.findById(u.id)
    expect(got).toMatchObject({ id: u.id, google_sub: 'g-sub-1', email: 'a@x.com' })
  })

  test('findById returns null for an unknown id', () => {
    expect(store.findById('does-not-exist')).toBeNull()
  })

  test('User type is exported and shaped as expected', () => {
    const u: User = store.upsertByGoogleSub({ sub: 'g-sub-1', email: 'a@x.com', name: 'A' })
    // Compile-time + runtime check.
    expect(typeof u.id).toBe('string')
    expect(typeof u.email).toBe('string')
    expect(typeof u.name).toBe('string')
  })

  test('accepts an injectable `now` clock for deterministic timestamps', () => {
    const db = openDb(':memory:')
    const fixed = 1_700_000_000_000
    const s = createUsersStore(db, () => fixed)
    const u = s.upsertByGoogleSub({ sub: 'g-sub-1', email: 'a@x.com', name: 'A' })
    expect(u.created_at).toBe(fixed)
    expect(u.updated_at).toBe(fixed)
  })
})
