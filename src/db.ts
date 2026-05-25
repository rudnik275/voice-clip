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

  -- Paired macOS clipboard receivers. One row per Mac app install. The
  -- device_token is the opaque bearer the Tauri app stores in the Keychain
  -- and presents on /events (SSE) + /events/ack. UNIQUE so a leaked/duplicate
  -- token can never resolve to two devices. Cascades on user delete.
  CREATE TABLE IF NOT EXISTS devices (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    device_token  TEXT NOT NULL UNIQUE,
    device_name   TEXT,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
  CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(device_token);

  -- Server-side replay queue for offline Macs. When a phone uploads a clip
  -- but a paired device has no live SSE stream, /upload inserts a row here.
  -- On the device's next /events connect we flush its pending rows (seq ASC)
  -- into the stream before subscribing to live frames; /events/ack {seq}
  -- deletes the matching row. UNIQUE(device_id, seq) makes enqueue idempotent
  -- under at-least-once fan-out. Cascades on device (and transitively user)
  -- delete so a revoked Mac never leaves an orphan queue.
  CREATE TABLE IF NOT EXISTS pending_deliveries (
    id          TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    UNIQUE(device_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_pending_deliveries_device_seq
    ON pending_deliveries(device_id, seq);

  -- Error log — DIY observability replacing "user emails me when something
  -- breaks". Captures both client-side reports (POST /api/errors, no auth
  -- required so pre-login crashes are reachable) and 5xx server responses.
  CREATE TABLE IF NOT EXISTS errors (
    id          TEXT PRIMARY KEY,
    ts          INTEGER NOT NULL,
    user_id     TEXT,
    type        TEXT NOT NULL,
    message     TEXT NOT NULL,
    stack       TEXT,
    context     TEXT,
    audio_file  TEXT,
    resolved    INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_errors_ts ON errors(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_errors_user_id ON errors(user_id);
  CREATE INDEX IF NOT EXISTS idx_errors_resolved ON errors(resolved);

  -- Allowed-email allowlist, DB-backed. Seeded from VOICE_CLIP_ALLOWED_EMAILS
  -- on boot; invite-consume adds rows on the fly.
  CREATE TABLE IF NOT EXISTS allowed_emails (
    email      TEXT PRIMARY KEY,
    added_at   INTEGER NOT NULL,
    added_via  TEXT NOT NULL,
    invited_by TEXT
  );

  -- One-time invite tokens. Atomic consume guarded by used_at IS NULL.
  CREATE TABLE IF NOT EXISTS invites (
    token              TEXT PRIMARY KEY,
    created_by_user_id TEXT,
    created_at         INTEGER NOT NULL,
    used_at            INTEGER,
    used_by_user_id    TEXT,
    used_by_email      TEXT,
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_invites_created_by ON invites(created_by_user_id);

  -- Per-user subscription plan ('free' | 'pro'). Missing row → implicit
  -- 'free'. Owner flips someone to Pro by editing the DB directly until
  -- Stripe is wired up: UPDATE user_plans SET plan='pro' WHERE user_id=?.
  CREATE TABLE IF NOT EXISTS user_plans (
    user_id    TEXT PRIMARY KEY,
    plan       TEXT NOT NULL DEFAULT 'free',
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Monthly clip-counter per user. /upload increments after a successful
  -- transcription; the free-tier quota gate reads the same row.
  CREATE TABLE IF NOT EXISTS usage_counters (
    user_id     TEXT NOT NULL,
    month_key   TEXT NOT NULL,
    clips_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, month_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
