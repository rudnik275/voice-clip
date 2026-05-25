// DB-backed email allowlist (replaces the env-only static set in
// src/allowlist.ts). Same factory shape as the other stores.
//
// Schema (see db.ts SCHEMA_SQL):
//   allowed_emails(email PK lowercased, added_at, added_via, invited_by)
//
// The OAuth callback calls isAllowed() before issuing a session; invite
// consumption calls add(...) so the email row exists by the time
// isAllowed() runs. Seed-from-env happens on server boot via seed().

import type { DB } from './db'

export type AllowedVia = 'env' | 'invite' | 'manual'

export interface AllowedEmailRow {
  email: string
  added_at: number
  added_via: AllowedVia
  invited_by: string | null
}

export interface AllowedEmailsStore {
  isAllowed(email: string): boolean
  add(email: string, via: AllowedVia, invitedBy?: string | null): void
  list(): AllowedEmailRow[]
  seed(emails: readonly string[]): void
}

export function createAllowedEmailsStore(
  db: DB,
  now: () => number = Date.now,
): AllowedEmailsStore {
  // INSERT OR IGNORE — adding the same email twice is a no-op, not an error.
  // Useful for the env-seed path: every boot retries without growing the table.
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO allowed_emails (email, added_at, added_via, invited_by)
     VALUES (?, ?, ?, ?)`,
  )
  const selectByEmail = db.query<AllowedEmailRow, [string]>(
    'SELECT * FROM allowed_emails WHERE email = ?',
  )
  const selectAll = db.query<AllowedEmailRow, []>(
    'SELECT * FROM allowed_emails ORDER BY added_at ASC',
  )

  return {
    isAllowed(email: string): boolean {
      if (!email) return false
      return selectByEmail.get(email.trim().toLowerCase()) !== null
    },
    add(email: string, via: AllowedVia, invitedBy: string | null = null): void {
      const normalised = email.trim().toLowerCase()
      if (!normalised) return
      insertStmt.run(normalised, now(), via, invitedBy)
    },
    list(): AllowedEmailRow[] {
      return selectAll.all()
    },
    seed(emails: readonly string[]): void {
      for (const e of emails) this.add(e, 'env')
    },
  }
}
