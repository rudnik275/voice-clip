// Per-user post-processing presets.
//
// A preset is a named system-instruction prompt that is applied to the raw
// transcript via a second gpt-4o-mini chat.completions call after the primary
// transcription. The "active" preset id is stored in the user_settings table
// (nullable — null means no post-processing).
//
// Note: a preset prompt is a system instruction applied to TEXT — it never
// re-triggers audio recording and self-referential prompts are therefore a
// non-issue.

import { randomBytes } from 'node:crypto'
import type { DB } from './db'

export interface Preset {
  id: string
  userId: string
  name: string
  prompt: string
  createdAt: number
}

export interface PresetsStore {
  list(userId: string): Preset[]
  get(userId: string, id: string): Preset | undefined
  create(userId: string, input: { name: string; prompt: string }): Preset
  delete(userId: string, id: string): void
  getActiveId(userId: string): string | null
  setActiveId(userId: string, id: string | null): void
}

interface PresetRow {
  id: string
  user_id: string
  name: string
  prompt: string
  created_at: number
}

function rowToPreset(r: PresetRow): Preset {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    prompt: r.prompt,
    createdAt: r.created_at,
  }
}

export function createPresetsStore(db: DB, now: () => number = Date.now): PresetsStore {
  const selectAll = db.query<PresetRow, [string]>(
    'SELECT * FROM presets WHERE user_id = ? ORDER BY created_at ASC',
  )
  const selectOne = db.query<PresetRow, [string, string]>(
    'SELECT * FROM presets WHERE user_id = ? AND id = ?',
  )
  const insertPreset = db.query<PresetRow, [string, string, string, string, number]>(
    `INSERT INTO presets (id, user_id, name, prompt, created_at)
     VALUES (?, ?, ?, ?, ?) RETURNING *`,
  )
  const deletePreset = db.prepare('DELETE FROM presets WHERE user_id = ? AND id = ?')

  const selectActiveId = db.query<{ active_preset_id: string | null }, [string]>(
    'SELECT active_preset_id FROM user_settings WHERE user_id = ?',
  )
  // UPSERT the settings row; active_preset_id may be NULL (= off).
  const upsertActiveId = db.prepare(
    `INSERT INTO user_settings (user_id, active_preset_id)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE
     SET active_preset_id = excluded.active_preset_id`,
  )

  return {
    list(userId: string): Preset[] {
      return selectAll.all(userId).map(rowToPreset)
    },

    get(userId: string, id: string): Preset | undefined {
      const row = selectOne.get(userId, id)
      return row ? rowToPreset(row) : undefined
    },

    create(userId: string, input: { name: string; prompt: string }): Preset {
      const id = `p_${randomBytes(8).toString('hex')}`
      const row = insertPreset.get(id, userId, input.name, input.prompt, now())
      return rowToPreset(row as PresetRow)
    },

    delete(userId: string, id: string): void {
      deletePreset.run(userId, id)
      // If this preset was active, the FK ON DELETE SET NULL in user_settings
      // handles clearing it automatically.
    },

    getActiveId(userId: string): string | null {
      const row = selectActiveId.get(userId)
      return row?.active_preset_id ?? null
    },

    setActiveId(userId: string, id: string | null): void {
      upsertActiveId.run(userId, id)
    },
  }
}
