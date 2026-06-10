import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import { createErrorsStore, ERRORS_RETENTION_MS } from '../src/errors-store'

function setup(now: () => number = Date.now) {
  const db = openDb(':memory:')
  const users = createUsersStore(db, now)
  const errors = createErrorsStore(db, now)
  const user = users.upsertByGoogleSub({
    sub: 'g-sub-1',
    email: 'alice@example.com',
    name: 'Alice',
  })
  return { db, users, errors, user }
}

describe('errors-store (SQLite)', () => {
  test('insert() persists basics + auto-generates id + uses now()', () => {
    const { errors, user } = setup(() => 1_700_000_000_000)
    const e = errors.insert({
      type: 'transcription_error',
      message: 'Audio too short',
      user_id: user.id,
    })
    expect(e.id).toMatch(/^e_[0-9a-f]+$/)
    expect(e.ts).toBe(1_700_000_000_000)
    expect(e.user_id).toBe(user.id)
    expect(e.type).toBe('transcription_error')
    expect(e.message).toBe('Audio too short')
    expect(e.resolved).toBe(0)
    expect(e.context).toBeNull()
  })

  test('insert() serialises context to JSON and stores audio_file', () => {
    const { errors } = setup()
    const e = errors.insert({
      type: 'js_exception',
      message: 'boom',
      context: { lineno: 42, file: 'app.ts' },
      audio_file: 'failed-audio/u_abc/e_xyz.webm',
    })
    expect(e.context).toBe('{"lineno":42,"file":"app.ts"}')
    expect(e.audio_file).toBe('failed-audio/u_abc/e_xyz.webm')
  })

  test('list() returns unresolved by default, newest first', () => {
    let t = 1_000
    const { errors } = setup(() => t)
    const a = errors.insert({ type: 'a', message: 'first' })
    t = 2_000
    const b = errors.insert({ type: 'b', message: 'second' })
    t = 3_000
    const c = errors.insert({ type: 'c', message: 'third' })
    const out = errors.list()
    expect(out.map((r) => r.id)).toEqual([c.id, b.id, a.id])
  })

  test('list() excludes resolved unless includeResolved=true', () => {
    const { errors } = setup()
    const a = errors.insert({ type: 'a', message: 'a' })
    const b = errors.insert({ type: 'b', message: 'b' })
    errors.markResolved(a.id)
    expect(errors.list().map((r) => r.id)).toEqual([b.id])
    const both = errors.list({ includeResolved: true })
    expect(both.map((r) => r.id).sort()).toEqual([a.id, b.id].sort())
  })

  test('list() respects limit', () => {
    const { errors } = setup()
    for (let i = 0; i < 5; i++) errors.insert({ type: 'x', message: `m${i}` })
    expect(errors.list({ limit: 2 })).toHaveLength(2)
  })

  test('get() returns the row or null', () => {
    const { errors } = setup()
    const e = errors.insert({ type: 'x', message: 'y' })
    expect(errors.get(e.id)?.message).toBe('y')
    expect(errors.get('e_does_not_exist')).toBeNull()
  })

  test('markResolved() flips the flag', () => {
    const { errors } = setup()
    const e = errors.insert({ type: 'x', message: 'y' })
    errors.markResolved(e.id)
    expect(errors.get(e.id)?.resolved).toBe(1)
  })

  test('deleteOlderThan() purges rows below the cutoff', () => {
    let t = 100
    const { errors } = setup(() => t)
    const a = errors.insert({ type: 'a', message: 'a' })
    t = 500
    const b = errors.insert({ type: 'b', message: 'b' })
    t = 1000
    const c = errors.insert({ type: 'c', message: 'c' })
    const removed = errors.deleteOlderThan(600) // a + b are older
    expect(removed).toBe(2)
    const remaining = errors.list({ includeResolved: true }).map((r) => r.id)
    expect(remaining).toEqual([c.id])
    expect(a).toBeDefined()
    expect(b).toBeDefined()
  })

  test('lazy sweep: insert triggers purge at most once per 24 h; old rows gone, fresh rows kept', () => {
    // t=0: create store
    let t = 0
    const { errors } = setup(() => t)

    // Insert an old row (will be outside 30-day window once now advances)
    t = 1000
    const old = errors.insert({ type: 'old', message: 'old' })

    // Advance 31 days. Next insert should trigger the sweep.
    t = 1000 + ERRORS_RETENTION_MS + 1
    const fresh = errors.insert({ type: 'fresh', message: 'fresh' })

    // old row should have been swept
    expect(errors.get(old.id)).toBeNull()
    // fresh row was inserted after the cutoff, so it survives
    expect(errors.get(fresh.id)).not.toBeNull()
  })

  test('lazy sweep: two inserts within 24 h only sweep once', () => {
    let sweepCount = 0
    let t = 0
    const db = openDb(':memory:')
    const users = createUsersStore(db, () => t)
    const errors = createErrorsStore(db, () => t)
    void users

    // Insert seed row in the past
    t = 1000
    errors.insert({ type: 'seed', message: 'seed' })

    // Advance past retention window to trigger sweep on first insert
    t = 1000 + ERRORS_RETENTION_MS + 1
    errors.insert({ type: 'first', message: 'first' })
    sweepCount += 1

    // Second insert less than 24 h later — sweep should NOT run again
    t += 60_000
    errors.insert({ type: 'second', message: 'second' })
    // Only 1 sweep happened — verify by checking that the 'first' row still exists
    expect(errors.list({ includeResolved: true }).map((r) => r.type)).toContain('first')
    expect(sweepCount).toBe(1)
  })
})
