import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { createAllowedEmailsStore } from '../src/allowed-emails-store'

function setup(now: () => number = Date.now) {
  const db = openDb(':memory:')
  return { db, store: createAllowedEmailsStore(db, now) }
}

describe('allowed-emails-store (SQLite)', () => {
  test('isAllowed: false when empty', () => {
    const { store } = setup()
    expect(store.isAllowed('alice@example.com')).toBe(false)
  })

  test('add() then isAllowed() true; case + whitespace insensitive', () => {
    const { store } = setup()
    store.add('  Alice@Example.com  ', 'invite')
    expect(store.isAllowed('alice@example.com')).toBe(true)
    expect(store.isAllowed('ALICE@EXAMPLE.COM')).toBe(true)
  })

  test('add() is idempotent — re-adding does not duplicate', () => {
    const { store } = setup()
    store.add('a@b.com', 'env')
    store.add('a@b.com', 'invite')
    expect(store.list()).toHaveLength(1)
  })

  test('seed() inserts each email with added_via=env', () => {
    const { store } = setup()
    store.seed(['a@b.com', 'C@D.com'])
    const list = store.list()
    expect(list.map((r) => r.email).sort()).toEqual(['a@b.com', 'c@d.com'])
    for (const r of list) expect(r.added_via).toBe('env')
  })

  test('add() stores invitedBy when supplied', () => {
    const { store } = setup()
    store.add('friend@example.com', 'invite', 'u_owner')
    const [row] = store.list()
    expect(row!.invited_by).toBe('u_owner')
    expect(row!.added_via).toBe('invite')
  })

  test('add() ignores empty/blank emails', () => {
    const { store } = setup()
    store.add('', 'env')
    store.add('   ', 'env')
    expect(store.list()).toHaveLength(0)
  })
})
