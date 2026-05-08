// Service Worker — caches app shell so the PWA loads when the Mac is unreachable.
// API requests (/upload, /cost, /history*) always go to network; offline queueing
// is handled by the page via IndexedDB.

const CACHE = 'voice-clip-v4'
const PRECACHE_URLS = ['/', '/offline']

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      // Precache best-effort: if any URL fails (first install while offline),
      // it will populate via postMessage from the page or runtime caching.
      await Promise.all(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => undefined)),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

// Page tells us about its bundled asset URLs (Bun's hashed paths) so we can
// cache them — they were loaded before this SW activated and therefore
// missed our normal fetch-handler caching.
self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'precache' || !Array.isArray(data.assets)) return
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      await Promise.all(
        data.assets.map(async (url) => {
          try {
            const existing = await cache.match(url)
            if (existing) return
            const res = await fetch(url, { cache: 'no-store' })
            if (res.ok) await cache.put(url, res.clone())
          } catch {
            /* ignore — runtime caching will pick it up */
          }
        }),
      )
    })(),
  )
})

function isApiPath(pathname) {
  return (
    pathname === '/upload' ||
    pathname === '/cost' ||
    pathname === '/history' ||
    pathname.startsWith('/history/')
  )
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (isApiPath(url.pathname)) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)

      try {
        const fresh = await fetch(req)
        if (fresh && fresh.ok) {
          cache.put(req, fresh.clone()).catch(() => undefined)
        }
        return fresh
      } catch {
        const cached = await cache.match(req)
        if (cached) return cached

        if (req.mode === 'navigate') {
          const offlinePage = await cache.match('/offline')
          if (offlinePage) return offlinePage
          const root = await cache.match('/')
          if (root) return root
        }
        return new Response('offline', { status: 503, statusText: 'offline' })
      }
    })(),
  )
})
