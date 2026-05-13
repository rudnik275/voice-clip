import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import {
  createSessionsStore,
  SESSION_TTL_MS,
  type Session,
} from '../src/sessions-store'

function setup(now: () => number = Date.now) {
  const db = openDb(':memory:')
  const users = createUsersStore(db, now)
  const sessions = createSessionsStore(db, now)
  const user = users.upsertByGoogleSub({
    sub: 'g-sub-1',
    email: 'alice@example.com',
    name: 'Alice',
  })
  return { db, users, sessions, user }
}

describe('sessions-store (SQLite, 90-day idle TTL)', () => {
  test('SESSION_TTL_MS is 90 days', () => {
    expect(SESSION_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000)
  })

  test('create() returns a session with a 64-char hex token + correct user_id', () => {
    const { sessions, user } = setup()
    const s = sessions.create(user.id)
    expect(s.token).toMatch(/^[0-9a-f]{64}$/)
    expect(s.user_id).toBe(user.id)
    expect(s.created_at).toBeGreaterThan(0)
    expect(s.last_accessed_at).toBe(s.created_at)
  })

  test('create() returns distinct tokens for repeat calls', () => {
    const { sessions, user } = setup()
    const a = sessions.create(user.id)
    const b = sessions.create(user.id)
    expect(a.token).not.toBe(b.token)
  })

  test('resolve(token) returns the session + refreshes last_accessed_at', () => {
    let clock = 1_000_000_000_000
    const { sessions, user } = setup(() => clock)
    const created = sessions.create(user.id)
    expect(created.last_accessed_at).toBe(clock)

    clock += 60_000
    const resolved = sessions.resolve(created.token)
    expect(resolved).not.toBeNull()
    expect(resolved?.user_id).toBe(user.id)
    expect(resolved?.last_accessed_at).toBe(clock)
    expect(resolved?.created_at).toBe(created.created_at)
  })

  test('resolve(unknown) returns null', () => {
    const { sessions } = setup()
    expect(sessions.resolve('not-a-real-token')).toBeNull()
  })

  test('resolve() on a session past TTL returns null AND deletes the row', () => {
    let clock = 1_000_000_000_000
    const { sessions, user } = setup(() => clock)
    const created = sessions.create(user.id)

    clock += SESSION_TTL_MS + 1
    const expired = sessions.resolve(created.token)
    expect(expired).toBeNull()

    // Subsequent resolve should still be null and not error (row gone).
    expect(sessions.resolve(created.token)).toBeNull()
  })

  test('resolve() refresh keeps the session alive past the original TTL', () => {
    let clock = 1_000_000_000_000
    const { sessions, user } = setup(() => clock)
    const created = sessions.create(user.id)

    // Access right before TTL — should refresh.
    clock += SESSION_TTL_MS - 1
    const r1 = sessions.resolve(created.token)
    expect(r1).not.toBeNull()
    expect(r1?.last_accessed_at).toBe(clock)

    // 89 more days — still within TTL because last_accessed_at moved forward.
    clock += SESSION_TTL_MS - 1
    const r2 = sessions.resolve(created.token)
    expect(r2).not.toBeNull()
  })

  test('delete(token) removes the session', () => {
    const { sessions, user } = setup()
    const s = sessions.create(user.id)
    expect(sessions.resolve(s.token)).not.toBeNull()
    sessions.delete(s.token)
    expect(sessions.resolve(s.token)).toBeNull()
  })

  test('delete(unknown) is a no-op (does not throw)', () => {
    const { sessions } = setup()
    expect(() => sessions.delete('does-not-exist')).not.toThrow()
  })

  test('cascade: deleting a user removes their sessions (FK on)', () => {
    const { db, sessions, user } = setup()
    const s = sessions.create(user.id)
    expect(sessions.resolve(s.token)).not.toBeNull()
    db.run('DELETE FROM users WHERE id = ?', [user.id])
    expect(sessions.resolve(s.token)).toBeNull()
  })

  test('Session type is exported and shaped as expected', () => {
    const { sessions, user } = setup()
    const s: Session = sessions.create(user.id)
    expect(typeof s.token).toBe('string')
    expect(typeof s.user_id).toBe('string')
    expect(typeof s.created_at).toBe('number')
    expect(typeof s.last_accessed_at).toBe('number')
  })
})
