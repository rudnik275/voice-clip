import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

async function readWebFile(name: string): Promise<string> {
  return readFile(join(ROOT, 'web', name), 'utf8')
}

describe('PWA shell — static guarantees', () => {
  test('sw.js: versioned CACHE name (bump on every web/ change)', async () => {
    const sw = await readWebFile('sw.js')
    expect(sw).toMatch(/const CACHE\s*=\s*['"]voice-clip-v\d+['"]/)
  })

  test('sw.js: PRECACHE_URLS includes / and /offline', async () => {
    const sw = await readWebFile('sw.js')
    expect(sw).toMatch(/PRECACHE_URLS\s*=\s*\[/)
    const arrayMatch = sw.match(/PRECACHE_URLS\s*=\s*\[([^\]]+)\]/)
    expect(arrayMatch).toBeTruthy()
    const arr = arrayMatch![1]!
    expect(arr).toMatch(/['"]\/['"]/)
    expect(arr).toMatch(/['"]\/offline['"]/)
  })

  test('sw.js: registers install/activate/message/fetch handlers', async () => {
    const sw = await readWebFile('sw.js')
    expect(sw).toMatch(/addEventListener\(['"]install['"]/)
    expect(sw).toMatch(/addEventListener\(['"]activate['"]/)
    expect(sw).toMatch(/addEventListener\(['"]message['"]/)
    expect(sw).toMatch(/addEventListener\(['"]fetch['"]/)
  })

  test('index.html: has inline #boot-fallback element with INLINE <style> rules', async () => {
    // Critical: the offline panel must render even if the external <link href=style.css>
    // fails to load. Therefore its styles must be in an inline <style> block within
    // index.html, NOT in style.css.
    const html = await readWebFile('index.html')
    expect(html).toMatch(/<div\s+id=["']boot-fallback["']/)
    // Inline <style> block exists and contains rules for #boot-fallback
    expect(html).toMatch(/<style>[\s\S]*#boot-fallback[\s\S]*?<\/style>/)
  })

  test('index.html: boot fallback has retry action (reload or back to /)', async () => {
    const html = await readWebFile('index.html')
    expect(html).toMatch(/location\.reload\(\)|location\.replace\(['"]\/['"]\)/)
  })

  test('index.html: inline 4s timer reveals boot fallback (no redirect needed)', async () => {
    const html = await readWebFile('index.html')
    expect(html).toMatch(/setTimeout\([\s\S]{0,300}__voiceClipReady[\s\S]{0,300},\s*4000\s*\)/)
    // Reveals the inline element rather than navigating somewhere else —
    // navigation can also fail when offline.
    expect(html).toMatch(/boot-fallback/)
    // Regression guard: the timer must not be inside an addEventListener('load', ...)
    // wrapper, which can stall up to 30s waiting for hung resource fetches.
    const setTimeoutIdx = html.indexOf('setTimeout')
    const before = html.substring(0, setTimeoutIdx)
    expect(before).not.toMatch(/addEventListener\(['"]load['"]/)
  })

  test('index.html: error listener reveals boot fallback on asset load failure', async () => {
    // When the bundled JS or CSS fails to load (offline + cache miss), the page
    // reveals the inline #boot-fallback panel — this works even if a redirect
    // target like /offline is itself uncached.
    const html = await readWebFile('index.html')
    expect(html).toMatch(/addEventListener\(\s*['"]error['"]/)
    expect(html).toMatch(/SCRIPT|LINK/)
    expect(html).toMatch(/boot-fallback/)
  })

  test('offline.html: self-contained — no external scripts or stylesheets', async () => {
    const html = await readWebFile('offline.html')
    expect(html).not.toMatch(/<script\s+[^>]*src\s*=/)
    expect(html).not.toMatch(/<link\s+[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=/)
    expect(html).toContain('<style>')
  })

  test('offline.html: has a way back to /', async () => {
    const html = await readWebFile('offline.html')
    expect(html).toMatch(/location\.replace\(['"]\/['"]\)|location\.href\s*=\s*['"]\/['"]/)
  })

  test('app.ts: sets window.__voiceClipReady so the offline guard knows the app is live', async () => {
    const ts = await readWebFile('app.ts')
    expect(ts).toMatch(/window\.__voiceClipReady\s*=\s*true/)
  })

  test('app.ts: posts precache message with asset URLs after SW registration', async () => {
    const ts = await readWebFile('app.ts')
    expect(ts).toMatch(/postMessage\(\s*\{\s*type:\s*['"]precache['"]/)
  })

  test('app.ts: schedules periodic registration.update()', async () => {
    const ts = await readWebFile('app.ts')
    expect(ts).toMatch(/registration\.update\(\)/)
    expect(ts).toMatch(/setInterval/)
  })

  test('app.ts: auto-reload page when new SW takes control of an already-running PWA', async () => {
    const ts = await readWebFile('app.ts')
    expect(ts).toMatch(/controllerchange/)
    expect(ts).toMatch(/location\.reload/)
  })
})
