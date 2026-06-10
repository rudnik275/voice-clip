// #136 — a 401 from the history fetch must funnel into the login/sign-out path
// (not surface "/history responded 401" forever) AND still throw so the store
// doesn't render stale data. Concurrent 401s only redirect once.

import { test, expect, beforeEach, afterEach, mock } from 'bun:test'

let redirectedTo: string | null = null
;(globalThis as unknown as { window: unknown }).window = {
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

const { fetchHistory } = await import('../../web/src/api/history')
const { __resetUnauthorizedGuard } = await import('../../web/src/stores/session')

const realFetch = globalThis.fetch

beforeEach(() => {
  redirectedTo = null
  __resetUnauthorizedGuard()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

test('history 401 → funnel to /login AND throws (no stale render)', async () => {
  globalThis.fetch = mock(async () => new Response('no', { status: 401 })) as unknown as typeof fetch

  await expect(fetchHistory({ limit: 30 })).rejects.toThrow()
  expect(redirectedTo).toBe('/login')
})

test('concurrent history 401s redirect only once', async () => {
  globalThis.fetch = mock(async () => new Response('no', { status: 401 })) as unknown as typeof fetch

  const results = await Promise.allSettled([
    fetchHistory({ limit: 30 }),
    fetchHistory({ limit: 30 }),
    fetchHistory({ limit: 30 }),
  ])
  for (const r of results) expect(r.status).toBe('rejected')
  // Funnel guard means a single redirect even for a burst.
  expect(redirectedTo).toBe('/login')
})

test('non-401 history failure throws a descriptive error, no redirect', async () => {
  globalThis.fetch = mock(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch

  await expect(fetchHistory({ limit: 30 })).rejects.toThrow('/history responded 500')
  expect(redirectedTo).toBeNull()
})
