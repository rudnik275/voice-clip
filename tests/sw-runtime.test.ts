import { beforeEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const SW_PATH = join(import.meta.dir, '../web/sw.js')

interface SwSandbox {
  cacheData: Map<string, Map<string, Response>>
  triggerInstall(): Promise<void>
  triggerActivate(): Promise<void>
  triggerMessage(data: unknown): Promise<void>
  triggerFetch(req: { url: string; method?: string; mode?: string }): Promise<Response | null>
  setOffline(offline: boolean): void
  setNetworkBody(path: string, body: string, contentType?: string): void
  preCacheNamed(name: string): void
  cacheNames(): string[]
  cacheKeys(name: string): string[]
}

async function createSwSandbox(): Promise<SwSandbox> {
  const cacheData = new Map<string, Map<string, Response>>()
  const handlers = new Map<string, (event: unknown) => void>()
  const networkBodies = new Map<string, { body: string; contentType: string }>()
  let isOffline = false

  function pathOf(req: unknown): string {
    const url =
      typeof req === 'string' ? req : (req as { url: string }).url
    return url.startsWith('http') ? new URL(url).pathname : url
  }

  const fetchMock = async (req: unknown): Promise<Response> => {
    if (isOffline) throw new TypeError('NetworkError')
    const path = pathOf(req)
    const entry = networkBodies.get(path) ?? { body: `mock body for ${path}`, contentType: 'text/html' }
    return new Response(entry.body, { status: 200, headers: { 'Content-Type': entry.contentType } })
  }

  const cachesApi = {
    open: async (name: string) => {
      if (!cacheData.has(name)) cacheData.set(name, new Map())
      const store = cacheData.get(name)!
      return {
        match: async (req: unknown) => store.get(pathOf(req)),
        put: async (req: unknown, res: Response) => {
          store.set(pathOf(req), res)
        },
        add: async (url: string) => {
          const res = await fetchMock(url)
          if (!res.ok) throw new Error('add failed: ' + url)
          store.set(pathOf(url), res)
        },
      }
    },
    keys: async () => [...cacheData.keys()],
    delete: async (name: string) => cacheData.delete(name),
  }

  const selfMock = {
    addEventListener(name: string, handler: (event: unknown) => void) {
      handlers.set(name, handler)
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    location: { origin: 'http://localhost' },
  }

  const sw = await readFile(SW_PATH, 'utf8')
  const fn = new Function('self', 'caches', 'fetch', 'Response', 'URL', sw)
  fn(selfMock, cachesApi, fetchMock, Response, URL)

  async function trigger(
    name: string,
    eventBase: Record<string, unknown>,
  ): Promise<Promise<Response> | null> {
    const handler = handlers.get(name)
    if (!handler) return null
    let waitPromise: Promise<unknown> = Promise.resolve()
    let respondPromise: Promise<Response> | null = null
    handler({
      ...eventBase,
      waitUntil(p: Promise<unknown>) {
        waitPromise = p
      },
      respondWith(p: Promise<Response>) {
        respondPromise = p
      },
    })
    await waitPromise
    return respondPromise
  }

  return {
    cacheData,
    async triggerInstall() {
      await trigger('install', {})
    },
    async triggerActivate() {
      await trigger('activate', {})
    },
    async triggerMessage(data) {
      await trigger('message', { data })
    },
    async triggerFetch(req) {
      const fakeReq = {
        url: req.url,
        method: req.method ?? 'GET',
        mode: req.mode ?? 'no-cors',
        clone() {
          return fakeReq
        },
      }
      const respondPromise = await trigger('fetch', { request: fakeReq })
      if (!respondPromise) return null
      return respondPromise
    },
    setOffline(o) {
      isOffline = o
    },
    setNetworkBody(path, body, contentType = 'text/html') {
      networkBodies.set(path, { body, contentType })
    },
    preCacheNamed(name) {
      if (!cacheData.has(name)) cacheData.set(name, new Map())
    },
    cacheNames() {
      return [...cacheData.keys()]
    },
    cacheKeys(name) {
      const store = cacheData.get(name)
      return store ? [...store.keys()] : []
    },
  }
}

describe('SW runtime simulation', () => {
  let sb: SwSandbox

  beforeEach(async () => {
    sb = await createSwSandbox()
    sb.setNetworkBody('/', '<!doctype html><html>app</html>')
    sb.setNetworkBody('/offline', '<!doctype html><html>offline page</html>')
  })

  test('install precaches / and /offline', async () => {
    await sb.triggerInstall()
    const cacheName = sb.cacheNames()[0]
    expect(cacheName).toBeTruthy()
    const keys = sb.cacheKeys(cacheName!)
    expect(keys).toContain('/')
    expect(keys).toContain('/offline')
  })

  test('activate clears cache versions other than current', async () => {
    sb.preCacheNamed('voice-clip-v1')
    sb.preCacheNamed('voice-clip-v2')
    sb.preCacheNamed('stranger-cache')
    await sb.triggerInstall() // creates current cache
    await sb.triggerActivate()
    expect(sb.cacheNames()).not.toContain('voice-clip-v1')
    expect(sb.cacheNames()).not.toContain('voice-clip-v2')
    expect(sb.cacheNames()).not.toContain('stranger-cache')
  })

  test('message:precache fetches and caches each posted asset', async () => {
    sb.setNetworkBody('/_bun/asset/abc.js', 'console.log(1)')
    sb.setNetworkBody('/_bun/asset/def.css', '.x{}')
    await sb.triggerInstall()
    await sb.triggerMessage({
      type: 'precache',
      assets: ['/_bun/asset/abc.js', '/_bun/asset/def.css'],
    })
    const cacheName = sb.cacheNames()[0]!
    const keys = sb.cacheKeys(cacheName)
    expect(keys).toContain('/_bun/asset/abc.js')
    expect(keys).toContain('/_bun/asset/def.css')
  })

  test('message:precache ignores malformed payloads silently', async () => {
    await sb.triggerInstall()
    await sb.triggerMessage({ type: 'something-else', assets: ['/bad'] })
    await sb.triggerMessage({ type: 'precache' /* no assets */ })
    await sb.triggerMessage(null)
    // No throws, no extra cache entries
    const cacheName = sb.cacheNames()[0]!
    const keys = sb.cacheKeys(cacheName)
    expect(keys).not.toContain('/bad')
  })

  test('online fetch returns network and writes to cache', async () => {
    const res = await sb.triggerFetch({ url: 'http://localhost/' })
    expect(res).not.toBeNull()
    expect(res!.ok).toBe(true)
    expect(await res!.text()).toContain('app')
    const cacheName = sb.cacheNames()[0]!
    expect(sb.cacheKeys(cacheName)).toContain('/')
  })

  test('offline fetch falls back to cached response for the same URL', async () => {
    await sb.triggerInstall()
    sb.setOffline(true)
    const res = await sb.triggerFetch({ url: 'http://localhost/' })
    expect(res).not.toBeNull()
    expect(res!.ok).toBe(true)
    expect(await res!.text()).toContain('app')
  })

  test('offline navigate to an uncached path falls back to cached /offline', async () => {
    await sb.triggerInstall()
    sb.setOffline(true)
    const res = await sb.triggerFetch({
      url: 'http://localhost/some-deep-link',
      mode: 'navigate',
    })
    expect(res).not.toBeNull()
    expect(res!.ok).toBe(true)
    expect(await res!.text()).toContain('offline page')
  })

  test('offline navigate with COMPLETELY empty cache still returns viewable HTML', async () => {
    // No install ran — cache is fully empty. This is the bad-luck path: SW
    // installed during a flaky network where /offline never got cached. We
    // still must not show a blank/error screen on navigation.
    sb.setOffline(true)
    const res = await sb.triggerFetch({ url: 'http://localhost/', mode: 'navigate' })
    expect(res).not.toBeNull()
    expect(res!.ok).toBe(true)
    const ct = res!.headers.get('content-type') ?? ''
    expect(ct).toContain('text/html')
  })

  test('offline asset fetch (uncached) does NOT fall back to /offline (would corrupt JS/CSS)', async () => {
    await sb.triggerInstall()
    sb.setOffline(true)
    const res = await sb.triggerFetch({ url: 'http://localhost/_bun/asset/missing.js' })
    expect(res).not.toBeNull()
    // Either 503 or some error — but NOT html (would break the script tag if served as text/html)
    const ct = res!.headers.get('content-type') ?? ''
    expect(ct).not.toContain('text/html')
  })

  test('non-GET requests pass through (no respondWith)', async () => {
    const res = await sb.triggerFetch({ url: 'http://localhost/upload', method: 'POST' })
    expect(res).toBeNull()
  })

  test('API paths pass through (no respondWith): /upload, /cost, /history, /history/:id', async () => {
    expect(await sb.triggerFetch({ url: 'http://localhost/upload' })).toBeNull()
    expect(await sb.triggerFetch({ url: 'http://localhost/cost' })).toBeNull()
    expect(await sb.triggerFetch({ url: 'http://localhost/history' })).toBeNull()
    expect(await sb.triggerFetch({ url: 'http://localhost/history/abc' })).toBeNull()
    expect(await sb.triggerFetch({ url: 'http://localhost/history/read-all' })).toBeNull()
  })

  test('cross-origin fetches pass through (no respondWith)', async () => {
    expect(await sb.triggerFetch({ url: 'https://api.openai.com/v1/anything' })).toBeNull()
  })
})
