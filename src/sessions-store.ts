// Sessions: opaque hex tokens stored in SQLite, idle-TTL refreshed on each
// resolve(). 90-day window — matches a typical "stay signed in" flow without
// being indefinite.
//
// The cookie format is HttpOnly `session=<hex>` — see src/auth-middleware.ts
// for the cookie wire format. This store is concerned only with the
// token <-> user_id mapping and TTL bookkeeping.

import type { DB } from './db'
import { randomBytes } from 'node:crypto'

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

export interface Session {
  token: string
  user_id: string
  created_at: number
  last_accessed_at: number
}

export interface SessionsStore {
  create(userId: string): Session
  resolve(token: string): Session | null
  delete(token: string): void
}

interface SessionRow {
  token: string
  user_id: string
  created_at: number
  last_accessed_at: number
}

function newToken(): string {
  return randomBytes(32).toString('hex')
}

export function createSessionsStore(db: DB, now: () => number = Date.now): SessionsStore {
  const insert = db.query<SessionRow, [string, string, number, number]>(
    `INSERT INTO sessions (token, user_id, created_at, last_accessed_at)
     VALUES (?, ?, ?, ?) RETURNING *`,
  )
  const select = db.query<SessionRow, [string]>('SELECT * FROM sessions WHERE token = ?')
  const touch = db.query<SessionRow, [number, string]>(
    `UPDATE sessions SET last_accessed_at = ? WHERE token = ? RETURNING *`,
  )
  const removeStmt = db.prepare('DELETE FROM sessions WHERE token = ?')

  return {
    create(userId: string): Session {
      const ts = now()
      const row = insert.get(newToken(), userId, ts, ts)
      // RETURNING * always yields a row for INSERT — assert non-null.
      return row as SessionRow
    },

    resolve(token: string): Session | null {
      const row = select.get(token)
      if (!row) return null
      const ts = now()
      if (ts - row.last_accessed_at > SESSION_TTL_MS) {
        removeStmt.run(token)
        return null
      }
      const refreshed = touch.get(ts, token)
      return (refreshed ?? null) as Session | null
    },

    delete(token: string): void {
      removeStmt.run(token)
    },
  }
}
