// Error log on SQLite — the storage layer for #55 DIY observability.
//
// Schema (see db.ts SCHEMA_SQL):
//   errors(id PK, ts, user_id, type, message, stack, context, audio_file,
//          resolved)
//
// Captures three classes of failure:
//   - Client-reported (POST /api/errors, no auth required)
//   - Server 5xx (auto-logged from the response wrapper in server.ts)
//   - Transcription failures (logged from the /upload error path, with
//     audio_file pointing at the retained blob)
//
// Mirrors the sessions/devices store factory shape: createErrorsStore(db, now?).

import { randomBytes } from 'node:crypto'

import type { DB } from './db'

export interface ErrorRecord {
  id: string
  ts: number
  user_id: string | null
  type: string
  message: string
  stack: string | null
  context: string | null
  audio_file: string | null
  resolved: number
}

export interface InsertErrorInput {
  type: string
  message: string
  stack?: string | null
  context?: Record<string, unknown> | null
  user_id?: string | null
  audio_file?: string | null
  ts?: number
}

export interface ListErrorsFilter {
  limit?: number
  includeResolved?: boolean
}

export const ERRORS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface ErrorsStore {
  insert(input: InsertErrorInput): ErrorRecord
  list(filter?: ListErrorsFilter): ErrorRecord[]
  get(id: string): ErrorRecord | null
  markResolved(id: string): void
  deleteOlderThan(cutoffMs: number): number
}

function newErrorId(): string {
  return `e_${randomBytes(12).toString('hex')}`
}

export function createErrorsStore(db: DB, now: () => number = Date.now): ErrorsStore {
  const insertStmt = db.query<ErrorRecord, [string, number, string | null, string, string, string | null, string | null, string | null]>(
    `INSERT INTO errors (id, ts, user_id, type, message, stack, context, audio_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  )
  const selectById = db.query<ErrorRecord, [string]>('SELECT * FROM errors WHERE id = ?')
  const selectAll = db.query<ErrorRecord, [number]>(
    'SELECT * FROM errors ORDER BY ts DESC LIMIT ?',
  )
  const selectUnresolved = db.query<ErrorRecord, [number]>(
    'SELECT * FROM errors WHERE resolved = 0 ORDER BY ts DESC LIMIT ?',
  )
  const markResolvedStmt = db.prepare('UPDATE errors SET resolved = 1 WHERE id = ?')
  const deleteOlder = db.prepare('DELETE FROM errors WHERE ts < ?')

  // Lazy daily sweep: at most once per 24 h, purge rows older than ERRORS_RETENTION_MS.
  const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
  let lastSweepAt = 0

  function maybeSweep(): void {
    const ts = now()
    if (ts - lastSweepAt < SWEEP_INTERVAL_MS) return
    lastSweepAt = ts
    deleteOlder.run(ts - ERRORS_RETENTION_MS)
  }

  return {
    insert(input: InsertErrorInput): ErrorRecord {
      maybeSweep()
      const ts = input.ts ?? now()
      const row = insertStmt.get(
        newErrorId(),
        ts,
        input.user_id ?? null,
        input.type,
        input.message,
        input.stack ?? null,
        input.context ? JSON.stringify(input.context) : null,
        input.audio_file ?? null,
      )
      return row as ErrorRecord
    },

    list({ limit = 200, includeResolved = false }: ListErrorsFilter = {}): ErrorRecord[] {
      const stmt = includeResolved ? selectAll : selectUnresolved
      return stmt.all(limit)
    },

    get(id: string): ErrorRecord | null {
      return selectById.get(id) ?? null
    },

    markResolved(id: string): void {
      markResolvedStmt.run(id)
    },

    deleteOlderThan(cutoffMs: number): number {
      const result = deleteOlder.run(cutoffMs)
      return Number(result.changes)
    },
  }
}
