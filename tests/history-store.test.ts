import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import { createHistoryStore, type HistoryStore } from '../src/history-store'

function setup(now: () => number = Date.now) {
  const db = openDb(':memory:')
  const users = createUsersStore(db, now)
  const history = createHistoryStore(db, now)
  const alice = users.upsertByGoogleSub({ sub: 'g-a', email: 'a@x.com', name: 'Alice' })
  const bob = users.upsertByGoogleSub({ sub: 'g-b', email: 'b@x.com', name: 'Bob' })
  return { db, users, history, alice, bob }
}

function append(history: HistoryStore, userId: string, text: string, recordedAt: string) {
  return history.append({ userId, text, recordedAt, source: 'online', costUsd: 0.001 })
}

describe('history-store (SQLite, monotonic seq)', () => {
  test('append() returns a row with a positive monotonic seq', () => {
    const { history, alice } = setup()
    const a = append(history, alice.id, 'first', '2026-05-17T10:00:00.000Z')
    const b = append(history, alice.id, 'second', '2026-05-17T10:01:00.000Z')
    expect(a.seq).toBeGreaterThan(0)
    expect(b.seq).toBeGreaterThan(a.seq)
  })

  test('seq is globally monotonic across users (a single sequence)', () => {
    const { history, alice, bob } = setup()
    const a = append(history, alice.id, 'a1', '2026-05-17T10:00:00.000Z')
    const b = append(history, bob.id, 'b1', '2026-05-17T10:00:30.000Z')
    const a2 = append(history, alice.id, 'a2', '2026-05-17T10:01:00.000Z')
    expect(b.seq).toBeGreaterThan(a.seq)
    expect(a2.seq).toBeGreaterThan(b.seq)
  })

  test('append() persists text, source, recordedAt, costUsd and a server ts', () => {
    let clock = 1_700_000_000_000
    const { history, alice } = setup(() => clock)
    const row = history.append({
      userId: alice.id,
      text: 'hello world',
      recordedAt: '2026-05-17T10:00:00.000Z',
      source: 'online',
      costUsd: 0.0042,
    })
    expect(row.text).toBe('hello world')
    expect(row.source).toBe('online')
    expect(row.recordedAt).toBe('2026-05-17T10:00:00.000Z')
    expect(row.costUsd).toBeCloseTo(0.0042, 8)
    expect(row.ts).toBe(clock)
    expect(row.userId).toBe(alice.id)
  })

  test('list() returns a user clips newest-first (by seq, the insert order)', () => {
    const { history, alice } = setup()
    append(history, alice.id, 'first', '2026-05-17T10:00:00.000Z')
    append(history, alice.id, 'second', '2026-05-17T10:01:00.000Z')
    append(history, alice.id, 'third', '2026-05-17T10:02:00.000Z')
    const page = history.list(alice.id, {})
    expect(page.items.map((i) => i.text)).toEqual(['third', 'second', 'first'])
    // recordedAt round-trips intact for each clip.
    expect(page.items[0]?.recordedAt).toBe('2026-05-17T10:02:00.000Z')
  })

  test('list() isolates users — Bob never sees Alice clips', () => {
    const { history, alice, bob } = setup()
    append(history, alice.id, 'alice-secret', '2026-05-17T10:00:00.000Z')
    append(history, bob.id, 'bob-note', '2026-05-17T10:01:00.000Z')
    const bobPage = history.list(bob.id, {})
    expect(bobPage.items).toHaveLength(1)
    expect(bobPage.items[0]?.text).toBe('bob-note')
  })

  test('list() honours limit and exposes a since cursor for pagination', () => {
    const { history, alice } = setup()
    for (let i = 0; i < 5; i++) {
      append(history, alice.id, `clip-${i}`, `2026-05-17T10:0${i}:00.000Z`)
    }
    const first = history.list(alice.id, { limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.items.map((i) => i.text)).toEqual(['clip-4', 'clip-3'])
    expect(first.nextSince).toBeDefined()

    const second = history.list(alice.id, { limit: 2, since: first.nextSince })
    expect(second.items.map((i) => i.text)).toEqual(['clip-2', 'clip-1'])

    const third = history.list(alice.id, { limit: 2, since: second.nextSince })
    expect(third.items.map((i) => i.text)).toEqual(['clip-0'])
    expect(third.nextSince).toBeUndefined()
  })

  test('listSince(userId, seq) returns all clips with seq > X for that user, oldest-first', () => {
    const { history, alice, bob } = setup()
    const a1 = append(history, alice.id, 'a1', '2026-05-17T10:00:00.000Z')
    append(history, bob.id, 'b1', '2026-05-17T10:00:30.000Z')
    const a2 = append(history, alice.id, 'a2', '2026-05-17T10:01:00.000Z')
    const a3 = append(history, alice.id, 'a3', '2026-05-17T10:02:00.000Z')

    const replay = history.listSince(alice.id, a1.seq)
    expect(replay.map((r) => r.text)).toEqual(['a2', 'a3'])
    expect(replay[0]?.seq).toBe(a2.seq)
    expect(replay[1]?.seq).toBe(a3.seq)
  })

  test('getBySeq returns the owner clip and undefined for a missing seq', () => {
    const { history, alice } = setup()
    const a1 = append(history, alice.id, 'a1', '2026-05-17T10:00:00.000Z')
    const got = history.getBySeq(alice.id, a1.seq)
    expect(got?.text).toBe('a1')
    expect(got?.seq).toBe(a1.seq)
    expect(history.getBySeq(alice.id, a1.seq + 999)).toBeUndefined()
  })

  test('getBySeq is owner-scoped — Bob cannot read an Alice clip by seq', () => {
    const { history, alice, bob } = setup()
    const a1 = append(history, alice.id, 'alice-secret', '2026-05-17T10:00:00.000Z')
    expect(history.getBySeq(bob.id, a1.seq)).toBeUndefined()
  })

  test('clear(userId) deletes that user history only', () => {
    const { history, alice, bob } = setup()
    append(history, alice.id, 'a1', '2026-05-17T10:00:00.000Z')
    append(history, bob.id, 'b1', '2026-05-17T10:00:30.000Z')
    history.clear(alice.id)
    expect(history.list(alice.id, {}).items).toHaveLength(0)
    expect(history.list(bob.id, {}).items).toHaveLength(1)
  })

  test('seq keeps climbing after a clear (no reuse)', () => {
    const { history, alice } = setup()
    const a1 = append(history, alice.id, 'a1', '2026-05-17T10:00:00.000Z')
    history.clear(alice.id)
    const a2 = append(history, alice.id, 'a2', '2026-05-17T10:01:00.000Z')
    expect(a2.seq).toBeGreaterThan(a1.seq)
  })
})
