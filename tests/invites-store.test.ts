import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import { createInvitesStore } from '../src/invites-store'
import { createAllowedEmailsStore } from '../src/allowed-emails-store'

function setup(now: () => number = Date.now) {
  const db = openDb(':memory:')
  const users = createUsersStore(db, now)
  const invites = createInvitesStore(db, now)
  const allowedEmails = createAllowedEmailsStore(db, now)
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
  return { db, users, invites, allowedEmails, owner, friend }
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

  test('consumeAndAllow() flips used_at + used_by_email and adds the allowlist row', () => {
    const { invites, allowedEmails, owner } = setup()
    const inv = invites.create(owner.id)
    const consumed = invites.consumeAndAllow(inv.token, 'Friend@Example.com', () =>
      allowedEmails.add('Friend@Example.com', 'invite', owner.id),
    )
    expect(consumed).not.toBeNull()
    // used_by_user_id stays NULL until setUsedBy() backfills it (validate-first).
    expect(consumed!.used_by_user_id).toBeNull()
    expect(consumed!.used_by_email).toBe('friend@example.com')
    expect(consumed!.used_at).toBeGreaterThan(0)
    expect(allowedEmails.isAllowed('friend@example.com')).toBe(true)
  })

  test('setUsedBy() backfills used_by_user_id after the user row is created', () => {
    const { invites, allowedEmails, owner, friend } = setup()
    const inv = invites.create(owner.id)
    invites.consumeAndAllow(inv.token, friend.email, () =>
      allowedEmails.add(friend.email, 'invite', owner.id),
    )
    invites.setUsedBy(inv.token, friend.id)
    expect(invites.get(inv.token)?.used_by_user_id).toBe(friend.id)
  })

  test('consumeAndAllow() refuses a second consumption (race-safe) and skips addAllowed', () => {
    const { invites, allowedEmails, owner, friend } = setup()
    const inv = invites.create(owner.id)
    expect(
      invites.consumeAndAllow(inv.token, friend.email, () =>
        allowedEmails.add(friend.email, 'invite', owner.id),
      ),
    ).not.toBeNull()
    let secondAddRan = false
    expect(
      invites.consumeAndAllow(inv.token, friend.email, () => {
        secondAddRan = true
      }),
    ).toBeNull()
    expect(secondAddRan).toBe(false)
  })

  test('consumeAndAllow() rolls back the consume if addAllowed throws (atomic)', () => {
    const { invites, allowedEmails, owner } = setup()
    const inv = invites.create(owner.id)
    expect(() =>
      invites.consumeAndAllow(inv.token, 'boom@example.com', () => {
        throw new Error('allowlist insert failed')
      }),
    ).toThrow('allowlist insert failed')
    // Neither side committed: token still unused, email not allowlisted.
    expect(invites.get(inv.token)?.used_at).toBeNull()
    expect(allowedEmails.isAllowed('boom@example.com')).toBe(false)
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
