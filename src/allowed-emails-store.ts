// DB-backed email allowlist (replaces the env-only static set in
// src/allowlist.ts). Same factory shape as the other stores.
//
// Schema (see db.ts SCHEMA_SQL):
//   allowed_emails(email PK lowercased, added_at, added_via, invited_by, plan)
//
// The OAuth callback calls isAllowed() before issuing a session; invite
// consumption calls add(...) so the email row exists by the time
// isAllowed() runs. Seed-from-env happens on server boot via seed().
//
// `plan` carries the intended tier to apply when the user first logs in via
// OAuth — the user row may not exist yet at add() time, so the plan is stored
// here and applied in the OAuth callback once the user row exists.

import type { DB } from './db'
import type { Plan } from './plans-store'

export type AllowedVia = 'env' | 'invite' | 'manual'

export interface AllowedEmailRow {
  email: string
  added_at: number
  added_via: AllowedVia
  invited_by: string | null
  plan: Plan | null
}

export interface AllowedEmailsStore {
  isAllowed(email: string): boolean
  /** Add or upsert. When `plan` is supplied it is written unconditionally
   *  (even on a re-add), so calling this with a new plan updates the stored
   *  intent idempotently. When `plan` is omitted, an existing plan value is
   *  left untouched (INSERT OR IGNORE semantics). */
  add(email: string, via: AllowedVia, invitedBy?: string | null, plan?: Plan | null): void
  /** Return the stored plan for this email, or null if none was set. */
  planFor(email: string): Plan | null
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
  // Upsert variant — used by /admin/users and owner seed to also set the plan.
  // ON CONFLICT updates the plan (and added_via/invited_by so a re-add refreshes
  // the metadata), but never changes added_at (preserves the original add time).
  const upsertWithPlanStmt = db.prepare(
    `INSERT INTO allowed_emails (email, added_at, added_via, invited_by, plan)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       added_via  = excluded.added_via,
       invited_by = excluded.invited_by,
       plan       = excluded.plan`,
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
    add(
      email: string,
      via: AllowedVia,
      invitedBy: string | null = null,
      plan: Plan | null = null,
    ): void {
      const normalised = email.trim().toLowerCase()
      if (!normalised) return
      if (plan !== null) {
        upsertWithPlanStmt.run(normalised, now(), via, invitedBy, plan)
      } else {
        insertStmt.run(normalised, now(), via, invitedBy)
      }
    },
    planFor(email: string): Plan | null {
      if (!email) return null
      const row = selectByEmail.get(email.trim().toLowerCase())
      if (!row) return null
      const p = row.plan
      if (p === 'pro' || p === 'unlimited' || p === 'free') return p
      return null
    },
    list(): AllowedEmailRow[] {
      return selectAll.all()
    },
    seed(emails: readonly string[]): void {
      for (const e of emails) this.add(e, 'env')
    },
  }
}
