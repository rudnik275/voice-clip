import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { tauriRedirectToLogin } from '../../tauri-runtime'

// Shape of the GET /me response (src/server.ts). This foundation slice
// only needs identity + owner bit; plan/usage are carried through loosely
// for later slices (#103 history, #104 profile).
export interface Me {
  id: string
  email: string
  name: string
  picture_url: string | null
  is_owner: boolean
  plan?: string
  usage?: {
    clips_this_month: number
    monthly_limit: number | null
    free_monthly_limit: number | null
  }
}

// 'error' is the NEW state for a transport/5xx failure of GET /me — distinct
// from 'unauthenticated' (a clean 401, which redirects to login) and from a
// blank pre-load. App.vue renders a visible retry surface for it instead of
// the old permanent-blank-page bug (#136).
export type SessionStatus =
  | 'idle'
  | 'loading'
  | 'authenticated'
  | 'unauthenticated'
  | 'error'

// Guard so concurrent / repeated 401s don't stack multiple redirects (each
// would otherwise navigate the PWA or fire `sign_out` under Tauri again).
let redirecting = false

/**
 * Central 401 funnel. Any authenticated API call that gets a 401 should call
 * this — it routes into the existing logout path:
 *   - Tauri  → tauriRedirectToLogin() (clears the token, sign_out, pairing splash)
 *   - PWA    → window.location.href = '/login'
 * Idempotent: the first call wins; later calls (e.g. a burst of concurrent
 * 401s) are no-ops so we never stack redirects / sign-outs.
 */
export function handleUnauthorized(): void {
  if (redirecting) return
  redirecting = true
  // Under Tauri there is no /login route in the bundled webview —
  // tauriRedirectToLogin() opens the pairing splash and returns true. In the
  // PWA it returns false and we fall through to the real redirect.
  if (!tauriRedirectToLogin()) window.location.href = '/login'
}

// Test-only hook to reset the module-level guard between cases.
export function __resetUnauthorizedGuard(): void {
  redirecting = false
}

// Auto-retry config for transient /me failures. Backoff between attempts.
// Mutable so tests can shrink the delays (no real waiting) via the hook below.
let RETRY_DELAYS_MS = [500, 1500, 4000]

// Test-only: override the backoff delays so the retry chain doesn't sleep
// seconds in unit tests. Pass [] to retry with zero delay between attempts.
export function __setRetryDelays(delays: number[]): void {
  RETRY_DELAYS_MS = delays
}

export const useSessionStore = defineStore('session', () => {
  const me = ref<Me | null>(null)
  const status = ref<SessionStatus>('idle')

  const isAuthenticated = computed(
    () => status.value === 'authenticated' && me.value !== null,
  )

  // First letter of the user's name, for the topbar user pill.
  const initial = computed(() => {
    const name = me.value?.name?.trim()
    return name ? name[0]!.toUpperCase() : ''
  })

  // Tracks the in-flight auto-retry chain so a manual retry() doesn't race a
  // scheduled one (and so we can cancel a pending timer).
  let retryTimer: ReturnType<typeof setTimeout> | 0 = 0

  /**
   * One attempt at GET /me. Returns the resulting status so the caller
   * (load / retry) can decide whether to schedule another attempt.
   *  - 401 → 'unauthenticated' + funnel into the login/sign-out path.
   *  - 2xx → store the user, 'authenticated'.
   *  - transport throw / non-401 !ok (5xx, 502 during a deploy) → 'error'
   *    (a VISIBLE, retryable state — never a silent blank page).
   */
  async function attempt(): Promise<SessionStatus> {
    try {
      const res = await fetch('/me', { credentials: 'same-origin' })
      if (res.status === 401) {
        status.value = 'unauthenticated'
        handleUnauthorized()
        return 'unauthenticated'
      }
      if (!res.ok) {
        status.value = 'error'
        return 'error'
      }
      me.value = (await res.json()) as Me
      status.value = 'authenticated'
      return 'authenticated'
    } catch {
      status.value = 'error'
      return 'error'
    }
  }

  /**
   * Resolve the session via GET /me, with automatic backoff retries on a
   * transient failure. Settles on 'authenticated', 'unauthenticated', or
   * 'error' (after the retries are exhausted) — the latter shows the visible
   * retry surface in App.vue.
   */
  async function load(): Promise<void> {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = 0
    }
    status.value = 'loading'
    let result = await attempt()
    for (let i = 0; result === 'error' && i < RETRY_DELAYS_MS.length; i++) {
      await new Promise<void>((resolve) => {
        retryTimer = setTimeout(resolve, RETRY_DELAYS_MS[i])
      })
      retryTimer = 0
      result = await attempt()
    }
  }

  /** Manual retry — wired to the retry button in the error surface. */
  async function retry(): Promise<void> {
    await load()
  }

  return { me, status, isAuthenticated, initial, load, retry }
})
