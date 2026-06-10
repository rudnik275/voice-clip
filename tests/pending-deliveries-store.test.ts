import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import { createDevicesStore } from '../src/devices-store'
import { createPendingDeliveriesStore } from '../src/pending-deliveries-store'

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
})
