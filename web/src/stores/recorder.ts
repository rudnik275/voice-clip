import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { RecorderMachine } from '../../../core/recorder-machine'
import type { RecorderState, RecorderSnapshot, TransitionEntry } from '../../../core/recorder-machine'
import { BrowserAudioAdapter } from '../../../core/browser-audio-adapter'
import { createUploader } from '../../../core/uploader'
import type { SendResult } from '../../../core/uploader'
import type { Uploader } from '../../../core/ports'
import { createOfflineSync, withOfflineFallback } from '../../../core/offline-sync'
import type { OfflineQueue, OfflineSync } from '../../../core/offline-sync'
import { createIdbOfflineQueue } from '../offline-queue-idb'
import { handleUnauthorized } from './session'
import {
  playStartRec,
  playStopRec,
  playPause,
  playResume,
  playSuccess,
  playError,
  unlockAudio,
  primeAudioSession,
  closeAudio,
} from '../../sounds'

// ---- recorder store: the thin Vue/Pinia wrapper around the capture core ----
//
// All the hard logic lives in core/ (RecorderMachine FSM + BrowserAudioAdapter
// + uploader). This store does only three things:
//   1. constructs the machine with the real adapter + an uploader that captures
//      the transcript text for the clipboard;
//   2. mirrors the machine's snapshot into reactive refs (state/elapsed/level/
//      error/status) that RecordView/RecordButton render;
//   3. owns the browser-gesture concerns the core deliberately doesn't: the
//      visibilitychange → BACKGROUNDED/FOREGROUNDED bridge, the iOS pending-
//      ClipboardItem trick (must be armed inside the stop gesture), UI sounds,
//      and the rAF loop that polls adapter.level() for the voice halo.
//
// The "next recording broken after backgrounding" bug is NOT fixed here (PRD
// #99 defers it) — we just drive the FSM faithfully so its transition log is
// observable in the browser via debugLog().

export type StatusKind = 'info' | 'error' | 'success'
// `text` is the short toast title; `preview` (optional) is a longer body —
// e.g. the transcribed text — that the view renders in a separate, line-clamped
// element so a long transcript can't grow the toast to cover the screen.
export type Status = { kind: StatusKind; text: string; preview?: string } | null

const STATUS_MS = 4200
/** Retry cadence while the offline queue is non-empty (CLAUDE.md offline protocol). */
const OFFLINE_RETRY_MS = 60_000

// Test seam: Bun's test runtime has no `indexedDB`, and tests need a fake
// queue to drive the wiring. Swap the factory BEFORE the store is first used.
let offlineQueueFactory: () => OfflineQueue | null = () =>
  typeof indexedDB !== 'undefined' ? createIdbOfflineQueue() : null
export function __setOfflineQueueFactory(f: () => OfflineQueue | null): void {
  offlineQueueFactory = f
}

