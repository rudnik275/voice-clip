// User row store: get-or-create on google_sub.
//
// The OAuth callback calls `upsertByGoogleSub` after Google returns a verified
// id_token. We use `google_sub` (the Google account's stable subject id) as
// the immutable join key — email/name/picture can change but sub is forever.
// On every login we refresh the mutable fields so the UI stays current.

import type { DB } from './db'
import { randomBytes } from 'node:crypto'

export interface User {
  id: string
  google_sub: string
  email: string
  name: string
  picture_url: string | null
  created_at: number
  updated_at: number
}

export interface UpsertInput {
  sub: string
  email: string
  name: string
  picture_url?: string | null
}

export interface UsersStore {
  upsertByGoogleSub(input: UpsertInput): User
  findById(id: string): User | null
  findByEmail(email: string): User | null
}

function newUserId(): string {
  return `u_${randomBytes(12).toString('hex')}`
}

interface UserRow {
  id: string
  google_sub: string
  email: string
  name: string
  picture_url: string | null
  created_at: number
  updated_at: number
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    google_sub: row.google_sub,
    email: row.email,
    name: row.name,
    picture_url: row.picture_url,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function createUsersStore(db: DB, now: () => number = Date.now): UsersStore {
  const selectBySub = db.query<UserRow, [string]>('SELECT * FROM users WHERE google_sub = ?')
  const selectById = db.query<UserRow, [string]>('SELECT * FROM users WHERE id = ?')
  const selectByEmail = db.query<UserRow, [string]>(
    'SELECT * FROM users WHERE email = ? LIMIT 1',
  )
  const insertUser = db.query<
    UserRow,
    [string, string, string, string, string | null, number, number]
  >(
    `INSERT INTO users (id, google_sub, email, name, picture_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  )
  const updateUser = db.query<UserRow, [string, string, string | null, number, string]>(
    `UPDATE users SET email = ?, name = ?, picture_url = ?, updated_at = ?
     WHERE google_sub = ? RETURNING *`,
  )

  return {
    upsertByGoogleSub(input: UpsertInput): User {
      const existing = selectBySub.get(input.sub)
      const ts = now()
      const picture = input.picture_url ?? null
      // Normalize email at write time so findByEmail (which lowercases the
      // query) can always find the row regardless of the casing Google returns.
      const email = input.email.trim().toLowerCase()
      if (existing) {
        const updated = updateUser.get(email, input.name, picture, ts, input.sub)
        // updated is non-null because the row exists; non-null assertion is safe.
        return rowToUser(updated as UserRow)
      }
      const inserted = insertUser.get(newUserId(), input.sub, email, input.name, picture, ts, ts)
      return rowToUser(inserted as UserRow)
    },

    findById(id: string): User | null {
      const row = selectById.get(id)
      return row ? rowToUser(row) : null
    },

    findByEmail(email: string): User | null {
      if (!email) return null
      const row = selectByEmail.get(email.trim().toLowerCase())
      return row ? rowToUser(row) : null
    },
  }
}
