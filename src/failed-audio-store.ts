// Failed-audio retention — when /upload's transcription call throws (OpenAI
// rejects the clip as too short, too long, malformed, etc.) we keep the raw
// blob on disk for 14 days so /admin/errors/:id/replay can re-run transcribe()
// on it. The on-disk path is what we stash on the matching errors row.
//
// Storage layout:
//   <DATA_DIR>/failed-audio/<userId-or-anonymous>/<errorId>.<ext>
//
// Cleanup: lazy, same pattern as audio storage. On every save we check the
// last-cleanup marker and purge files older than the retention window.

import { mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const ROOT_SUBDIR = 'failed-audio'
const MARKER_FILE = '.last-cleanup'

export interface FailedAudioStore {
  save(args: {
    userId: string | null
    errorId: string
    bytes: Uint8Array
    extension: string
  }): string // relative path inside DATA_DIR (what the errors row stores)
  read(relativePath: string): Uint8Array
  purgeOld(now?: () => number): number // files removed
}

function safeExt(input: string): string {
  // Avoid surprises in the filename; collapse to a safe alphanumeric ext.
  const cleaned = input.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
  return cleaned.length > 0 ? cleaned : 'bin'
}

function safeUserSegment(userId: string | null): string {
  if (!userId) return 'anonymous'
  // userIds are 'u_<hex>' by convention — defensive sanitisation anyway.
  return userId.replace(/[^a-zA-Z0-9_-]/g, '')
}

export function createFailedAudioStore(dataDir: string): FailedAudioStore {
  const rootDir = join(dataDir, ROOT_SUBDIR)
  mkdirSync(rootDir, { recursive: true })
  const markerPath = join(rootDir, MARKER_FILE)

  function maybePurge(now: () => number): void {
    try {
      const last = readFileSync(markerPath, 'utf8')
      if (Number(last) > now() - 24 * 60 * 60 * 1000) return
    } catch {
      // missing marker → fall through and run a purge now
    }
    purgeOld(now)
    writeFileSync(markerPath, String(now()))
  }

  function purgeOld(now: () => number): number {
    let removed = 0
    const cutoff = now() - RETENTION_MS
    let entries: string[]
    try {
      entries = readdirSync(rootDir)
    } catch {
      return 0
    }
    for (const userSeg of entries) {
      if (userSeg.startsWith('.')) continue
      const userDir = join(rootDir, userSeg)
      let files: string[]
      try {
        files = readdirSync(userDir)
      } catch {
        continue
      }
      for (const f of files) {
        const p = join(userDir, f)
        try {
          const stat = statSync(p)
          if (stat.mtimeMs < cutoff) {
            rmSync(p)
            removed += 1
          }
        } catch {
          // file gone between readdir and statSync — ignore
        }
      }
    }
    return removed
  }

  return {
    save({ userId, errorId, bytes, extension }) {
      maybePurge(Date.now)
      const userSeg = safeUserSegment(userId)
      const ext = safeExt(extension)
      const userDir = join(rootDir, userSeg)
      mkdirSync(userDir, { recursive: true })
      const filename = `${errorId}.${ext}`
      writeFileSync(join(userDir, filename), bytes)
      return join(ROOT_SUBDIR, userSeg, filename)
    },
    read(relativePath: string): Uint8Array {
      // Refuse anything trying to escape the root.
      if (relativePath.includes('..')) {
        throw new Error('invalid path')
      }
      return readFileSync(join(dataDir, relativePath))
    },
    purgeOld(now = Date.now) {
      return purgeOld(now)
    },
  }
}
