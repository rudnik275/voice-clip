import { mkdir, readdir, unlink, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from './config'

const RECORDINGS_DIR = join(config.dataDir, 'recordings')
const CLEANUP_STATE = join(config.dataDir, '.last-cleanup')

async function ensureDirs(): Promise<void> {
  await mkdir(RECORDINGS_DIR, { recursive: true })
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function tsForFilename(): string {
  const d = new Date()
  return `${todayStr()}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8)
}

export async function runDailyCleanupIfNeeded(): Promise<void> {
  await ensureDirs()
  const today = todayStr()
  let last = ''
  try {
    last = (await readFile(CLEANUP_STATE, 'utf8')).trim()
  } catch {
    // first run — no state file yet
  }
  if (last === today) return

  let removed = 0
  const entries = await readdir(RECORDINGS_DIR).catch(() => [] as string[])
  for (const name of entries) {
    const datePrefix = name.slice(0, 10)
    if (datePrefix !== today) {
      await unlink(join(RECORDINGS_DIR, name)).catch(() => {})
      removed++
    }
  }
  await writeFile(CLEANUP_STATE, today)
  console.log(`[cleanup] removed ${removed} stale recording(s); state set to ${today}`)
}

export async function saveAudio(buf: Uint8Array, ext: string): Promise<{ base: string; pathOnDisk: string }> {
  await ensureDirs()
  const base = `${tsForFilename()}_${randomId()}`
  const pathOnDisk = join(RECORDINGS_DIR, `${base}${ext}`)
  await Bun.write(pathOnDisk, buf)
  return { base, pathOnDisk }
}
