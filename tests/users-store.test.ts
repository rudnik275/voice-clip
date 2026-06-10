import { describe, expect, test, beforeEach } from 'bun:test'
import { openDb, tryAddColumn, type DB } from '../src/db'
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

describe('users-store: email normalization', () => {
  let db: DB
  let store: ReturnType<typeof createUsersStore>

  beforeEach(() => {
    db = openDb(':memory:')
    store = createUsersStore(db)
  })

  test('upsert with mixed-case email → findByEmail with lowercase finds user', () => {
    store.upsertByGoogleSub({ sub: 'g-norm-1', email: 'Alice@Example.com', name: 'Alice' })
    const found = store.findByEmail('alice@example.com')
    expect(found).not.toBeNull()
    expect(found!.name).toBe('Alice')
  })

  test('upsert with mixed-case email → findByEmail with uppercase finds user', () => {
    store.upsertByGoogleSub({ sub: 'g-norm-2', email: 'Alice@Example.com', name: 'Alice' })
    const found = store.findByEmail('ALICE@EXAMPLE.COM')
    expect(found).not.toBeNull()
    expect(found!.name).toBe('Alice')
  })

  test('stored email is always lowercase regardless of input casing', () => {
    const u = store.upsertByGoogleSub({ sub: 'g-norm-3', email: 'Bob@Example.COM', name: 'Bob' })
    expect(u.email).toBe('bob@example.com')
  })

  test('update path also normalizes email (second upsert)', () => {
    store.upsertByGoogleSub({ sub: 'g-norm-4', email: 'carol@example.com', name: 'Carol' })
    // Simulate Google returning mixed-case on second login
    const u2 = store.upsertByGoogleSub({ sub: 'g-norm-4', email: 'Carol@Example.COM', name: 'Carol' })
    expect(u2.email).toBe('carol@example.com')
    const found = store.findByEmail('carol@example.com')
    expect(found).not.toBeNull()
  })
})

describe('openDb: PRAGMA busy_timeout', () => {
  test('busy_timeout is set to 5000 ms on :memory: DB', () => {
    const db = openDb(':memory:')
    const row = db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()
    expect(row).not.toBeNull()
    expect(row!.timeout).toBe(5000)
    db.close()
  })
})

describe('openDb: migration idempotency', () => {
  test('opening the same file twice succeeds (duplicate-column path swallowed)', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'voice-clip-db-migrate-'))
    try {
      const path = join(dir, 'test.sqlite')
      // First open runs all migrations
      const db1 = openDb(path)
      db1.close()
      // Second open re-runs migrations — duplicate-column errors must be swallowed
      expect(() => openDb(path)).not.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('tryAddColumn: error propagation', () => {
  test('swallows "duplicate column name" errors', () => {
    const db = openDb(':memory:')
    // Add a column once (succeeds)
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    tryAddColumn(db, 'ALTER TABLE t ADD COLUMN foo TEXT')
    // Run again — duplicate column, should be swallowed
    expect(() => tryAddColumn(db, 'ALTER TABLE t ADD COLUMN foo TEXT')).not.toThrow()
    db.close()
  })

  test('rethrows errors that are NOT about duplicate columns', () => {
    const db = openDb(':memory:')
    // This SQL is syntactically invalid — triggers an error unrelated to duplicate columns
    expect(() => tryAddColumn(db, 'ALTER TABLE nonexistent_table ADD COLUMN x TEXT')).toThrow()
    db.close()
  })
})
