import { describe, expect, test } from 'bun:test'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import { createDevicesStore, type Device } from '../src/devices-store'

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
})
