import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerDeps } from '../src/server'

// Regression: Cloudflare's default 4h static cache served a STALE
// /style.css against fresh HTML after a deploy → broken layout (white
// pause button, invisible loader). Fix = content-versioned asset URLs
// (/style.css?v=hash, /app.ts?v=hash) cached `immutable`, HTML `no-store`.

describe('asset cache busting', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-asset-'))
    const deps: ServerDeps = { dataDir: dir, port: 0, useTls: false }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
  })

  afterEach(async () => {
    if (server) server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('/style.css is served immutable + long max-age', async () => {
    const r = await fetch(`${baseUrl}/style.css`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/css')
    const cc = r.headers.get('cache-control') ?? ''
    expect(cc).toContain('immutable')
    expect(cc).toContain('max-age=31536000')
  })

  test('/app.ts is served immutable + long max-age', async () => {
    const r = await fetch(`${baseUrl}/app.ts`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('javascript')
    const cc = r.headers.get('cache-control') ?? ''
    expect(cc).toContain('immutable')
    expect(cc).toContain('max-age=31536000')
  })

  test('a versioned asset URL still routes (query ignored)', async () => {
    const r = await fetch(`${baseUrl}/style.css?v=deadbeef00`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/css')
  })

  test('HTML is no-store and references versioned assets only', async () => {
    const r = await fetch(`${baseUrl}/`) // anon → login.html via htmlResponse
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')

    const html = await r.text()
    // versioned reference present…
    const m = html.match(/\/style\.css\?v=([a-f0-9]{10})"/)
    expect(m).not.toBeNull()
    // …and NO bare /style.css" (which Cloudflare would cache stale)
    expect(html).not.toContain('href="/style.css"')
  })

  test('asset version matches the served bundle (stable hash)', async () => {
    const home = await fetch(`${baseUrl}/`).then((r) => r.text())
    const ver = home.match(/\/style\.css\?v=([a-f0-9]{10})"/)?.[1]
    expect(ver).toBeTruthy()
    // The token is a content hash, so re-reading it is identical.
    const home2 = await fetch(`${baseUrl}/`).then((r) => r.text())
    expect(home2.match(/\/style\.css\?v=([a-f0-9]{10})"/)?.[1]).toBe(ver)
  })
})
