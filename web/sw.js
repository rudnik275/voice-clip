// Service Worker — caches app shell so the PWA loads when the Mac (server) is unreachable.
// API requests (/upload, /cost, /history*) always go to network; offline queueing
// is handled by the page itself via IndexedDB.

const CACHE = 'voice-clip-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      try {
        await cache.add('/')
      } catch (e) {
        // first install while offline — fine, will populate on next online navigation
      }
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
      try {
        const fresh = await fetch(req)
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE)
          cache.put(req, fresh.clone()).catch(() => {})
        }
        return fresh
      } catch {
        const cache = await caches.open(CACHE)
        const cached = await cache.match(req)
        if (cached) return cached
        if (req.mode === 'navigate') {
          const root = await cache.match('/')
          if (root) return root
        }
        return new Response('offline', { status: 503, statusText: 'offline' })
      }
    })(),
  )
})
