import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import { createPlansStore, monthKeyOf } from '../src/plans-store'

function setup(now: () => number = Date.now) {
  const db = openDb(':memory:')
  const users = createUsersStore(db, now)
  const plans = createPlansStore(db, now)
  const user = users.upsertByGoogleSub({
    sub: 'g-sub',
    email: 'a@b.com',
    name: 'A',
  })
  return { db, users, plans, user }
}

describe('plans-store', () => {
  test('getPlan() defaults to free when no row exists', () => {
    const { plans, user } = setup()
    expect(plans.getPlan(user.id)).toBe('free')
  })

  test('setPlan() persists; getPlan() reads it back', () => {
    const { plans, user } = setup()
    plans.setPlan(user.id, 'pro')
    expect(plans.getPlan(user.id)).toBe('pro')
    plans.setPlan(user.id, 'free')
    expect(plans.getPlan(user.id)).toBe('free')
  })

  test('incrementUsage() returns 1 on first call, then 2, 3, …', () => {
    const { plans, user } = setup()
    expect(plans.incrementUsage(user.id, '2026-05')).toBe(1)
    expect(plans.incrementUsage(user.id, '2026-05')).toBe(2)
    expect(plans.incrementUsage(user.id, '2026-05')).toBe(3)
  })

  test('incrementUsage() is per-month: separate counters', () => {
    const { plans, user } = setup()
    plans.incrementUsage(user.id, '2026-05')
    plans.incrementUsage(user.id, '2026-05')
    plans.incrementUsage(user.id, '2026-06')
    expect(plans.getUsage(user.id, '2026-05')).toBe(2)
    expect(plans.getUsage(user.id, '2026-06')).toBe(1)
  })

  test('decrementUsage() refunds a reservation and floors at 0', () => {
    const { plans, user } = setup()
    plans.incrementUsage(user.id, '2026-05')
    plans.incrementUsage(user.id, '2026-05')
    expect(plans.decrementUsage(user.id, '2026-05')).toBe(1)
    expect(plans.getUsage(user.id, '2026-05')).toBe(1)
    expect(plans.decrementUsage(user.id, '2026-05')).toBe(0)
    // Floor: extra refunds can't drive the counter negative.
    expect(plans.decrementUsage(user.id, '2026-05')).toBe(0)
    expect(plans.getUsage(user.id, '2026-05')).toBe(0)
  })

  test('decrementUsage() on a non-existent row is a no-op returning 0', () => {
    const { plans, user } = setup()
    expect(plans.decrementUsage(user.id, '2026-05')).toBe(0)
    expect(plans.getUsage(user.id, '2026-05')).toBe(0)
  })

  test('getUsage() returns 0 when no row exists yet', () => {
    const { plans, user } = setup()
    expect(plans.getUsage(user.id, '2026-05')).toBe(0)
  })

  test('monthKeyOf() emits YYYY-MM with UTC month, zero-padded', () => {
    expect(monthKeyOf(Date.UTC(2026, 0, 15))).toBe('2026-01')
    expect(monthKeyOf(Date.UTC(2026, 11, 31))).toBe('2026-12')
  })
})
