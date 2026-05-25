// One-time invite tokens, SQLite-backed.
//
// Schema (see db.ts SCHEMA_SQL):
//   invites(token PK, created_by_user_id, created_at, used_at,
//           used_by_user_id, used_by_email)
//
// Flow:
//   1. Owner: POST /admin/invites → invites.create(ownerUserId) → returns
//      { token, url: <publicUrl>/invite/<token> }
//   2. Invitee: GET /invite/:token → server sets invite cookie + 302 to
//      /auth/google/start. The invite cookie is short-lived (~10min).
//   3. Google → /auth/google/callback → server reads invite cookie,
//      validates the token row is unused, then in one atomic call:
//      consume() — marks used_at + used_by_user_id + used_by_email — AND
//      adds the email to allowed_emails so the existing isAllowed check
//      in the callback succeeds.
//
// consume() is RETURNING-driven + guarded by used_at IS NULL so a race
// between two concurrent OAuth callbacks for the same token (same person
// clicked twice) can only succeed once.

import { randomBytes } from 'node:crypto'

import type { DB } from './db'

export interface InviteRow {
  token: string
  created_by_user_id: string | null
  created_at: number
  used_at: number | null
  used_by_user_id: string | null
  used_by_email: string | null
}

export interface InvitesStore {
  create(createdByUserId: string | null): InviteRow
  get(token: string): InviteRow | null
  consume(token: string, userId: string, email: string): InviteRow | null
  listByCreator(userId: string): InviteRow[]
}

function newInviteToken(): string {
  // 32 bytes of randomness → 64 hex chars. Big enough that brute-forcing a
  // valid unused token is infeasible.
  return randomBytes(32).toString('hex')
}

export function createInvitesStore(db: DB, now: () => number = Date.now): InvitesStore {
  const insertStmt = db.query<InviteRow, [string, string | null, number]>(
    `INSERT INTO invites (token, created_by_user_id, created_at)
     VALUES (?, ?, ?) RETURNING *`,
  )
  const selectByToken = db.query<InviteRow, [string]>(
    'SELECT * FROM invites WHERE token = ?',
  )
  // UPDATE … WHERE used_at IS NULL guards the consume() race.
  const consumeStmt = db.query<InviteRow, [number, string, string, string]>(
    `UPDATE invites SET used_at = ?, used_by_user_id = ?, used_by_email = ?
     WHERE token = ? AND used_at IS NULL
     RETURNING *`,
  )
  const listByCreatorStmt = db.query<InviteRow, [string]>(
    'SELECT * FROM invites WHERE created_by_user_id = ? ORDER BY created_at DESC',
  )

  return {
    create(createdByUserId: string | null): InviteRow {
      const row = insertStmt.get(newInviteToken(), createdByUserId, now())
      return row as InviteRow
    },
    get(token: string): InviteRow | null {
      return selectByToken.get(token) ?? null
    },
    consume(token: string, userId: string, email: string): InviteRow | null {
      return consumeStmt.get(now(), userId, email.toLowerCase(), token) ?? null
    },
    listByCreator(userId: string): InviteRow[] {
      return listByCreatorStmt.all(userId)
    },
  }
}