export const useRecorderStore = defineStore('recorder', () => {
  const state = ref<RecorderState>('idle')
  const level = ref(0)
  const elapsedMs = ref(0)
  const error = ref<string | null>(null)
  const lastText = ref('')
  const status = ref<Status>(null)

  const isRecording = computed(() => state.value === 'recording')
  const isPaused = computed(() => state.value === 'paused')
  const isActive = computed(() => state.value === 'recording' || state.value === 'paused')
  const isBusy = computed(() => state.value === 'finalizing' || state.value === 'transcribing')

  // ---- machine + adapter (created lazily, browser-only) -------------------
  let machine: RecorderMachine | null = null
  let adapter: BrowserAudioAdapter | null = null
  let inited = false
  let prevState: RecorderState = 'idle'

  // elapsed bookkeeping (display only; the adapter owns the canonical duration)
  let startedAt = 0
  let pausedAccumMs = 0
  let pauseStartedAt = 0

  // visibility bridge: only FOREGROUND-resume a pause that WE caused by
  // backgrounding, never a manual pause.
  let backgrounded = false

  // pending iOS clipboard write, armed inside the stop gesture.
  let pending: { resolve: (t: string) => void; reject: () => void } | null = null
  let clipboardWritten = false

  let rafId = 0
  let statusTimer: ReturnType<typeof setTimeout> | 0 = 0

  // Real /upload transport. Server replies JSON {text} on success, {error} on
  // failure. The client does NOT send presetId (uploader builds the form).
  const send = async (form: FormData): Promise<SendResult> => {
    const r = await fetch('/upload', { method: 'POST', body: form, credentials: 'include' })
    // Session revoked mid-use → funnel into the login/sign-out path instead of
    // letting the core uploader classify the 401 as a permanent 4xx and toast
    // the raw server body (#136). The funnel is idempotent, so a burst of
    // concurrent 401s only redirects once. We still return the result so the
    // uploader/FSM unwind cleanly while the redirect takes over.
    if (r.status === 401) handleUnauthorized()
    let text = ''
    try {
      const body = (await r.json()) as { text?: string; error?: string }
      text = r.ok ? (body.text ?? '') : (body.error ?? '')
    } catch {
      // non-JSON (edge/Cloudflare HTML error page) — leave text empty
    }
    return { ok: r.ok, status: r.status, text }
  }

  // ---- offline upload queue (issue #140) -----------------------------------
  //
  // When the online upload fails with a TRANSPORT error (offline, DNS, reset),
  // the clip is persisted to IndexedDB and drained later with source=offline +
  // the original recordedAt (server inserts history only — #128). The queue
  // logic lives in core/offline-sync.ts; this store only wires the four drain
  // triggers: store init (app load), window 'online', after every successful
  // online upload, and a 60s retry while items remain.
  const offlineQueue = offlineQueueFactory()
  const offlineSync: OfflineSync | null = offlineQueue
    ? createOfflineSync({ queue: offlineQueue, send })
    : null
  // set by the uploader fallback when the CURRENT clip lands in the queue —
  // the transcribing→idle transition then shows the honest "saved offline"
  // toast instead of faking a transcription success.
  let queuedOffline = false
  let offlineRetryTimer: ReturnType<typeof setTimeout> | 0 = 0

  function scheduleOfflineRetry(keep: boolean): void {
    if (offlineRetryTimer) {
      clearTimeout(offlineRetryTimer)
      offlineRetryTimer = 0
    }
    if (keep) offlineRetryTimer = setTimeout(drainOffline, OFFLINE_RETRY_MS)
  }

  function drainOffline(): void {
    if (!offlineSync) return
    void offlineSync
      .drain()
      .then(({ remaining }) => scheduleOfflineRetry(remaining > 0))
      .catch(() => scheduleOfflineRetry(true))
  }

  if (offlineSync) {
    // trigger 2: the browser reports connectivity is back
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', drainOffline)
    }
    // trigger 1: app load (the store is constructed once the session resolves)
    drainOffline()
  }

  function ensureInit(): void {
    if (inited) return
    adapter = new BrowserAudioAdapter()
    const base = createUploader({ send })
    // Wrap the core uploader so the store can capture the transcript text for
    // the clipboard — the machine only inspects res.ok and discards the text.
    const wrapped: Uploader = {
      async upload(clip) {
        const res = await base.upload(clip)
        if (res.ok) {
          lastText.value = res.text
          // Refresh the session after a successful upload so the quota chip
          // reflects the new clip count. Import lazily to avoid Pinia init-
          // order issues (the recorder store is constructed before the Pinia
          // instance is registered in some test setups).
          const { useSessionStore } = await import('./session')
          useSessionStore().refresh().catch(() => {})
          // trigger 3: every successful online upload drains the queue
          drainOffline()
        }
        return res
      },
    }
    // Outermost layer: transport failure → persist to IndexedDB and report
    // success to the machine (it returns to idle; the clip is safe, not lost).
    // `queuedOffline` makes the idle transition show the offline toast.
    const uploader: Uploader = offlineSync
      ? withOfflineFallback(wrapped, offlineSync, () => {
          queuedOffline = true
          // trigger 4: keep the 60s retry alive while the item waits
          scheduleOfflineRetry(true)
        })
      : wrapped
    machine = new RecorderMachine({ adapter, uploader })
    machine.subscribe(onSnapshot)
    document.addEventListener('visibilitychange', onVisibility)
    inited = true
  }

  function onSnapshot(snap: RecorderSnapshot): void {
    const from = prevState
    state.value = snap.state
    error.value = snap.error
    prevState = snap.state

    // ---- elapsed timing transitions ----
    if (from !== 'recording' && snap.state === 'recording') {
      if (from === 'acquiring') {
        startedAt = Date.now()
        pausedAccumMs = 0
        pauseStartedAt = 0
      } else if (from === 'paused' && pauseStartedAt) {
        pausedAccumMs += Date.now() - pauseStartedAt
        pauseStartedAt = 0
      }
      ensureRaf()
    }
    if (snap.state === 'paused') {
      pauseStartedAt = Date.now()
    }

    // ---- success: transcribing → idle ----
    if (from === 'transcribing' && snap.state === 'idle') {
      if (queuedOffline) {
        // The clip landed in the offline queue, not on the server: there is no
        // transcript yet, so reject the pending ClipboardItem (nothing to
        // copy), skip the success bell (it would be a lie; no sound — the
        // error buzzer would be scarier than the situation warrants), and
        // tell the truth in the toast.
        queuedOffline = false
        finishClipboard(false)
        showStatus('info', 'Сохранено офлайн — отправится при подключении')
      } else {
        finishClipboard(true)
        playSuccess()
        // Short title + the transcript as a (line-clamped) preview body — same
        // split the pre-Vue app.ts used, so a long transcript stays 2 lines tall
        // instead of dumping the whole text into the toast and covering the screen.
        showStatus('success', 'Готово', lastText.value || undefined)
      }
    }

    // ---- failure: any → error ----
    if (snap.state === 'error') {
      finishClipboard(false)
      playError()
      if (from === 'acquiring') {
        showStatus('error', 'Нет доступа к микрофону — разреши доступ и попробуй снова')
      } else if (/short|quiet/i.test(snap.error ?? '')) {
        showStatus('info', 'Слишком коротко или тихо — попробуй ещё раз')
      } else {
        showStatus('error', snap.error || 'Не удалось распознать')
      }
      // Auto-RESET back to idle (closes the AudioContext, invariant 6) so the
      // button is immediately tappable again — the old UI never got stuck in
      // an error state, it just toasted and reset.
      queueMicrotask(() => machine?.send('RESET'))
    }

    // ---- returned to rest ----
    if (snap.state === 'idle' || snap.state === 'error') {
      stopRaf()
      elapsedMs.value = 0
      level.value = 0
    }
  }

  function onVisibility(): void {
    if (!machine) return
    if (document.hidden) {
      if (state.value === 'recording') {
        machine.send('BACKGROUNDED')
        backgrounded = true
      } else if (state.value === 'paused') {
        // Already paused (manual pause) when the app backgrounds: the machine
        // has no BACKGROUNDED edge from 'paused', so don't send an event — just
        // arm `backgrounded` so FOREGROUNDED fires on return and the dead-track
        // guard runs. Otherwise a track iOS kills while we're backgrounded+paused
        // would be re-enabled on manual resume and record silence (issue #134).
        backgrounded = true
      } else if (state.value === 'idle') {
        // Idle + backgrounded: drop the UI-sound context so the iOS audio
        // session fully releases (otherwise the lock screen shows a "Now
        // Playing" widget and holds the mic indicator). Recreated lazily on
        // the next gesture. Mirrors the old app.ts visibilitychange handler.
        closeAudio()
      }
    } else {
      if (backgrounded && state.value === 'paused') machine.send('FOREGROUNDED')
      backgrounded = false
      // Re-arm UI audio on every foreground. The old app.ts re-primed here on
      // each return to the app, so menu/copy sounds were always ready; the Vue
      // rewrite had only the record button doing this, leaving those sounds
      // silent after a background round-trip until the next record. iOS resets
      // the AVAudioSession category in the background, so prime BEFORE resuming.
      primeAudioSession()
      unlockAudio()
    }
  }

  // ---- rAF: poll the (already alpha-0.16-smoothed) adapter level + tick the
  //      timer while active. ----
  function ensureRaf(): void {
    if (rafId) return
    const tick = (): void => {
      level.value = adapter ? adapter.level() : 0
      elapsedMs.value = computeElapsed()
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
  }
  function stopRaf(): void {
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
  }
  function computeElapsed(): number {
    if (!startedAt) return 0
    const pausedNow = state.value === 'paused' && pauseStartedAt ? Date.now() - pauseStartedAt : 0
    return Math.max(0, Date.now() - startedAt - pausedAccumMs - pausedNow)
  }

  // ---- iOS clipboard: hand navigator.clipboard a PENDING ClipboardItem while
  //      still inside the stop gesture; resolve it when the transcript lands. --
  function armClipboard(): void {
    clipboardWritten = false
    const textPromise = new Promise<string>((resolve, reject) => {
      pending = { resolve, reject }
    })
    // never let a rejected pending become an unhandled rejection
    textPromise.catch(() => {})
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && 'write' in navigator.clipboard) {
        const item = new ClipboardItem({
          'text/plain': textPromise.then((t) => new Blob([t], { type: 'text/plain' })),
        })
        void navigator.clipboard
          .write([item])
          .then(() => {
            clipboardWritten = true
          })
          .catch(() => {})
      }
    } catch {
      // ClipboardItem unsupported — fall back to writeText on success
    }
  }
  function finishClipboard(ok: boolean): void {
    const p = pending
    pending = null
    if (!p) return
    if (ok) {
      p.resolve(lastText.value)
      if (!clipboardWritten) {
        void navigator.clipboard?.writeText?.(lastText.value).catch(() => {})
      }
    } else {
      p.reject()
    }
  }

  function showStatus(kind: StatusKind, text: string, preview?: string): void {
    status.value = { kind, text, preview }
    if (statusTimer) clearTimeout(statusTimer)
    statusTimer = setTimeout(() => {
      status.value = null
    }, STATUS_MS)
  }

  // ---- public actions -----------------------------------------------------

  /** Prime audio on the first gesture (iOS unlocks WebAudio inside a gesture). */
  function prime(): void {
    ensureInit()
    unlockAudio()
  }

  /** The single record button: tap to start, tap again to stop. */
  function tap(): void {
    ensureInit()
    unlockAudio()
    const s = state.value
    if (s === 'idle') {
      playStartRec()
      machine!.send('TAP')
    } else if (s === 'recording' || s === 'paused') {
      // arm the pending clipboard HERE, inside the user gesture (iOS)
      armClipboard()
      playStopRec()
      machine!.send('STOP')
    }
    // acquiring / finalizing / transcribing / error: ignore taps (the FSM would
    // ignore them anyway; we also skip the sound).
  }

  /** Pause / resume mid-recording (track.enabled toggle inside the adapter). */
  function togglePause(): void {
    if (!machine) return
    if (state.value === 'recording') {
      playPause()
      machine.send('PAUSE_TOGGLE')
    } else if (state.value === 'paused') {
      playResume()
      machine.send('PAUSE_TOGGLE')
    }
  }

  /** Observable FSM transition log — for diagnosing the backgrounding bug. */
  function debugLog(): TransitionEntry[] {
    return machine ? machine.transitionLog() : []
  }

  return {
    // state
    state,
    level,
    elapsedMs,
    error,
    lastText,
    status,
    // derived
    isRecording,
    isPaused,
    isActive,
    isBusy,
    // actions
    prime,
    tap,
    togglePause,
    debugLog,
    // The toast is rendered once (in RecordButton, #status) but driven from
    // here; expose showStatus so other surfaces (e.g. the history Copy button)
    // can raise the same toast instead of each owning a separate one.
    showStatus,
  }
})
