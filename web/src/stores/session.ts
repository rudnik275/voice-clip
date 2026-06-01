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

export type SessionStatus = 'idle' | 'loading' | 'authenticated' | 'unauthenticated'

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

  /**
   * Resolve the session via GET /me.
   *  - 401 → redirect the browser to /login (matches the old app.ts boot).
   *  - 2xx → store the user, mark authenticated.
   *  - other failures → mark unauthenticated, no redirect.
   */
  async function load(): Promise<void> {
    status.value = 'loading'
    try {
      const res = await fetch('/me', { credentials: 'same-origin' })
      if (res.status === 401) {
        status.value = 'unauthenticated'
        // Under Tauri there is no /login route in the bundled webview —
        // tauriRedirectToLogin() opens Google OAuth in the system browser and
        // returns true so we DON'T navigate the webview to a dead /login. In
        // the PWA it returns false and we fall through to the real redirect.
        if (!tauriRedirectToLogin()) window.location.href = '/login'
        return
      }
      if (!res.ok) {
        status.value = 'unauthenticated'
        return
      }
      me.value = (await res.json()) as Me
      status.value = 'authenticated'
    } catch {
      status.value = 'unauthenticated'
    }
  }

  return { me, status, isAuthenticated, initial, load }
})
