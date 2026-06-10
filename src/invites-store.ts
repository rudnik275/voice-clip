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
//   3. Google → /auth/google/callback → server reads invite cookie and,
//      BEFORE any user row is created, runs consumeAndAllow(): one
//      db.transaction() that marks the invite used (used_at + used_by_email,
//      with used_by_user_id left NULL for now) AND adds the email to
//      allowed_emails. Either both happen or neither — a crash between the
//      two statements can no longer burn the token without granting access.
//      Only on the success path does the callback create the user row and
//      backfill used_by_user_id via setUsedBy().
//
// consume() is RETURNING-driven + guarded by used_at IS NULL so a race
// between two concurrent OAuth callbacks for the same token (same person
// clicked twice) can only succeed once. consumeAndAllow() wraps it together
// with the allowlist insert in a single transaction.

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
  /**
   * Atomically (in one db.transaction) mark the token used (used_at +
   * used_by_email; used_by_user_id stays NULL until backfilled) AND run
   * `addAllowed` — the allowlist insert for this email. Either both commit
   * or neither does, so a crash can never burn a single-use token without
   * granting access. Returns the consumed row, or null if the token was
   * already used / does not exist (in which case `addAllowed` does NOT run).
   *
   * The user row does not exist yet at this point (validate-before-create):
   * the callback creates it only after this succeeds, then calls setUsedBy()
   * to link the consumption to the new user id. `addAllowed` receives the
   * freshly-consumed row (e.g. for its created_by_user_id) and runs inside
   * the same transaction.
   */
  consumeAndAllow(
    token: string,
    email: string,
    addAllowed: (consumed: InviteRow) => void,
  ): InviteRow | null
  /** Backfill used_by_user_id once the user row has been created. */
  setUsedBy(token: string, userId: string): void
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
  // UPDATE … WHERE used_at IS NULL guards the consume() race. used_by_user_id
  // is left NULL here — the user row doesn't exist yet (validate-before-create)
  // — and backfilled by setUsedBy() once the user has been created.
  const consumeStmt = db.query<InviteRow, [number, string, string]>(
    `UPDATE invites SET used_at = ?, used_by_email = ?
     WHERE token = ? AND used_at IS NULL
     RETURNING *`,
  )
  const setUsedByStmt = db.query<InviteRow, [string, string]>(
    'UPDATE invites SET used_by_user_id = ? WHERE token = ?',
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
    consumeAndAllow(
      token: string,
      email: string,
      addAllowed: (consumed: InviteRow) => void,
    ): InviteRow | null {
      // db.transaction returns a function that runs the body atomically and
      // propagates its return value. If addAllowed throws, the UPDATE above
      // rolls back too, so the token is NOT marked used.
      const tx = db.transaction((): InviteRow | null => {
        const consumed = consumeStmt.get(now(), email.toLowerCase(), token) ?? null
        if (!consumed) return null
        addAllowed(consumed)
        return consumed
      })
      return tx()
    },
    setUsedBy(token: string, userId: string): void {
      setUsedByStmt.run(userId, token)
    },
    listByCreator(userId: string): InviteRow[] {
      return listByCreatorStmt.all(userId)
    },
  }
}
