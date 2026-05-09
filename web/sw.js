// Service Worker — caches app shell so the PWA loads when the Mac is unreachable.
// API requests (/upload, /cost, /history*) always go to network; offline queueing
// is handled by the page via IndexedDB.

const CACHE = 'voice-clip-v11'
const PRECACHE_URLS = ['/', '/offline']

// Last-resort HTML for navigations when both '/' and '/offline' missed cache —
// e.g. the very first visit happened on a flaky network and cache.add() failed.
// Self-contained: no external resources, just enough to give the user a button
// to retry.
const LAST_RESORT_HTML = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#07070b">
    <title>VoiceClip — offline</title>
    <style>
      *{box-sizing:border-box}
      html,body{margin:0;padding:0;height:100%}
      body{background:#07070b;color:#f1f1f7;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;padding:20px;text-align:center}
      h1{font-size:22px;font-weight:600;margin:0 0 12px;letter-spacing:-0.01em}
      p{font-size:14px;line-height:1.5;color:#8b8b9c;margin:0 0 24px;max-width:320px}
      button{font-size:15px;font-weight:600;font-family:inherit;padding:14px 26px;color:white;background:linear-gradient(135deg,#7383ff,#b15eff);border:none;border-radius:14px;cursor:pointer;box-shadow:0 8px 24px rgba(115,131,255,0.35)}
    </style>
  </head>
  <body>
    <main>
      <h1>OFFLINE</h1>
      <p>Mac не отвечает и кэш PWA пуст. Подключись к домашнему wifi и попробуй ещё раз.</p>
      <button onclick="location.replace('/')">Попробовать снова</button>
    </main>
  </body>
</html>`

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
    pathname === '/version' ||
    pathname === '/me' ||
    pathname === '/logout' ||
    pathname === '/events' ||
    pathname === '/events/ack' ||
    pathname === '/history' ||
    pathname.startsWith('/history/') ||
    pathname.startsWith('/signup/') ||
    pathname.startsWith('/login/') ||
    pathname.startsWith('/admin/')
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
          // Final fallback: inline HTML so the user always sees SOMETHING usable.
          return new Response(LAST_RESORT_HTML, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        }
        return new Response('offline', { status: 503, statusText: 'offline' })
      }
    })(),
  )
})
