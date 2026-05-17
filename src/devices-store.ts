// Paired macOS clipboard receivers on SQLite.
//
// Schema (see db.ts SCHEMA_SQL):
//   devices(id PK, user_id, device_token UNIQUE, device_name,
//           created_at, last_seen_at)
//
// One row per Mac app install. `device_token` is the opaque 256-bit bearer
// the Tauri app stores in the macOS Keychain and presents on /events (SSE)
// and /events/ack. It is UNIQUE so a duplicate/leaked token can never
// resolve to two devices, and rows cascade-delete with the owning user.
//
// Mirrors the sessions-store factory shape: createDevicesStore(db, now?).

import type { DB } from './db'
import { randomBytes } from 'node:crypto'

export interface Device {
  id: string
  user_id: string
  device_token: string
  device_name: string | null
  created_at: number
  last_seen_at: number
}

export interface DevicesStore {
  create(userId: string, deviceName?: string | null): Device
  findByToken(token: string): Device | null
  list(userId: string): Device[]
  revoke(id: string): void
  touch(id: string): void
}

interface DeviceRow {
  id: string
  user_id: string
  device_token: string
  device_name: string | null
  created_at: number
  last_seen_at: number
}

function newDeviceId(): string {
  return `d_${randomBytes(12).toString('hex')}`
}

function newDeviceToken(): string {
  return randomBytes(32).toString('hex')
}

export function createDevicesStore(db: DB, now: () => number = Date.now): DevicesStore {
  const insert = db.query<DeviceRow, [string, string, string, string | null, number, number]>(
    `INSERT INTO devices (id, user_id, device_token, device_name, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
  )
  const selectByToken = db.query<DeviceRow, [string]>(
    'SELECT * FROM devices WHERE device_token = ?',
  )
  const selectByUser = db.query<DeviceRow, [string]>(
    'SELECT * FROM devices WHERE user_id = ? ORDER BY created_at ASC',
  )
  const removeStmt = db.prepare('DELETE FROM devices WHERE id = ?')
  const touchStmt = db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')

  return {
    create(userId: string, deviceName: string | null = null): Device {
      const ts = now()
      const row = insert.get(newDeviceId(), userId, newDeviceToken(), deviceName, ts, ts)
      // RETURNING * always yields a row for INSERT — assert non-null.
      return row as DeviceRow
    },

    findByToken(token: string): Device | null {
      return selectByToken.get(token) ?? null
    },

    list(userId: string): Device[] {
      return selectByUser.all(userId)
    },

    revoke(id: string): void {
      removeStmt.run(id)
    },

    touch(id: string): void {
      touchStmt.run(now(), id)
    },
  }
}
