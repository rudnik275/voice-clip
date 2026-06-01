// Self-destroying service worker — a one-shot kill-switch, NOT a real SW.
//
// Background: before the Vue rewrite the PWA registered `web/sw.js`, a
// cache-first worker that precached the old `home.html` shell (the preset
// OFF/ЧИСТКА panel + "+" button). The rewrite (ADR 0006, #106) removed the SW,
// but a registered service worker lives on every installed device until
// something REPLACES it — a 404 on `/sw.js` does not unregister it, so those
// devices keep serving the stale cached shell forever (the new Vue SPA never
// renders even though `/version` and the API hit the network fine).
//
// Serving this script at `/sw.js` lets the browser's normal SW update check
// (fired on the next navigation/PWA reopen, bypassing the HTTP cache) install
// it as a new worker. On activation it wipes every CacheStorage entry,
// unregisters itself, and reloads each open window — after which the device
// loads the live Vue SPA from the network with no service worker at all. This
// is consistent with ADR 0006 (no SW): the kill-switch removes itself.
//
// Once telemetry shows no devices still carry the legacy SW, this route +
// module can be deleted and `/sw.js` can go back to 404.
export const LEGACY_SW_KILL_SWITCH = `// voice-clip self-destroying service worker (kill-switch for the legacy PWA shell).
// Served by the server at /sw.js — see src/legacy-sw.ts for why this exists.
self.addEventListener('install', () => {
  // Activate immediately instead of waiting for old clients to close.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 1. Drop every cache the legacy SW created (names like voice-clip-<ver>).
    try {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    } catch (e) {}
    // 2. Take control of open windows so the reload below swaps their content.
    try { await self.clients.claim() } catch (e) {}
    // 3. Remove ourselves — once gone, the page loads with no controller.
    try { await self.registration.unregister() } catch (e) {}
    // 4. Force the stale shell out of view right now (don't wait for a manual
    //    reopen). The reloaded navigation has no controller -> fresh network SPA.
    try {
      const clients = await self.clients.matchAll({ type: 'window' })
      for (const client of clients) {
        try { client.navigate(client.url) } catch (e) {}
      }
    } catch (e) {}
  })())
})
`
