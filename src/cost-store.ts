// Cumulative spend, on SQLite.
//
// Schema (see db.ts SCHEMA_SQL):
//   costs(user_id TEXT PRIMARY KEY, total_usd REAL)
//
// One row per real user_id, PLUS one reserved sentinel row keyed
// AGGREGATE_KEY ('__aggregate__') holding the all-users running total — that
// sentinel is what the UI total-pill shows. Real user ids are 'u_<hex>' so
// they can never collide with the sentinel.
//
// add() must bump the per-user row AND the aggregate row atomically: both
// UPSERTs run inside a single db.transaction() so a crash can never leave
// the aggregate out of sync with the sum of per-user totals.
//
// Cost is deliberately decoupled from history rows: history.clear() wipes
// transcripts but the spend is real money already spent — it must persist.

import type { DB } from './db'

export const AGGREGATE_KEY = '__aggregate__'

export interface CostStore {
  add(userId: string, usd: number): void
  userTotal(userId: string): number
  aggregateTotal(): number
}

interface TotalRow {
  total_usd: number
}

export function createCostStore(db: DB): CostStore {
  // UPSERT: insert a fresh row at `usd`, or add `usd` to an existing total.
  const bump = db.query<never, [string, number]>(
    `INSERT INTO costs (user_id, total_usd) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET total_usd = total_usd + excluded.total_usd`,
  )
  const select = db.query<TotalRow, [string]>(
    'SELECT total_usd FROM costs WHERE user_id = ?',
  )

  function read(key: string): number {
    const row = select.get(key)
    return row ? row.total_usd : 0
  }

  const addTx = db.transaction((userId: string, usd: number) => {
    bump.run(userId, usd)
    bump.run(AGGREGATE_KEY, usd)
  })

  return {
    add(userId: string, usd: number): void {
      addTx(userId, usd)
    },
    userTotal(userId: string): number {
      return read(userId)
    },
    aggregateTotal(): number {
      return read(AGGREGATE_KEY)
    },
  }
}
