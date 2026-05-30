// Unit tests for the presets store.
// Verifies CRUD operations and active-preset tracking on a temporary in-memory DB.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { openDb, type DB } from '../src/db'
import { createPresetsStore } from '../src/presets-store'

describe('createPresetsStore', () => {
  let db: DB
  let userId: string

  beforeEach(() => {
    db = openDb(':memory:')
    // Insert a dummy user so FK constraints pass
    userId = 'u_testuser01'
    db.run(
      `INSERT INTO users (id, google_sub, email, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, 'gsub1', 'test@example.com', 'Tester', Date.now(), Date.now()],
    )
  })
  afterEach(() => {
    db.close()
  })

  test('list returns empty array for new user', () => {
    const store = createPresetsStore(db)
    expect(store.list(userId)).toEqual([])
  })

  test('create returns the new preset with generated id', () => {
    const store = createPresetsStore(db)
    const p = store.create(userId, { name: 'French', prompt: 'Translate to French' })
    expect(p.id).toMatch(/^p_[0-9a-f]{16}$/)
    expect(p.userId).toBe(userId)
    expect(p.name).toBe('French')
    expect(p.prompt).toBe('Translate to French')
    expect(typeof p.createdAt).toBe('number')
  })

  test('list returns all created presets in chronological order', () => {
    let t = 1_000_000
    const store = createPresetsStore(db, () => t++)
    store.create(userId, { name: 'A', prompt: 'prompt-a' })
    store.create(userId, { name: 'B', prompt: 'prompt-b' })
    store.create(userId, { name: 'C', prompt: 'prompt-c' })
    const list = store.list(userId)
    expect(list).toHaveLength(3)
    expect(list[0]!.name).toBe('A')
    expect(list[1]!.name).toBe('B')
    expect(list[2]!.name).toBe('C')
  })

  test('get returns the preset when it belongs to the user', () => {
    const store = createPresetsStore(db)
    const p = store.create(userId, { name: 'Summarize', prompt: 'Summarize in 3 bullets' })
    const got = store.get(userId, p.id)
    expect(got).toBeDefined()
    expect(got!.id).toBe(p.id)
    expect(got!.name).toBe('Summarize')
  })

  test('get returns undefined for wrong userId', () => {
    const store = createPresetsStore(db)
    const p = store.create(userId, { name: 'X', prompt: 'Y' })
    expect(store.get('u_other_user', p.id)).toBeUndefined()
  })

  test('delete removes the preset', () => {
    const store = createPresetsStore(db)
    const p = store.create(userId, { name: 'Temp', prompt: 'temp' })
    expect(store.list(userId)).toHaveLength(1)
    store.delete(userId, p.id)
    expect(store.list(userId)).toHaveLength(0)
    expect(store.get(userId, p.id)).toBeUndefined()
  })

  test('delete with wrong userId does not remove the preset', () => {
    const store = createPresetsStore(db)
    const p = store.create(userId, { name: 'Keep', prompt: 'keep this' })
    store.delete('u_other', p.id)
    expect(store.list(userId)).toHaveLength(1)
  })

  test('getActiveId returns null when no preset is active', () => {
    const store = createPresetsStore(db)
    expect(store.getActiveId(userId)).toBeNull()
  })

  test('setActiveId / getActiveId round-trips', () => {
    const store = createPresetsStore(db)
    const p = store.create(userId, { name: 'Active', prompt: 'run me' })
    store.setActiveId(userId, p.id)
    expect(store.getActiveId(userId)).toBe(p.id)
  })

  test('setActiveId null clears the active preset', () => {
    const store = createPresetsStore(db)
    const p = store.create(userId, { name: 'X', prompt: 'Y' })
    store.setActiveId(userId, p.id)
    store.setActiveId(userId, null)
    expect(store.getActiveId(userId)).toBeNull()
  })

  test('deleting the active preset sets active to null (FK ON DELETE SET NULL)', () => {
    const store = createPresetsStore(db)
    const p = store.create(userId, { name: 'Active', prompt: 'blah' })
    store.setActiveId(userId, p.id)
    expect(store.getActiveId(userId)).toBe(p.id)
    store.delete(userId, p.id)
    // The FK ON DELETE SET NULL should clear it automatically
    expect(store.getActiveId(userId)).toBeNull()
  })

  test('presets for different users are isolated', () => {
    const user2 = 'u_testuser02'
    db.run(
      `INSERT INTO users (id, google_sub, email, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [user2, 'gsub2', 'test2@example.com', 'Tester2', Date.now(), Date.now()],
    )
    const store = createPresetsStore(db)
    store.create(userId, { name: 'User1 preset', prompt: 'for user 1' })
    store.create(user2, { name: 'User2 preset', prompt: 'for user 2' })
    expect(store.list(userId)).toHaveLength(1)
    expect(store.list(userId)[0]!.name).toBe('User1 preset')
    expect(store.list(user2)).toHaveLength(1)
    expect(store.list(user2)[0]!.name).toBe('User2 preset')
  })
})
