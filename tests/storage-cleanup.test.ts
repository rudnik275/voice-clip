import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAudioStorage } from '../src/storage'

describe('audio storage daily cleanup', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-storage-'))
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
    const recordings = join(dir, 'recordings')
    await mkdir(recordings, { recursive: true })

    await writeFile(join(recordings, '2024-01-01_10-00-00_aaa.m4a'), 'old')
    await writeFile(join(recordings, '2025-12-31_23-59-59_bbb.m4a'), 'old')
    await writeFile(join(recordings, `${todayPrefix()}_12-00-00_ccc.m4a`), 'today')

    const storage = createAudioStorage(dir)
    await storage.runDailyCleanupIfNeeded()

    const remaining = await readdir(recordings)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.startsWith(todayPrefix())).toBe(true)

    const stateFile = await readFile(join(dir, '.last-cleanup'), 'utf8')
    expect(stateFile.trim()).toBe(todayPrefix())
  })

  test('is a no-op when state already says today', async () => {
    const recordings = join(dir, 'recordings')
    await mkdir(recordings, { recursive: true })
    await writeFile(join(dir, '.last-cleanup'), todayPrefix())
    await writeFile(join(recordings, '2024-01-01_10-00-00_old.m4a'), 'still-here')

    const storage = createAudioStorage(dir)
    await storage.runDailyCleanupIfNeeded()

    const remaining = await readdir(recordings)
    expect(remaining).toEqual(['2024-01-01_10-00-00_old.m4a'])
  })

  test('saveAudio writes file with date-prefixed name and creates dir', async () => {
    const storage = createAudioStorage(dir)
    const result = await storage.saveAudio(new Uint8Array([1, 2, 3]), '.m4a')

    expect(result.base.startsWith(todayPrefix())).toBe(true)
    expect(result.pathOnDisk.endsWith(`${result.base}.m4a`)).toBe(true)

    const written = await readFile(result.pathOnDisk)
    expect(written.byteLength).toBe(3)
  })
})
