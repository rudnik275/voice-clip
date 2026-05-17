// Server-side replay queue for offline Macs on SQLite.
//
// Schema (see db.ts SCHEMA_SQL):
//   pending_deliveries(id PK, device_id, seq, created_at,
//                       UNIQUE(device_id, seq))
//
// One row per (device, clip) pair that the phone uploaded while the paired
// Mac had no live SSE stream. /upload fan-out enqueues a row whenever
// liveBus.publish() reports no live subscriber; on the device's next
// /events connect the server flushes its pending rows (seq ASC) into the
// stream before subscribing to live frames, and /events/ack {seq} deletes
// the acknowledged row.
//
// UNIQUE(device_id, seq) makes enqueue idempotent under at-least-once
// fan-out, and the FK cascades on device (and transitively user) delete so
// a revoked Mac never leaves an orphan queue.
//
// Mirrors the devices-store factory shape: createPendingDeliveriesStore(db, now?).

import type { DB } from './db'
import { randomBytes } from 'node:crypto'

export interface PendingDeliveriesStore {
  enqueue(deviceId: string, seq: number): void
  listByDevice(deviceId: string): { seq: number }[]
  deleteBySeq(deviceId: string, seq: number): void
  deleteByDevice(deviceId: string): void
}

interface SeqRow {
  seq: number
}

function newPendingId(): string {
  return `pd_${randomBytes(12).toString('hex')}`
}

export function createPendingDeliveriesStore(
  db: DB,
  now: () => number = Date.now,
): PendingDeliveriesStore {
  const insert = db.prepare(
    `INSERT INTO pending_deliveries (id, device_id, seq, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id, seq) DO NOTHING`,
  )
  const selectByDevice = db.query<SeqRow, [string]>(
    'SELECT seq FROM pending_deliveries WHERE device_id = ? ORDER BY seq ASC',
  )
  const deleteSeqStmt = db.prepare(
    'DELETE FROM pending_deliveries WHERE device_id = ? AND seq = ?',
  )
  const deleteDeviceStmt = db.prepare(
    'DELETE FROM pending_deliveries WHERE device_id = ?',
  )

  return {
    enqueue(deviceId: string, seq: number): void {
      insert.run(newPendingId(), deviceId, seq, now())
    },

    listByDevice(deviceId: string): { seq: number }[] {
      return selectByDevice.all(deviceId)
    },

    deleteBySeq(deviceId: string, seq: number): void {
      deleteSeqStmt.run(deviceId, seq)
    },

    deleteByDevice(deviceId: string): void {
      deleteDeviceStmt.run(deviceId)
    },
  }
}
