import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import { createDevicesStore, type Device } from '../src/devices-store'
import { createPendingDeliveriesStore } from '../src/pending-deliveries-store'

function setup(now: () => number = Date.now) {
  const db = openDb(':memory:')
  const users = createUsersStore(db, now)
  const devices = createDevicesStore(db, now)
  const user = users.upsertByGoogleSub({
    sub: 'g-sub-1',
    email: 'alice@example.com',
    name: 'Alice',
  })
  return { db, users, devices, user }
}

describe('devices-store (SQLite)', () => {
  test('create() returns a device with id, a 64-char hex token, correct user_id', () => {
    const { devices, user } = setup()
    const d = devices.create(user.id)
    expect(d.id).toMatch(/^d_[0-9a-f]+$/)
    expect(d.device_token).toMatch(/^[0-9a-f]{64}$/)
    expect(d.user_id).toBe(user.id)
    expect(d.created_at).toBeGreaterThan(0)
    expect(d.last_seen_at).toBe(d.created_at)
  })

  test('create() accepts an optional device_name', () => {
    const { devices, user } = setup()
    const d = devices.create(user.id, "Alice's MacBook")
    expect(d.device_name).toBe("Alice's MacBook")
  })

  test('create() yields distinct ids + distinct tokens for repeat calls', () => {
    const { devices, user } = setup()
    const a = devices.create(user.id)
    const b = devices.create(user.id)
    expect(a.id).not.toBe(b.id)
    expect(a.device_token).not.toBe(b.device_token)
  })

  test('findByToken(token) returns the device; unknown → null', () => {
    const { devices, user } = setup()
    const d = devices.create(user.id)
    const found = devices.findByToken(d.device_token)
    expect(found?.id).toBe(d.id)
    expect(found?.user_id).toBe(user.id)
    expect(devices.findByToken('nope')).toBeNull()
  })

  test('findById(id) returns the device; unknown → null', () => {
    const { devices, user } = setup()
    const d = devices.create(user.id, 'Mac A')
    const found = devices.findById(d.id)
    expect(found?.id).toBe(d.id)
    expect(found?.user_id).toBe(user.id)
    expect(found?.device_name).toBe('Mac A')
    expect(devices.findById('d_nope')).toBeNull()
  })

  test('list(userId) returns all of a user devices, scoped per user', () => {
    const { db, devices, users, user } = setup()
    const other = users.upsertByGoogleSub({ sub: 'g2', email: 'bob@example.com', name: 'Bob' })
    devices.create(user.id, 'Mac A')
    devices.create(user.id, 'Mac B')
    devices.create(other.id, 'Bob Mac')
    const mine = devices.list(user.id)
    expect(mine).toHaveLength(2)
    expect(mine.map((d) => d.device_name).sort()).toEqual(['Mac A', 'Mac B'])
    expect(devices.list(other.id)).toHaveLength(1)
    void db
  })

  test('revoke(id) removes the device', () => {
    const { devices, user } = setup()
    const d = devices.create(user.id)
    expect(devices.findByToken(d.device_token)).not.toBeNull()
    devices.revoke(d.id)
    expect(devices.findByToken(d.device_token)).toBeNull()
    expect(devices.list(user.id)).toHaveLength(0)
  })

  test('revoke(unknown) is a no-op (does not throw)', () => {
    const { devices } = setup()
    expect(() => devices.revoke('d_nope')).not.toThrow()
  })

  test('touch(id) bumps last_seen_at', () => {
    let clock = 1_000_000_000_000
    const { devices, user } = setup(() => clock)
    const d = devices.create(user.id)
    expect(d.last_seen_at).toBe(clock)
    clock += 5_000
    devices.touch(d.id)
    const found = devices.findByToken(d.device_token)
    expect(found?.last_seen_at).toBe(clock)
  })

  test('cascade: deleting a user removes their devices (FK on)', () => {
    const { db, devices, user } = setup()
    const d = devices.create(user.id)
    expect(devices.findByToken(d.device_token)).not.toBeNull()
    db.run('DELETE FROM users WHERE id = ?', [user.id])
    expect(devices.findByToken(d.device_token)).toBeNull()
  })

  test('device_token uniqueness is enforced at the DB level', () => {
    const { db, devices, user } = setup()
    const d = devices.create(user.id)
    expect(() =>
      db.run(
        'INSERT INTO devices (id, user_id, device_token, device_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['d_dupe', user.id, d.device_token, null, 1, 1],
      ),
    ).toThrow()
  })

  test('Device type is exported and shaped as expected', () => {
    const { devices, user } = setup()
    const d: Device = devices.create(user.id)
    expect(typeof d.id).toBe('string')
    expect(typeof d.user_id).toBe('string')
    expect(typeof d.device_token).toBe('string')
    expect(typeof d.created_at).toBe('number')
    expect(typeof d.last_seen_at).toBe('number')
  })

  // ---- deleteUnseenSince ----

  test('deleteUnseenSince removes only devices whose last_seen_at < cutoff', () => {
    let clock = 1_000_000_000_000
    const { devices, users, user } = setup(() => clock)

    // d1: seen at t=0 (stale)
    const d1 = devices.create(user.id, 'Stale Mac')
    // d2: seen at t=10000 (fresh — last_seen_at = clock = 10000 ms later)
    clock += 10_000
    devices.touch(d1.id) // doesn't help d1, we advance clock first
    // Create d2 at the new clock value
    const d2 = devices.create(user.id, 'Fresh Mac')

    // Prune with cutoff = 5000 ms after epoch start: d1's last_seen_at (10000) is ABOVE cutoff
    // so nothing pruned yet.
    expect(devices.deleteUnseenSince(1_000_000_005_000)).toBe(0)
    expect(devices.findById(d1.id)).not.toBeNull()
    expect(devices.findById(d2.id)).not.toBeNull()
    void users
  })

  test('deleteUnseenSince removes stale devices and leaves fresh ones intact', () => {
    let clock = 1_000_000_000_000
    const db = openDb(':memory:')
    const users = createUsersStore(db, () => clock)
    const devices = createDevicesStore(db, () => clock)
    const user = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })

    // d1 created at t=0
    const d1 = devices.create(user.id, 'Old Mac')
    // advance clock by 70 days — d2 created fresh
    clock += 70 * 24 * 60 * 60 * 1000
    const d2 = devices.create(user.id, 'New Mac')

    // cutoff = 60 days after the epoch start: d1.last_seen_at (t=0) < cutoff → pruned
    // d2.last_seen_at (t=70d) > cutoff → kept
    const cutoff = 1_000_000_000_000 + 60 * 24 * 60 * 60 * 1000
    const removed = devices.deleteUnseenSince(cutoff)
    expect(removed).toBe(1)
    expect(devices.findById(d1.id)).toBeNull()
    expect(devices.findById(d2.id)).not.toBeNull()
  })

  test('deleteUnseenSince cascades pending_deliveries rows of pruned devices', () => {
    let clock = 1_000_000_000_000
    const db = openDb(':memory:')
    const users = createUsersStore(db, () => clock)
    const devices = createDevicesStore(db, () => clock)
    const pending = createPendingDeliveriesStore(db, () => clock)
    const user = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })

    const stale = devices.create(user.id, 'Stale Mac')
    pending.enqueue(stale.id, 1)
    pending.enqueue(stale.id, 2)
    expect(pending.listByDevice(stale.id)).toHaveLength(2)

    // advance past cutoff
    clock += 70 * 24 * 60 * 60 * 1000
    const cutoff = 1_000_000_000_000 + 60 * 24 * 60 * 60 * 1000
    devices.deleteUnseenSince(cutoff)

    // FK CASCADE wiped the pending rows
    expect(pending.listByDevice(stale.id)).toHaveLength(0)
  })

  test('deleteUnseenSince returns 0 when no devices are stale', () => {
    const { devices, user } = setup()
    devices.create(user.id, 'Mac A')
    // cutoff in the past relative to recently-created device
    expect(devices.deleteUnseenSince(0)).toBe(0)
  })
})
