import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import { createHistoryStore } from '../src/history-store'
import { createCostStore } from '../src/cost-store'

function setup() {
  const db = openDb(':memory:')
  const users = createUsersStore(db)
  const costs = createCostStore(db)
  const history = createHistoryStore(db)
  const alice = users.upsertByGoogleSub({ sub: 'g-a', email: 'a@x.com', name: 'Alice' })
  const bob = users.upsertByGoogleSub({ sub: 'g-b', email: 'b@x.com', name: 'Bob' })
  return { db, users, costs, history, alice, bob }
}

describe('cost-store (SQLite, atomic per-user + aggregate)', () => {
  test('a fresh user/aggregate read returns 0', () => {
    const { costs, alice } = setup()
    expect(costs.userTotal(alice.id)).toBe(0)
    expect(costs.aggregateTotal()).toBe(0)
  })

  test('add() increments the user total AND the aggregate', () => {
    const { costs, alice } = setup()
    costs.add(alice.id, 0.0012)
    expect(costs.userTotal(alice.id)).toBeCloseTo(0.0012, 8)
    expect(costs.aggregateTotal()).toBeCloseTo(0.0012, 8)
  })

  test('add() accumulates across multiple calls', () => {
    const { costs, alice } = setup()
    costs.add(alice.id, 0.001)
    costs.add(alice.id, 0.002)
    costs.add(alice.id, 0.003)
    expect(costs.userTotal(alice.id)).toBeCloseTo(0.006, 8)
    expect(costs.aggregateTotal()).toBeCloseTo(0.006, 8)
  })

  test('aggregate is the sum across ALL users; per-user totals stay isolated', () => {
    const { costs, alice, bob } = setup()
    costs.add(alice.id, 0.01)
    costs.add(bob.id, 0.02)
    expect(costs.userTotal(alice.id)).toBeCloseTo(0.01, 8)
    expect(costs.userTotal(bob.id)).toBeCloseTo(0.02, 8)
    expect(costs.aggregateTotal()).toBeCloseTo(0.03, 8)
  })

  test('add() applies the per-user and aggregate write in a SINGLE transaction (all-or-nothing)', () => {
    const { db, costs, alice } = setup()
    // Spy on db.transaction to prove add() wraps the two writes in one tx.
    let txCount = 0
    const realTransaction = db.transaction.bind(db)
    // @ts-expect-error — test-only monkeypatch
    db.transaction = (fn: () => void) => {
      const wrapped = realTransaction(fn)
      return (...args: unknown[]) => {
        txCount++
        return (wrapped as (...a: unknown[]) => unknown)(...args)
      }
    }
    // Rebuild the store so it picks up the patched db.transaction.
    const patched = createCostStore(db)
    patched.add(alice.id, 0.005)
    expect(txCount).toBe(1)
    expect(patched.userTotal(alice.id)).toBeCloseTo(0.005, 8)
    expect(patched.aggregateTotal()).toBeCloseTo(0.005, 8)
  })

  test('clearing history does NOT reset the aggregate (cost survives history.clear)', () => {
    const { costs, history, alice } = setup()
    costs.add(alice.id, 0.05)
    history.append({
      userId: alice.id,
      text: 'x',
      recordedAt: '2026-05-17T10:00:00.000Z',
      source: 'online',
      costUsd: 0.05,
    })
    history.clear(alice.id)
    expect(history.list(alice.id, {}).items).toHaveLength(0)
    // Aggregate (and per-user) cost untouched by the history wipe.
    expect(costs.aggregateTotal()).toBeCloseTo(0.05, 8)
    expect(costs.userTotal(alice.id)).toBeCloseTo(0.05, 8)
  })

  test('userTotal for an unknown user is 0 (no row yet)', () => {
    const { costs } = setup()
    expect(costs.userTotal('u_never_seen')).toBe(0)
  })
})
