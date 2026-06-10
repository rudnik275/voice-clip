// Server-side replay queue for offline Macs on SQLite.
//
// Schema (see db.ts SCHEMA_SQL):
//   pending_deliveries(id PK, device_id, seq, source, created_at,
//                       UNIQUE(device_id, seq))
//
// `source` is the SSE payload's delivery intent ('online' = copy
// unconditionally; 'offline' = history-only). It is stored on the pending row
// rather than re-derived from history so a queued /clip/copy of an
// offline-sourced clip still forces a pbcopy on replay. Defaults to 'online'.
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

export const PENDING_DELIVERIES_RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export type DeliverySource = 'online' | 'offline'

export interface PendingDeliveriesStore {
  enqueue(deviceId: string, seq: number, source?: DeliverySource): void
  listByDevice(deviceId: string): { seq: number; source: DeliverySource }[]
  deleteBySeq(deviceId: string, seq: number): void
  deleteByDevice(deviceId: string): void
  deleteByUser(userId: string): void
  deleteOlderThan(cutoffMs: number): number
}

interface PendingRow {
  seq: number
  source: DeliverySource
}

function newPendingId(): string {
  return `pd_${randomBytes(12).toString('hex')}`
}

export function createPendingDeliveriesStore(
  db: DB,
  now: () => number = Date.now,
): PendingDeliveriesStore {
  const insert = db.prepare(
    `INSERT INTO pending_deliveries (id, device_id, seq, source, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id, seq) DO NOTHING`,
  )
  const selectByDevice = db.query<PendingRow, [string]>(
    'SELECT seq, source FROM pending_deliveries WHERE device_id = ? ORDER BY seq ASC',
  )
  const deleteSeqStmt = db.prepare(
    'DELETE FROM pending_deliveries WHERE device_id = ? AND seq = ?',
  )
  const deleteDeviceStmt = db.prepare(
    'DELETE FROM pending_deliveries WHERE device_id = ?',
  )
  const deleteUserStmt = db.prepare(
    'DELETE FROM pending_deliveries WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)',
  )
  const deleteOlderStmt = db.prepare(
    'DELETE FROM pending_deliveries WHERE created_at < ?',
  )

  // Lazy daily sweep: at most once per 24 h, purge rows older than PENDING_DELIVERIES_RETENTION_MS.
  const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
  let lastSweepAt = 0

  function maybeSweep(): void {
    const ts = now()
    if (ts - lastSweepAt < SWEEP_INTERVAL_MS) return
    lastSweepAt = ts
    deleteOlderStmt.run(ts - PENDING_DELIVERIES_RETENTION_MS)
  }

  return {
    enqueue(deviceId: string, seq: number, source: DeliverySource = 'online'): void {
      maybeSweep()
      insert.run(newPendingId(), deviceId, seq, source, now())
    },

    listByDevice(deviceId: string): { seq: number; source: DeliverySource }[] {
      return selectByDevice.all(deviceId)
    },

    deleteBySeq(deviceId: string, seq: number): void {
      deleteSeqStmt.run(deviceId, seq)
    },

    deleteByDevice(deviceId: string): void {
      deleteDeviceStmt.run(deviceId)
    },

    deleteByUser(userId: string): void {
      deleteUserStmt.run(userId)
    },

    deleteOlderThan(cutoffMs: number): number {
      const result = deleteOlderStmt.run(cutoffMs)
      return Number(result.changes)
    },
  }
}
