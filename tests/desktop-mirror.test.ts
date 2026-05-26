import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerDeps } from '../src/server'

// /desktop/* routes serve release artifacts (the DMG, the .app.tar.gz the
// Tauri updater downloads, and the signed latest.json manifest) off the
// VPS mirror at ${dataDir}/desktop/, falling back to GitHub Releases when
// a file isn't present yet. This lets the desktop auto-updater keep
// working after the repo flips private — issue #66.

describe('desktop mirror routes', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-desktop-'))
    const deps: ServerDeps = { dataDir: dir, port: 0, useTls: false }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
  })

  afterEach(async () => {
    if (server) server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  describe('mirror empty → falls back to GitHub Releases', () => {
    test('/desktop/update.json 302s to GH manifest', async () => {
      const r = await fetch(`${baseUrl}/desktop/update.json`, { redirect: 'manual' })
      expect(r.status).toBe(302)
      expect(r.headers.get('location')).toBe(
        'https://github.com/rudnik275/voice-clip/releases/latest/download/latest.json',
      )
    })

    test('/desktop/voice-clip.app.tar.gz 302s to GH stable-named tarball', async () => {
      const r = await fetch(`${baseUrl}/desktop/voice-clip.app.tar.gz`, { redirect: 'manual' })
      expect(r.status).toBe(302)
      expect(r.headers.get('location')).toBe(
        'https://github.com/rudnik275/voice-clip/releases/latest/download/voice-clip.app.tar.gz',
      )
    })

    test('/desktop/voice-clip.dmg 302s to GH stable-named dmg', async () => {
      const r = await fetch(`${baseUrl}/desktop/voice-clip.dmg`, { redirect: 'manual' })
      expect(r.status).toBe(302)
      expect(r.headers.get('location')).toBe(
        'https://github.com/rudnik275/voice-clip/releases/latest/download/voice-clip.dmg',
      )
    })

    test('/download/latest 302s to GH stable-named dmg', async () => {
      const r = await fetch(`${baseUrl}/download/latest`, { redirect: 'manual' })
      expect(r.status).toBe(302)
      expect(r.headers.get('location')).toBe(
        'https://github.com/rudnik275/voice-clip/releases/latest/download/voice-clip.dmg',
      )
    })
  })

  describe('mirror populated → served straight from disk', () => {
    beforeEach(async () => {
      const desktopDir = join(dir, 'desktop')
      await mkdir(desktopDir, { recursive: true })
      await writeFile(
        join(desktopDir, 'latest.json'),
        JSON.stringify({
          version: '0.3.0',
          platforms: {
            'darwin-aarch64': { signature: 'sig', url: `${baseUrl}/desktop/voice-clip.app.tar.gz` },
          },
        }),
      )
      await writeFile(join(desktopDir, 'voice-clip.dmg'), 'DMG_BYTES')
      await writeFile(join(desktopDir, 'voice-clip.app.tar.gz'), 'TARBALL_BYTES')
    })

    test('/desktop/update.json serves the on-disk manifest', async () => {
      const r = await fetch(`${baseUrl}/desktop/update.json`, { redirect: 'manual' })
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('application/json')
      expect(r.headers.get('cache-control')).toBe('no-store')
      const json = (await r.json()) as { version: string; platforms: Record<string, { url: string }> }
      expect(json.version).toBe('0.3.0')
      // The platforms.*.url should already point at our mirror (CI rewrites
      // this before SCP'ing); the server itself doesn't rewrite anything.
      expect(json.platforms['darwin-aarch64']?.url).toContain('/desktop/voice-clip.app.tar.gz')
    })

    test('/desktop/voice-clip.app.tar.gz serves the on-disk tarball', async () => {
      const r = await fetch(`${baseUrl}/desktop/voice-clip.app.tar.gz`)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('gzip')
      expect(r.headers.get('cache-control')).toBe('no-store')
      expect(await r.text()).toBe('TARBALL_BYTES')
    })

    test('/desktop/voice-clip.dmg serves the on-disk dmg', async () => {
      const r = await fetch(`${baseUrl}/desktop/voice-clip.dmg`)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('apple-diskimage')
      expect(await r.text()).toBe('DMG_BYTES')
    })

    test('/download/latest serves the on-disk dmg too', async () => {
      const r = await fetch(`${baseUrl}/download/latest`)
      expect(r.status).toBe(200)
      expect(await r.text()).toBe('DMG_BYTES')
    })
  })

  test('non-GET methods rejected', async () => {
    const r = await fetch(`${baseUrl}/desktop/update.json`, { method: 'POST' })
    expect(r.status).toBe(405)
  })
})
