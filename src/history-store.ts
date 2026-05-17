// Per-user transcription history on SQLite.
//
// Schema (see db.ts SCHEMA_SQL):
//   history(seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id, text, source,
//           recorded_at, cost_usd, ts)
//
// `seq` is a single GLOBAL autoincrement column — monotonic across ALL users.
// A global sequence (rather than per-user) is what makes daemon replay simple:
// "give me every clip with seq > X for user Y" is one indexed range scan, and
// AUTOINCREMENT guarantees seq is never reused even after a clear().
//
// Two read shapes:
//   list(userId, {since,limit})  — UI history modal: newest-first, paginated
//                                  via a `since` cursor (the seq to read
//                                  strictly below). Stable because seq is a
//                                  total order.
//   listSince(userId, seq)       — daemon replay: oldest-first, seq > X.

import type { DB } from './db'

export type ClipSource = 'online' | 'offline'

export interface HistoryClip {
  seq: number
  userId: string
  text: string
  source: ClipSource
  recordedAt: string
  costUsd: number
  ts: number
}

export interface AppendInput {
  userId: string
  text: string
  recordedAt: string
  source: ClipSource
  costUsd: number
}

export interface ListOptions {
  // Return clips strictly OLDER than this seq (cursor for "load more").
  since?: number
  limit?: number
}

export interface HistoryPage {
  items: HistoryClip[]
  // Cursor to pass back as `since` for the next page; undefined when the
  // page is the last one.
  nextSince?: number
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

interface HistoryRow {
  seq: number
  user_id: string
  text: string
  source: string
  recorded_at: string
  cost_usd: number
  ts: number
}

function rowToClip(r: HistoryRow): HistoryClip {
  return {
    seq: r.seq,
    userId: r.user_id,
    text: r.text,
    source: r.source === 'offline' ? 'offline' : 'online',
    recordedAt: r.recorded_at,
    costUsd: r.cost_usd,
    ts: r.ts,
  }
}

export interface HistoryStore {
  append(input: AppendInput): HistoryClip
  list(userId: string, opts: ListOptions): HistoryPage
  listSince(userId: string, seq: number): HistoryClip[]
  clear(userId: string): void
}

export function createHistoryStore(db: DB, now: () => number = Date.now): HistoryStore {
  const insert = db.query<HistoryRow, [string, string, string, string, number, number]>(
    `INSERT INTO history (user_id, text, source, recorded_at, cost_usd, ts)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
  )
  // Newest-first by the global seq (a strict total order that also matches
  // recordedAt order for normal use; seq tie-breaks identical timestamps).
  const pageHead = db.query<HistoryRow, [string, number]>(
    `SELECT * FROM history WHERE user_id = ? ORDER BY seq DESC LIMIT ?`,
  )
  const pageAfter = db.query<HistoryRow, [string, number, number]>(
    `SELECT * FROM history WHERE user_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
  )
  const sinceStmt = db.query<HistoryRow, [string, number]>(
    `SELECT * FROM history WHERE user_id = ? AND seq > ? ORDER BY seq ASC`,
  )
  const clearStmt = db.prepare('DELETE FROM history WHERE user_id = ?')

  function clampLimit(limit?: number): number {
    if (!limit || limit <= 0) return DEFAULT_LIMIT
    return Math.min(limit, MAX_LIMIT)
  }

  return {
    append(input: AppendInput): HistoryClip {
      const row = insert.get(
        input.userId,
        input.text,
        input.source,
        input.recordedAt,
        input.costUsd,
        now(),
      )
      return rowToClip(row as HistoryRow)
    },

    list(userId: string, opts: ListOptions): HistoryPage {
      const limit = clampLimit(opts.limit)
      // Fetch limit+1 so we know whether another page exists.
      const rows =
        opts.since === undefined
          ? pageHead.all(userId, limit + 1)
          : pageAfter.all(userId, opts.since, limit + 1)
      const hasMore = rows.length > limit
      const pageRows = hasMore ? rows.slice(0, limit) : rows
      const items = pageRows.map(rowToClip)
      const last = items[items.length - 1]
      return {
        items,
        nextSince: hasMore && last ? last.seq : undefined,
      }
    },

    listSince(userId: string, seq: number): HistoryClip[] {
      return sinceStmt.all(userId, seq).map(rowToClip)
    },

    clear(userId: string): void {
      clearStmt.run(userId)
    },
  }
}
