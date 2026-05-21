// Service worker — cache-first PWA shell.
//
// See docs/adr/0001-pwa-boot-architecture.md for the design.
//
// Precaches the bootable shell (/, /style.css?v=VER, /app.ts?v=VER) so
// a reopened PWA renders entirely from disk with no network involvement.
// The server stamps __ASSET_VER__ into this file at request time; that
// stamp doubles as the cache name AND makes the served bytes change
// whenever any tracked asset (CSS, JS, this SW) changes, so the standard
// SW update lifecycle picks up the new version.
//
// We deliberately do NOT call skipWaiting() or clients.claim(): the new
// SW activates only after every controlled client closes, which on iOS
// means the next time you fully reopen the PWA. This avoids mid-session
// controller swaps that could disrupt a recording.

const VERSION = '__ASSET_VER__'
const CACHE = `voice-clip-${VERSION}`

const PRECACHE_URLS = [
  '/',
  `/style.css?v=${VERSION}`,
  `/app.ts?v=${VERSION}`,
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE_URLS)),
  )
})

self.addEventListener('activate', (event) => {
  // Drop any prior version's cache when this SW finally activates.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('voice-clip-') && k !== CACHE)
          .map((k) => caches.delete(k)),
      ),
    ),
  )
})

// Only intercept the shell. Everything else (API calls, /me, /upload,
// /history, /events, OAuth) passes straight through to the network — we
// never want to serve stale data for those.
function isShellRequest(url) {
  if (url.origin !== self.location.origin) return false
  if (url.pathname === '/') return true
  if (url.pathname === '/style.css') return true
  if (url.pathname === '/app.ts') return true
  return false
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (!isShellRequest(url)) return

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      // Match without query so an old precached /style.css?v=ABC still
      // serves a freshly-requested /style.css?v=ABC (same URL — exact
      // match) AND keeps working if the page references a slightly
      // different version (during the brief window between SW update
      // and activate). `ignoreSearch: true` covers the latter.
      const hit = await cache.match(req, { ignoreSearch: true })
      if (hit) return hit
      // Cache miss (cold install, or a URL we didn't precache): fall
      // through to the network. We don't add the result to the cache —
      // the install step is the only writer.
      return fetch(req)
    }),
  )
})
