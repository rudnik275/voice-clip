import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import { createInvitesStore } from '../src/invites-store'

function setup(now: () => number = Date.now) {
  const db = openDb(':memory:')
  const users = createUsersStore(db, now)
  const invites = createInvitesStore(db, now)
  const owner = users.upsertByGoogleSub({
    sub: 'g-owner',
    email: 'owner@example.com',
    name: 'Owner',
  })
  const friend = users.upsertByGoogleSub({
    sub: 'g-friend',
    email: 'friend@example.com',
    name: 'Friend',
  })
  return { db, users, invites, owner, friend }
}

describe('invites-store (SQLite)', () => {
  test('create() returns a 64-char hex token + records creator', () => {
    const { invites, owner } = setup()
    const inv = invites.create(owner.id)
    expect(inv.token).toMatch(/^[0-9a-f]{64}$/)
    expect(inv.created_by_user_id).toBe(owner.id)
    expect(inv.used_at).toBeNull()
    expect(inv.used_by_user_id).toBeNull()
  })

  test('get() returns the row or null', () => {
    const { invites, owner } = setup()
    const inv = invites.create(owner.id)
    expect(invites.get(inv.token)?.token).toBe(inv.token)
    expect(invites.get('does-not-exist')).toBeNull()
  })

  test('consume() flips used_at + used_by_user_id + used_by_email', () => {
    const { invites, owner, friend } = setup()
    const inv = invites.create(owner.id)
    const consumed = invites.consume(inv.token, friend.id, 'Friend@Example.com')
    expect(consumed).not.toBeNull()
    expect(consumed!.used_by_user_id).toBe(friend.id)
    expect(consumed!.used_by_email).toBe('friend@example.com')
    expect(consumed!.used_at).toBeGreaterThan(0)
  })

  test('consume() refuses a second consumption (race-safe)', () => {
    const { invites, owner, friend } = setup()
    const inv = invites.create(owner.id)
    expect(invites.consume(inv.token, friend.id, friend.email)).not.toBeNull()
    expect(invites.consume(inv.token, friend.id, friend.email)).toBeNull()
  })

  test('listByCreator() returns the creator\'s invites newest-first', () => {
    let t = 1_000
    const { invites, owner } = setup(() => t)
    const a = invites.create(owner.id)
    t = 2_000
    const b = invites.create(owner.id)
    const rows = invites.listByCreator(owner.id)
    expect(rows.map((r) => r.token)).toEqual([b.token, a.token])
  })
})
