// Tauri-runtime adapter — bridges the cookie-+-same-origin PWA into the
// macOS desktop shell. Same web/ bundle drives both runtimes; this module
// is a no-op when `window.__TAURI__` is undefined (i.e. the PWA case), so
// importing it from app.ts has zero cost in the browser build.
//
// What it does in the Tauri webview:
//   1. Patches `window.fetch` to prefix relative paths with the server
//      origin (`https://voice.rudifamily.uk` by default; configurable via
//      VITE_-style runtime injection if we ever need it) and attach the
//      device_token from the macOS Keychain as `X-Device-Token`. Same code
//      in app.ts that does `fetch('/me', { credentials: 'include' })` then
//      hits the server with the right auth without any callsite changes.
//   2. Provides helpers `tauriRedirectToLogin` + `tauriSignOut` that
//      replace the PWA's `window.location` navigations — the Tauri shell
//      has no `/login` route and signs out via a Rust command that wipes
//      the Keychain and tears down the SSE worker.

declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T> }
      event: {
        listen: <T = unknown>(
          event: string,
          cb: (e: { payload: T }) => void,
        ) => Promise<() => void>
      }
    }
  }
}

const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined

export const IS_TAURI: boolean = Boolean(tauri)

// The PWA origin our Tauri shell talks to. Hard-coded for now; if/when we
// need a dev-vs-prod split this can flip to reading a build-time-injected
// constant.
const API_BASE = 'https://voice.rudifamily.uk'

// Resolved once on first fetch and cached. We can't top-level-await here
// without breaking older browsers that ship the same bundle, so each fetch
// awaits the (cheap) cached promise instead.
let tokenPromise: Promise<string | null> | null = null
function getDeviceToken(): Promise<string | null> {
  if (!tauri) return Promise.resolve(null)
  if (!tokenPromise) {
    tokenPromise = tauri.core
      .invoke<string | null>('get_device_token')
      .catch(() => null)
  }
  return tokenPromise
}

if (tauri) {
  // Pre-fetch pairing splash: if no device_token is in the Keychain yet,
  // show the #tauri-pair overlay (markup baked into home.html, hidden in
  // the PWA). Clicking the button calls `begin_pairing` which opens
  // Google OAuth in the system browser. When the deep-link comes back,
  // main.rs emits the `paired` event — we reload so the bundle starts
  // over with a valid token cached.
  void (async () => {
    const paired = await tauri.core.invoke<boolean>('is_paired').catch(() => false)
    if (!paired) showPairingSplash()
    // Always listen for `paired` — covers the cold-paired case AND the
    // re-pair-after-sign-out case.
    void tauri.event.listen('paired', () => window.location.reload())
  })()

  const realFetch = window.fetch.bind(window)
  window.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    let url: string
    if (typeof input === 'string') url = input
    else if (input instanceof URL) url = input.href
    else url = input.url

    // Prefix only relative app routes — leave absolute URLs (Google Fonts,
    // GitHub Releases, etc.) untouched.
    if (url.startsWith('/')) url = API_BASE + url

    const token = await getDeviceToken()
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    if (token) headers.set('X-Device-Token', token)

    return realFetch(url, { ...init, headers })
  }) as typeof window.fetch
}

function showPairingSplash(): void {
  if (!tauri) return
  const splash = document.getElementById('tauri-pair') as HTMLElement | null
  if (!splash) return
  splash.hidden = false
  const btn = document.getElementById('tauri-pair-btn') as HTMLButtonElement | null
  const hint = document.getElementById('tauri-pair-hint') as HTMLElement | null
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1'
    btn.addEventListener('click', () => {
      btn.disabled = true
      btn.textContent = 'Opening browser…'
      if (hint) hint.hidden = false
      void tauri.core.invoke('begin_pairing').catch((e) => {
        console.error('begin_pairing failed', e)
        btn.disabled = false
        btn.textContent = 'Sign in with Google'
      })
    })
  }
}

// Replaces `window.location.replace('/login')` from app.ts when running
// under Tauri. The webview has no /login route — and a rejected device_token
// must NOT auto-re-pair (that defeated "Revoke"; see below). Instead it drops
// the desktop app back to the SignedOut pairing splash.
// (In PWA mode this falls through to the original redirect.)
export function tauriRedirectToLogin(): boolean {
  if (!tauri) return false
  // A 401 from /me under Tauri means this Mac's device_token was rejected —
  // almost always because the device was revoked server-side (Profile →
  // Paired devices → Revoke). Device tokens never expire, so a 401 is
  // terminal: drop into the SignedOut state instead of silently re-pairing.
  //
  // The previous behaviour fire-and-forget invoked `begin_pairing` here,
  // which re-ran Google OAuth and minted a BRAND-NEW device — so "Revoke"
  // could never stick for a running desktop app: the revoked Mac reappeared
  // as a fresh device on its next /me. Instead: forget the dead cached token,
  // tear down the SSE worker + wipe the Keychain token via `sign_out`, and
  // show the pairing splash so re-pairing is an explicit, user-initiated tap.
  tokenPromise = Promise.resolve(null)
  void tauri.core.invoke('sign_out').catch(() => {})
  showPairingSplash()
  return true
}

// Replaces the `fetch('/logout') + redirect` flow from app.ts when running
// under Tauri. The server-side session doesn't exist for Tauri devices;
// instead the Rust `sign_out` command revokes the device, wipes the
// Keychain, and flips the webview back to the SignedOut view.
export async function tauriSignOut(): Promise<boolean> {
  if (!tauri) return false
  await tauri.core.invoke('sign_out').catch(() => {})
  return true
}
