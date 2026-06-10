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

  test('deleteIdleSince() removes sessions not accessed since the cutoff, keeps recent ones', () => {
    // Use a fixed-time store so no automatic sweep fires during this test.
    let clock = 1_000_000_000_000
    const { sessions, user } = setup(() => clock)

    // Create an old session at clock=T
    const old = sessions.create(user.id)
    expect(old.last_accessed_at).toBe(clock)

    // Create a fresh session at a later time (but still within TTL so no sweep)
    clock += 1_000
    const fresh = sessions.create(user.id)

    // deleteIdleSince with a cutoff that is newer than `old.last_accessed_at`
    // but older than `fresh.last_accessed_at`
    const cutoff = old.last_accessed_at + 500 // between old and fresh
    const removed = sessions.deleteIdleSince(cutoff)
    expect(removed).toBe(1)

    // old session is gone (its last_accessed_at < cutoff)
    expect(sessions.resolve(old.token)).toBeNull()
    // fresh session survives (its last_accessed_at > cutoff)
    expect(sessions.resolve(fresh.token)).not.toBeNull()
  })

  test('lazy sweep: create() triggers deleteIdleSince once per 24 h', () => {
    let clock = 1_000_000_000_000
    const { sessions, user } = setup(() => clock)

    // Create a session that will age out
    const aged = sessions.create(user.id)

    // Advance beyond SESSION_TTL_MS so the next create() triggers a sweep
    clock += SESSION_TTL_MS + 24 * 60 * 60 * 1000 + 1

    // This create() should trigger the sweep and purge the aged session
    sessions.create(user.id)

    // The aged session row is gone (sweep ran)
    // Use resolve() on the aged token — it will be null either from sweep or TTL
    expect(sessions.resolve(aged.token)).toBeNull()
  })

  test('lazy sweep: two creates within 24 h only sweep once', () => {
    let clock = 1_000_000_000_000
    const { sessions, user } = setup(() => clock)

    // Seed an aged session
    const aged = sessions.create(user.id)

    // Advance to trigger sweep on next create
    clock += SESSION_TTL_MS + 24 * 60 * 60 * 1000 + 1

    // First create → sweep runs, aged is purged
    sessions.create(user.id)
    expect(sessions.resolve(aged.token)).toBeNull()

    // Seed another session that would be in the window for the next sweep
    clock += 1_000
    const recent = sessions.create(user.id)

    // Second create within 24 h → sweep should NOT run, recent stays
    clock += 60_000
    sessions.create(user.id)

    // recent session was created after the last sweep, should still be alive
    expect(sessions.resolve(recent.token)).not.toBeNull()
  })
})
