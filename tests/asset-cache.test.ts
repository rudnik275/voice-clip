// Tests the static-serving contract for the Vite-built SPA (issue #100):
//   - `/` returns the Vite-built index.html (no-store, content-hashed
//      asset URLs inside it).
//   - `/assets/*` serves content-hashed JS/CSS with immutable caching.
//   - `/manifest.webmanifest` + `/icons/*` keep working (PWA install).
//   - The old `/app.ts`, `/sw.js`, `/style.css` routes are gone — no SW.
//
// These assume `web/dist/` exists (produced by `bun run build:web`). The
// Docker image bakes it via a `vite build` stage; locally CI builds it
// before `bun test`. If dist/ is missing the SPA-shell tests are skipped
// so the rest of the suite still runs.
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { startServer, type RunningServer } from '../src/server'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIST_DIR = join(import.meta.dir, '..', 'web', 'dist')
const HAS_DIST = existsSync(join(DIST_DIR, 'index.html'))

let server: RunningServer
let baseUrl: string

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'voice-clip-asset-'))
  server = await startServer({ dataDir, port: 0, useTls: false })
  baseUrl = `http://localhost:${server.port}`
})

afterAll(() => {
  server.stop()
})

test('GET / serves the Vite SPA shell as HTML with no-store', async () => {
  const res = await fetch(`${baseUrl}/`)
  if (!HAS_DIST) {
    // No build present → server returns a clear 503, not a stale shell.
    expect(res.status).toBe(503)
    return
  }
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/html')
  // index.html carries the hashed asset URLs, so it must never be cached.
  expect(res.headers.get('cache-control')).toContain('no-store')
})

test('GET / references content-hashed /assets bundles and mounts #app', async () => {
  if (!HAS_DIST) return
  const res = await fetch(`${baseUrl}/`)
  const html = await res.text()
  expect(html).toContain('id="app"')
  // Vite injects hashed asset URLs under /assets/.
  expect(html).toMatch(/\/assets\/[^"']+\.js/)
  // No service worker registration in the SPA shell.
  expect(html).not.toContain('serviceWorker.register')
  expect(html).not.toContain('/sw.js')
})

test('GET /assets/* serves the hashed JS bundle with immutable caching', async () => {
  if (!HAS_DIST) return
  const html = await (await fetch(`${baseUrl}/`)).text()
  const match = html.match(/\/assets\/[^"']+\.js/)
  expect(match).not.toBeNull()
  const res = await fetch(`${baseUrl}${match![0]}`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('javascript')
  expect(res.headers.get('cache-control')).toContain('immutable')
})

test('GET /assets/* serves the hashed CSS with immutable caching', async () => {
  if (!HAS_DIST) return
  const html = await (await fetch(`${baseUrl}/`)).text()
  const match = html.match(/\/assets\/[^"']+\.css/)
  expect(match).not.toBeNull()
  const res = await fetch(`${baseUrl}${match![0]}`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/css')
  expect(res.headers.get('cache-control')).toContain('immutable')
})

test('bundled CSS carries the neo-brutalism design tokens (style.css 1:1)', async () => {
  if (!HAS_DIST) return
  const html = await (await fetch(`${baseUrl}/`)).text()
  const match = html.match(/\/assets\/[^"']+\.css/)
  const css = await (await fetch(`${baseUrl}${match![0]}`)).text()
  expect(css).toContain('--bg')
  expect(css).toContain('--red')
})

test('GET /manifest.webmanifest is served (PWA install)', async () => {
  const res = await fetch(`${baseUrl}/manifest.webmanifest`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('manifest')
})

test('GET /icons/icon-192.png is served with immutable cache headers', async () => {
  const res = await fetch(`${baseUrl}/icons/icon-192.png`)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('image/png')
  expect(res.headers.get('cache-control')).toContain('immutable')
})

test('legacy /app.ts and /sw.js routes are gone (no service worker)', async () => {
  const appTs = await fetch(`${baseUrl}/app.ts`)
  expect(appTs.status).toBe(404)
  const sw = await fetch(`${baseUrl}/sw.js`)
  expect(sw.status).toBe(404)
})

test('dist index.html does not register a service worker', () => {
  if (!HAS_DIST) return
  const html = readFileSync(join(DIST_DIR, 'index.html'), 'utf8')
  expect(html).not.toContain('serviceWorker.register')
})
