import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// storage.ts hard-codes config.dataDir at module load. We swap it via env BEFORE
// dynamic-importing the module under test.

describe('storage daily cleanup', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-storage-'))
    process.env.DATA_DIR = dir
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function pad(n: number): string {
    return String(n).padStart(2, '0')
  }

  function todayPrefix(): string {
    const d = new Date()
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  test('removes recordings whose date prefix is not today, keeps today', async () => {
    process.env.OPENAI_API_KEY = 'test-key' // config.ts requires it at module load
    const recordings = join(dir, 'recordings')
    await mkdir(recordings, { recursive: true })

    await writeFile(join(recordings, '2024-01-01_10-00-00_aaa.m4a'), 'old')
    await writeFile(join(recordings, '2025-12-31_23-59-59_bbb.m4a'), 'old')
    await writeFile(join(recordings, `${todayPrefix()}_12-00-00_ccc.m4a`), 'today')

    // dynamic import so DATA_DIR is read fresh
    const mod = (await import(`../src/storage.ts?cb=${Date.now()}`)) as typeof import('../src/storage')
    await mod.runDailyCleanupIfNeeded()

    const remaining = await readdir(recordings)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.startsWith(todayPrefix())).toBe(true)

    const stateFile = await readFile(join(dir, '.last-cleanup'), 'utf8')
    expect(stateFile.trim()).toBe(todayPrefix())
  })

  test('is a no-op when state already says today', async () => {
    process.env.OPENAI_API_KEY = 'test-key'
    const recordings = join(dir, 'recordings')
    await mkdir(recordings, { recursive: true })
    await writeFile(join(dir, '.last-cleanup'), todayPrefix())
    await writeFile(join(recordings, '2024-01-01_10-00-00_old.m4a'), 'still-here')

    const mod = (await import(`../src/storage.ts?cb=${Date.now()}-2`)) as typeof import('../src/storage')
    await mod.runDailyCleanupIfNeeded()

    const remaining = await readdir(recordings)
    expect(remaining).toEqual(['2024-01-01_10-00-00_old.m4a'])
  })
})
