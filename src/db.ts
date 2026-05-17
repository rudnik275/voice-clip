// SQLite bootstrapping + idempotent schema migration.
//
// One single `CREATE TABLE IF NOT EXISTS` block per table — no migration
// framework. Every server boot runs this; safe to re-enter.
//
// Production storage:  <DATA_DIR>/voice-clip.sqlite (WAL-mode)
// Tests:                pass `:memory:` or a temp-dir path via openDb(path).

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DB = Database

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    google_sub   TEXT NOT NULL UNIQUE,
    email        TEXT NOT NULL,
    name         TEXT NOT NULL,
    picture_url  TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

  CREATE TABLE IF NOT EXISTS sessions (
    token            TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

  -- Per-user transcription history. seq is a single GLOBAL autoincrement
  -- (monotonic across all users, never reused) so daemon replay can do an
  -- indexed "seq > X for user Y" range scan.
  CREATE TABLE IF NOT EXISTS history (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL,
    text         TEXT NOT NULL,
    source       TEXT NOT NULL,
    recorded_at  TEXT NOT NULL,
    cost_usd     REAL NOT NULL,
    ts           INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_history_user_seq ON history(user_id, seq);

  -- Cumulative spend. One row per user_id; the aggregate (all-users) total
  -- lives in a reserved sentinel row keyed '__aggregate__'. A user id can
  -- never collide with the sentinel because user ids are 'u_<hex>'.
  CREATE TABLE IF NOT EXISTS costs (
    user_id   TEXT PRIMARY KEY,
    total_usd REAL NOT NULL
  );
`

export function openDb(path: string): DB {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new Database(path, { create: true })
  // WAL gives us better concurrency for the read-heavy /me check while
  // OAuth callbacks write the user/session rows.
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  return db
}
