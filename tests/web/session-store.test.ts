// Web-side store tests for #136 — session boot error handling + the central
// 401 funnel. These run under `bun test` (plain .test.ts against the Pinia
// store) with a stubbed global `fetch` and a stubbed `window.location` /
// Tauri runtime, so no browser or extra deps are needed.

import { test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'

// ---- minimal browser globals the store touches ----
// `window.location.href` assignment is the PWA redirect funnel; we record it.
let redirectedTo: string | null = null
;(globalThis as unknown as { window: unknown }).window = {
  // No __TAURI__ → tauriRedirectToLogin() returns false → PWA redirect path.
  get location() {
    return {
      get href() {
        return ''
      },
      set href(v: string) {
        redirectedTo = v
      },
    }
  },
} as unknown as Window & typeof globalThis

// Import AFTER window is defined (tauri-runtime reads window.__TAURI__ at module
// init). Use a dynamic import so the global is in place first.
const { useSessionStore, handleUnauthorized, __resetUnauthorizedGuard, __setRetryDelays } =
  await import('../../web/src/stores/session')

// Shrink the auto-retry backoff so the retry chain doesn't sleep real seconds.
__setRetryDelays([0, 0, 0])

const realFetch = globalThis.fetch

function stubFetch(impl: () => Promise<Response>): void {
  globalThis.fetch = mock(impl) as unknown as typeof fetch
}

beforeEach(() => {
  setActivePinia(createPinia())
  redirectedTo = null
  __resetUnauthorizedGuard()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

test("load() with /me → 500 lands in 'error' (not 'unauthenticated')", async () => {
  let calls = 0
  stubFetch(async () => {
    calls++
    return new Response('boom', { status: 500 })
  })

  const session = useSessionStore()
  await session.load()

  expect(session.status).toBe('error')
  expect(session.isAuthenticated).toBe(false)
  // No redirect on a transient failure.
  expect(redirectedTo).toBeNull()
  // load() exhausts its retry budget on a persistent 500 (>1 attempt).
  expect(calls).toBeGreaterThan(1)
})

test("retry() re-attempts and recovers to 'authenticated'", async () => {
  let calls = 0
  stubFetch(async () => {
    calls++
    // First load(): persistent 500 (exhausts retries). After that, succeed.
    if (calls <= 4) return new Response('boom', { status: 500 })
    return Response.json({
      id: 'u1',
      email: 'a@b.c',
      name: 'Ann',
      picture_url: null,
      is_owner: false,
    })
  })

  const session = useSessionStore()
  await session.load()
  expect(session.status).toBe('error')

  const callsAfterLoad = calls
  await session.retry()
  expect(calls).toBeGreaterThan(callsAfterLoad) // retry re-hit the network
  expect(session.status).toBe('authenticated')
  expect(session.me?.name).toBe('Ann')
})

test('load() with /me → 401 in PWA mode funnels to /login', async () => {
  stubFetch(async () => new Response('no', { status: 401 }))

  const session = useSessionStore()
  await session.load()

  expect(session.status).toBe('unauthenticated')
  expect(redirectedTo).toBe('/login')
})

test('handleUnauthorized() redirects only once for concurrent 401s', () => {
  // Simulate a burst of mid-session 401s (history + upload firing together).
  handleUnauthorized()
  const first = redirectedTo
  redirectedTo = null
  handleUnauthorized()
  handleUnauthorized()

  expect(first).toBe('/login')
  // Guard flag prevents stacking a second navigation.
  expect(redirectedTo).toBeNull()
})

test('a successful /me settles authenticated with no redirect', async () => {
  stubFetch(async () =>
    Response.json({
      id: 'u2',
      email: 'x@y.z',
      name: 'Bob',
      picture_url: null,
      is_owner: true,
    }),
  )

  const session = useSessionStore()
  await session.load()

  expect(session.status).toBe('authenticated')
  expect(session.isAuthenticated).toBe(true)
  expect(session.initial).toBe('B')
  expect(redirectedTo).toBeNull()
})
