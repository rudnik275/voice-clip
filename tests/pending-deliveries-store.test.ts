import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import { createDevicesStore } from '../src/devices-store'
import {
  createPendingDeliveriesStore,
  PENDING_DELIVERIES_RETENTION_MS,
} from '../src/pending-deliveries-store'

function setup(now: () => number = Date.now) {
  const db = openDb(':memory:')
  const users = createUsersStore(db, now)
  const devices = createDevicesStore(db, now)
  const pending = createPendingDeliveriesStore(db, now)
  const user = users.upsertByGoogleSub({
    sub: 'g-sub-1',
    email: 'alice@example.com',
    name: 'Alice',
  })
  const device = devices.create(user.id)
  return { db, users, devices, pending, user, device }
}

describe('pending-deliveries-store (SQLite)', () => {
  test('enqueue then listByDevice returns the seq (default source online)', () => {
    const { pending, device } = setup()
    pending.enqueue(device.id, 7)
    expect(pending.listByDevice(device.id)).toEqual([{ seq: 7, source: 'online' }])
  })

  test('enqueue persists the delivery intent (source) per row', () => {
    const { pending, device } = setup()
    pending.enqueue(device.id, 1, 'offline')
    pending.enqueue(device.id, 2, 'online')
    expect(pending.listByDevice(device.id)).toEqual([
      { seq: 1, source: 'offline' },
      { seq: 2, source: 'online' },
    ])
  })

  test('listByDevice returns rows ordered by seq ASC regardless of insert order', () => {
    const { pending, device } = setup()
    pending.enqueue(device.id, 30)
    pending.enqueue(device.id, 10)
    pending.enqueue(device.id, 20)
    expect(pending.listByDevice(device.id)).toEqual([
      { seq: 10, source: 'online' },
      { seq: 20, source: 'online' },
      { seq: 30, source: 'online' },
    ])
  })

  test('listByDevice is scoped per device', () => {
    const { db, users, devices, pending, user } = setup()
    const a = devices.create(user.id, 'Mac A')
    const other = users.upsertByGoogleSub({ sub: 'g2', email: 'bob@example.com', name: 'Bob' })
    const b = devices.create(other.id, 'Bob Mac')
    pending.enqueue(a.id, 1)
    pending.enqueue(a.id, 2)
    pending.enqueue(b.id, 9)
    expect(pending.listByDevice(a.id)).toEqual([
      { seq: 1, source: 'online' },
      { seq: 2, source: 'online' },
    ])
    expect(pending.listByDevice(b.id)).toEqual([{ seq: 9, source: 'online' }])
    void db
  })

  test('enqueue is idempotent for a repeated (device, seq) pair', () => {
    const { pending, device } = setup()
    pending.enqueue(device.id, 5)
    pending.enqueue(device.id, 5)
    pending.enqueue(device.id, 5)
    expect(pending.listByDevice(device.id)).toEqual([{ seq: 5, source: 'online' }])
  })

  test('deleteBySeq removes only the matching row and is idempotent', () => {
    const { pending, device } = setup()
    pending.enqueue(device.id, 1)
    pending.enqueue(device.id, 2)
    pending.deleteBySeq(device.id, 1)
    expect(pending.listByDevice(device.id)).toEqual([{ seq: 2, source: 'online' }])
    // Deleting a seq that is no longer there (or never was) does not throw.
    expect(() => pending.deleteBySeq(device.id, 1)).not.toThrow()
    expect(() => pending.deleteBySeq(device.id, 999)).not.toThrow()
    expect(pending.listByDevice(device.id)).toEqual([{ seq: 2, source: 'online' }])
  })

  test('deleteByDevice clears the whole queue for that device only', () => {
    const { devices, pending, user } = setup()
    const a = devices.create(user.id, 'Mac A')
    const b = devices.create(user.id, 'Mac B')
    pending.enqueue(a.id, 1)
    pending.enqueue(a.id, 2)
    pending.enqueue(b.id, 3)
    pending.deleteByDevice(a.id)
    expect(pending.listByDevice(a.id)).toEqual([])
    expect(pending.listByDevice(b.id)).toEqual([{ seq: 3, source: 'online' }])
  })

  test('cascade: deleting a device removes its pending rows (FK ON DELETE CASCADE)', () => {
    const { db, pending, device } = setup()
    pending.enqueue(device.id, 1)
    pending.enqueue(device.id, 2)
    expect(pending.listByDevice(device.id)).toHaveLength(2)
    db.run('DELETE FROM devices WHERE id = ?', [device.id])
    expect(pending.listByDevice(device.id)).toEqual([])
  })

  test('cascade: deleting the owning user removes pending rows transitively', () => {
    const { db, pending, device, user } = setup()
    pending.enqueue(device.id, 1)
    expect(pending.listByDevice(device.id)).toHaveLength(1)
    db.run('DELETE FROM users WHERE id = ?', [user.id])
    expect(pending.listByDevice(device.id)).toEqual([])
  })

  test('deleteOlderThan() removes rows created before the cutoff, keeps newer ones', () => {
    let t = 1000
    const { pending, devices, user } = setup(() => t)
    const d = devices.create(user.id)

    // Enqueue an old row
    pending.enqueue(d.id, 1)

    // Advance past the cutoff
    t = 5000
    // Enqueue a fresh row
    pending.enqueue(d.id, 2)

    const removed = pending.deleteOlderThan(3000) // row at t=1000 is older
    expect(removed).toBe(1)
    expect(pending.listByDevice(d.id)).toEqual([{ seq: 2, source: 'online' }])
  })

  test('deleteByUser() removes pending rows for all devices belonging to the user, leaves other users untouched', () => {
    const db = openDb(':memory:')
    const users = createUsersStore(db)
    const devices = createDevicesStore(db)
    const pending = createPendingDeliveriesStore(db)

    const alice = users.upsertByGoogleSub({ sub: 'a1', email: 'alice@test.com', name: 'Alice' })
    const bob = users.upsertByGoogleSub({ sub: 'b1', email: 'bob@test.com', name: 'Bob' })

    const aliceMac1 = devices.create(alice.id, 'Alice Mac 1')
    const aliceMac2 = devices.create(alice.id, 'Alice Mac 2')
    const bobMac = devices.create(bob.id, 'Bob Mac')

    pending.enqueue(aliceMac1.id, 10)
    pending.enqueue(aliceMac2.id, 11)
    pending.enqueue(bobMac.id, 20)

    pending.deleteByUser(alice.id)

    // Both of Alice's devices are cleared
    expect(pending.listByDevice(aliceMac1.id)).toEqual([])
    expect(pending.listByDevice(aliceMac2.id)).toEqual([])
    // Bob's rows are untouched
    expect(pending.listByDevice(bobMac.id)).toEqual([{ seq: 20, source: 'online' }])
  })

  test('lazy sweep: enqueue() triggers age-purge at most once per 24 h', () => {
    let t = 0
    const db = openDb(':memory:')
    const users = createUsersStore(db, () => t)
    const devices = createDevicesStore(db, () => t)
    const pending = createPendingDeliveriesStore(db, () => t)
    const user = users.upsertByGoogleSub({ sub: 'g1', email: 'a@example.com', name: 'A' })
    const d = devices.create(user.id)

    // Enqueue an old row
    t = 1000
    pending.enqueue(d.id, 1)

    // Advance past retention window to trigger sweep on next enqueue
    t = 1000 + PENDING_DELIVERIES_RETENTION_MS + 24 * 60 * 60 * 1000 + 1
    pending.enqueue(d.id, 2)

    // Row 1 should be gone (created at t=1000, cutoff = t - 7d)
    expect(pending.listByDevice(d.id)).toEqual([{ seq: 2, source: 'online' }])

    // Second enqueue within 24 h: row 2 should survive
    t += 60_000
    pending.enqueue(d.id, 3)
    expect(pending.listByDevice(d.id)).toContainEqual({ seq: 2, source: 'online' })
  })
})
