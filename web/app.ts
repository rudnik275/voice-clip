// Browser entrypoint for the recording PWA.
//
// Responsibilities (issue #3 scope — NO offline queue / SW / Mac fan-out):
//   - Record audio via MediaRecorder, one-big-button press-and-hold OR tap.
//   - Voice-reactivity: RMS of the live mic → CSS `--voice-level` on #rec,
//     smoothed with alpha 0.16 (~95ms time constant — see CLAUDE.md).
//   - On stop: open a clipboard write with a PENDING promise BEFORE awaiting
//     the upload, so iOS Safari keeps the user-gesture clipboard grant alive
//     across the async transcription round-trip.
//   - History modal: fetch + render, `since` cursor pagination.

// Importing first so the runtime's fetch-patch installs before anything
// else in this bundle issues a request. In PWA mode this is a no-op.
import { IS_TAURI, tauriRedirectToLogin, tauriSignOut } from './tauri-runtime'
import {
  isMuted,
  playCopy,
  playError,
  playModal,
  playPause,
  playResume,
  playStartRec,
  playStopRec,
  playSuccess,
  setMuted,
  unlockAudio,
} from './sounds'

// ---- DIY observability (#55) ----
//
// reportError fires-and-forgets a JSON POST to /api/errors. The endpoint is
// unauthed (so pre-login crashes still land) and rate-limited server-side
// by client IP. We never await it from the throwing code path — failures
// inside the reporter must NOT bubble back and crash the app a second time.

export type ErrorReportType =
  | 'js_exception'
  | 'unhandled_rejection'
  | 'upload_failed'
  | 'transcription_error'
  | 'audio_encode_error'
  | 'network_error'
  | 'mediarecorder_error'
  | 'sw_error'
  | 'indexeddb_error'

function reportError(
  type: ErrorReportType,
  err: unknown,
  context?: Record<string, unknown>,
): void {
  try {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : (() => {
              try { return JSON.stringify(err) } catch { return String(err) }
            })()
    const stack = err instanceof Error ? err.stack : undefined
    void fetch('/api/errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      keepalive: true,
      body: JSON.stringify({
        type,
        message,
        stack,
        context: {
          ...context,
          url: location.pathname,
          userAgent: navigator.userAgent,
          ts: new Date().toISOString(),
        },
      }),
    }).catch(() => {
      /* the reporter is best-effort — swallow */
    })
  } catch {
    /* don't let the reporter throw */
  }
}

// iOS Safari ignores viewport `user-scalable=no` outside PWA standalone
// mode, so the user can accidentally pinch-zoom the UI. Block multi-touch
// gestures and Safari-specific `gesturestart` outright — there's no
// legitimate pinch target in this app, recording is one big button.
document.addEventListener(
  'touchmove',
  (e) => {
    if (e.touches.length > 1) e.preventDefault()
  },
  { passive: false },
)
document.addEventListener('gesturestart', (e) => e.preventDefault())
document.addEventListener('gesturechange', (e) => e.preventDefault())
document.addEventListener('dblclick', (e) => e.preventDefault())

window.addEventListener('error', (event) => {
  reportError('js_exception', event.error ?? event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  reportError('unhandled_rejection', event.reason)
})

// Re-export for module-internal call sites — the upload failure paths and
// any other catch handlers fire this directly with the right type.
export { reportError }

type HistoryClip = {
  seq: number
  text: string
  source: string
  recordedAt: string
  ts: number
}
type HistoryPage = { items: HistoryClip[]; nextSince?: number }
type UploadResponse = { text: string; seq: number; recordedAt: string }

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const recBtn = $<HTMLButtonElement>('rec')
const recLabel = $<HTMLElement>('rec-label')
const recTime = $<HTMLElement>('rec-time')
const recPause = $<HTMLButtonElement>('rec-pause')
const recPauseLabel = $<HTMLElement>('rec-pause-label')
const statusEl = $<HTMLElement>('status')
const historyBtn = $<HTMLButtonElement>('history-btn')
const historyModal = $<HTMLElement>('history-modal')
const historyList = $<HTMLElement>('history-list')
const historyClose = $<HTMLButtonElement>('history-close')
const historyBackdrop = $<HTMLElement>('history-backdrop')
// Download Mac app CTAs live in the Profile modal (ADR 0005). Two
// surfaces: the main card (with blurb) when the user has 0 paired Macs,
// the compact one-liner when they have ≥1. Both stay hidden unless the
// user is on a Mac browser AND not running inside the Tauri webview.
const downloadCtaCard = $<HTMLAnchorElement>('download-cta-card')
const downloadCtaCompact = $<HTMLAnchorElement>('download-cta-compact')
const userPill = $<HTMLElement>('user-pill')
const profileModal = $<HTMLElement>('profile-modal')
const profileBackdrop = $<HTMLElement>('profile-backdrop')
const profileClose = $<HTMLButtonElement>('profile-close')
const profileLogout = $<HTMLButtonElement>('profile-logout')
const profileDevices = $<HTMLElement>('profile-devices')
const userPillName = $<HTMLElement>('user-pill-name')
const soundsToggle = $<HTMLButtonElement>('sounds-toggle')
const soundsToggleState = $<HTMLElement>('sounds-toggle-state')
const soundsToggleAction = $<HTMLElement>('sounds-toggle-action')
const ownerInviteBlock = $<HTMLElement>('owner-invite-block')
const inviteGenerateBtn = $<HTMLButtonElement>('invite-generate')
const inviteHint = $<HTMLElement>('invite-hint')
const quotaChip = $<HTMLAnchorElement>('quota-chip')
const quotaLabel = $<HTMLElement>('quota-label')
const quotaCta = $<HTMLElement>('quota-cta')
const quotaBarFill = $<HTMLElement>('quota-bar-fill')
const quotaMeta = $<HTMLElement>('quota-meta')

function paintQuotaChip(me: Me): void {
  const plan = me.plan ?? 'free'
  const used = me.usage?.clips_this_month ?? 0
  // Prefer the new `monthly_limit` field — it's already plan-aware on the
  // server. Fall back to the legacy `free_monthly_limit` for clients that
  // haven't picked up the rename yet (only correct for free-tier users).
  const limit =
    me.usage?.monthly_limit !== undefined
      ? me.usage.monthly_limit
      : plan === 'free'
        ? (me.usage?.free_monthly_limit ?? null)
        : null

  quotaChip.classList.remove('is-pro', 'is-exhausted')

  if (plan === 'unlimited') {
    quotaChip.classList.add('is-pro')
    quotaLabel.textContent = 'Unlimited'
    quotaMeta.textContent = 'No monthly cap'
    quotaChip.hidden = false
    return
  }
  if (plan === 'pro' && (limit === null || limit === 0)) {
    quotaChip.classList.add('is-pro')
    quotaLabel.textContent = 'Pro plan'
    quotaMeta.textContent = 'Unlimited transcriptions'
    quotaChip.hidden = false
    return
  }
  if (limit === null || limit === 0) {
    // Quota disabled on the server side — nothing meaningful to show.
    quotaChip.hidden = true
    return
  }
  const ratio = Math.min(1, used / limit)
  quotaBarFill.style.width = `${Math.round(ratio * 100)}%`
  quotaLabel.textContent = plan === 'pro' ? 'Pro plan' : 'Free plan'
  if (plan === 'pro') {
    quotaChip.classList.add('is-pro')
    quotaCta.textContent = used >= limit ? 'Cap reached' : ''
  } else {
    quotaCta.textContent = used >= limit ? 'Upgrade now' : 'Upgrade'
  }
  quotaMeta.textContent = `${used} / ${limit} this month`
  if (used >= limit) quotaChip.classList.add('is-exhausted')
  quotaChip.hidden = false
}

function refreshSoundsToggle() {
  const muted = isMuted()
  soundsToggleState.textContent = muted ? 'Muted' : 'On'
  soundsToggleAction.textContent = muted ? 'Unmute' : 'Mute'
}

soundsToggle.addEventListener('click', () => {
  setMuted(!isMuted())
  refreshSoundsToggle()
})
refreshSoundsToggle()

// Owner-only: generate an invite link and copy it to the clipboard.
// The button is invisible to non-owners (see bootAuth → me.is_owner toggle).
inviteGenerateBtn.addEventListener('click', async () => {
  if (inviteGenerateBtn.disabled) return
  inviteGenerateBtn.disabled = true
  const prev = inviteHint.textContent
  inviteHint.textContent = 'Generating…'
  try {
    const r = await fetch('/admin/invites', { method: 'POST', credentials: 'include' })
    if (!r.ok) {
      inviteHint.textContent = 'Failed — try again'
      return
    }
    const { url } = (await r.json()) as { token: string; url: string }
    try {
      await navigator.clipboard.writeText(url)
      inviteHint.textContent = 'Copied to clipboard'
    } catch {
      // Clipboard API blocked — fall back to showing the URL inline so the
      // user can long-press to copy it manually.
      inviteHint.textContent = url
    }
  } catch {
    inviteHint.textContent = 'Failed — check your connection'
  } finally {
    inviteGenerateBtn.disabled = false
    setTimeout(() => { inviteHint.textContent = prev }, 4000)
  }
})

// The shell HTML carries no user-specific text (see
// docs/adr/0001-pwa-boot-architecture.md). On boot we paint the cached
// identity from localStorage immediately, then fetch /me to confirm or
// refresh. The cache key is namespaced so multiple stored values stay
// independent of each other.
const NAME_CACHE_KEY = 'vc:name'

type Me = {
  id: string
  email: string
  name: string
  picture_url: string | null
  is_owner: boolean
  plan?: 'free' | 'pro' | 'unlimited'
  usage?: {
    clips_this_month: number
    // null = no cap on this plan (typically 'unlimited').
    monthly_limit?: number | null
    // Legacy alias for clients that haven't shipped the rename yet —
    // tracks the FREE-tier cap specifically.
    free_monthly_limit?: number | null
  }
}

function readCachedName(): string {
  try {
    return localStorage.getItem(NAME_CACHE_KEY) || ''
  } catch {
    return ''
  }
}

function writeCachedName(name: string): void {
  try {
    localStorage.setItem(NAME_CACHE_KEY, name)
  } catch {
    /* private mode / storage quota — ignore */
  }
}

function clearCachedName(): void {
  try {
    localStorage.removeItem(NAME_CACHE_KEY)
  } catch {
    /* ignore */
  }
}

// Is the current client a Mac running outside the Tauri shell? Drives the
// "Download Mac app" CTAs in the Profile modal (ADR 0005). iPads on iOS 13+
// pretend to be Mac via navigator.platform; we filter them out via the
// userAgent + maxTouchPoints (Macs have 0 or 1, iPads report 5).
function isMacBrowser(): boolean {
  if (IS_TAURI) return false
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/i.test(ua)) return false
  if (navigator.maxTouchPoints > 1) return false
  return /Mac/i.test(navigator.platform || ua)
}
const SHOW_MAC_CTA = isMacBrowser()

let statusTimer: ReturnType<typeof setTimeout> | undefined

function showStatus(msg: string, kind: 'info' | 'error' | 'success' = 'info', preview?: string) {
  statusEl.className = ''
  if (kind === 'error') {
    statusEl.classList.add('error')
    playError()
  }
  if (kind === 'success') statusEl.classList.add('success')
  if (preview) {
    statusEl.classList.add('has-preview')
    statusEl.innerHTML = ''
    const title = document.createElement('span')
    title.className = 'toast-title'
    title.textContent = msg
    const prev = document.createElement('span')
    prev.className = 'toast-preview'
    prev.textContent = preview
    statusEl.append(title, prev)
  } else {
    statusEl.textContent = msg
  }
  statusEl.classList.add('show')
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = setTimeout(() => statusEl.classList.remove('show'), 4200)
}

// ---- history modal ----

let nextSince: number | undefined
let loadingMore = false

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function renderClip(clip: HistoryClip): HTMLElement {
  const item = document.createElement('div')
  item.className = 'history-item'

  const head = document.createElement('div')
  head.className = 'history-item-head'
  const time = document.createElement('span')
  time.className = 'history-time'
  time.textContent = fmtTime(clip.recordedAt)
  head.append(time)

  const text = document.createElement('p')
  text.className = 'history-text'
  text.textContent = clip.text || '—'

  const actions = document.createElement('div')
  actions.className = 'history-actions'
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.textContent = 'Copy'
  copyBtn.addEventListener('click', async () => {
    // PRIMARY action: write the text to THIS device's clipboard. The user
    // tapped "Copy" — they want to paste, here, on whatever they're holding.
    // The fan-out to paired Macs (via /clip/copy below) is a bonus side
    // effect, not the headline. Previous copy ("Sent to your Mac") implied
    // the text only went to the Mac, which surprised users on iPhone who
    // just wanted to paste locally.
    void navigator.clipboard?.writeText(clip.text).catch(() => {})
    copyBtn.disabled = true
    try {
      // Best-effort SSE fan-out so any paired Mac also pbcopies. Failure
      // here is not a "Copy failed" — the local clipboard write already
      // succeeded. We surface errors only when the local write itself
      // could not happen (no clipboard API at all — rare).
      void fetch('/clip/copy', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seq: clip.seq }),
      }).catch(() => {})
      playCopy()
      showStatus('Copied', 'success')
    } finally {
      copyBtn.disabled = false
    }
  })
  actions.append(copyBtn)

  item.append(head, text, actions)
  return item
}

async function loadHistory(reset: boolean): Promise<void> {
  if (loadingMore) return
  loadingMore = true
  try {
    if (reset) {
      nextSince = undefined
      historyList.innerHTML = ''
    }
    const qs = new URLSearchParams({ limit: '30' })
    if (nextSince !== undefined) qs.set('since', String(nextSince))
    const r = await fetch(`/history?${qs}`, { credentials: 'include' })
    if (!r.ok) {
      showStatus('Failed to load history', 'error')
      return
    }
    const page = (await r.json()) as HistoryPage
    if (reset && page.items.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'history-empty'
      empty.textContent = 'No recordings yet'
      historyList.append(empty)
    }
    for (const clip of page.items) historyList.append(renderClip(clip))
    nextSince = page.nextSince
    if (nextSince !== undefined) {
      const more = document.createElement('button')
      more.className = 'ghost-btn'
      more.id = 'history-more'
      more.type = 'button'
      more.textContent = 'Load more'
      more.addEventListener('click', () => {
        more.remove()
        void loadHistory(false)
      })
      historyList.append(more)
    }
  } finally {
    loadingMore = false
  }
}

function openHistory() {
  playModal()
  historyModal.hidden = false
  void loadHistory(true)
}
function closeHistory() {
  historyModal.hidden = true
}

historyBtn.addEventListener('click', openHistory)
historyClose.addEventListener('click', closeHistory)
historyBackdrop.addEventListener('click', closeHistory)

// ---- profile modal (paired devices + sign out) ----

type DeviceRow = {
  id: string
  label: string | null
  created_at: number
  last_seen_at: number
}

// Compact relative "last seen" — same vocabulary the user sees elsewhere.
function fmtRelative(ms: number): string {
  const diff = Date.now() - ms
  if (!Number.isFinite(diff) || diff < 0) return 'just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 45) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function renderDevice(d: DeviceRow): HTMLElement {
  const row = document.createElement('div')
  row.className = 'device-item'
  row.dataset.id = d.id

  const meta = document.createElement('div')
  meta.className = 'device-meta'
  const label = document.createElement('div')
  label.className = 'device-label'
  label.textContent = d.label || 'Unnamed Mac'
  const seen = document.createElement('div')
  seen.className = 'device-seen'
  seen.textContent = `Last seen ${fmtRelative(d.last_seen_at)}`
  meta.append(label, seen)

  const revoke = document.createElement('button')
  revoke.type = 'button'
  revoke.className = 'device-revoke'
  revoke.textContent = 'Revoke'
  revoke.addEventListener('click', async () => {
    if (!confirm(`Revoke "${d.label || 'Unnamed Mac'}"? It will stop receiving clips.`)) return
    revoke.disabled = true
    try {
      const r = await fetch(`/devices/${encodeURIComponent(d.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (r.ok) {
        row.remove()
        if (!profileDevices.querySelector('.device-item')) renderDevicesEmpty()
        showStatus('Device revoked', 'success')
      } else {
        revoke.disabled = false
        showStatus('Revoke failed', 'error')
      }
    } catch {
      revoke.disabled = false
      showStatus('Revoke failed', 'error')
    }
  })

  row.append(meta, revoke)
  return row
}

function renderDevicesEmpty() {
  const empty = document.createElement('p')
  empty.className = 'profile-empty'
  empty.textContent = 'No paired Macs yet'
  profileDevices.append(empty)
}

function updateDownloadCta(deviceCount: number | null): void {
  // `null` means we don't know the device count yet (load failed, request
  // pending). Hide both rather than guess — showing a CTA based on stale
  // info is worse than showing nothing.
  if (!SHOW_MAC_CTA || deviceCount === null) {
    downloadCtaCard.hidden = true
    downloadCtaCompact.hidden = true
    return
  }
  downloadCtaCard.hidden = deviceCount !== 0
  downloadCtaCompact.hidden = deviceCount === 0
}

async function loadDevices(): Promise<void> {
  profileDevices.innerHTML = ''
  try {
    const r = await fetch('/devices', { credentials: 'include' })
    if (!r.ok) {
      showStatus('Failed to load devices', 'error')
      // Server didn't answer — hide both CTAs to avoid showing a
      // misleading "you have 0 Macs" CTA when we actually don't know.
      updateDownloadCta(null)
      return
    }
    const list = (await r.json()) as DeviceRow[]
    if (list.length === 0) {
      renderDevicesEmpty()
    } else {
      for (const d of list) profileDevices.append(renderDevice(d))
    }
    updateDownloadCta(list.length)
  } catch {
    showStatus('Failed to load devices', 'error')
    updateDownloadCta(-1)
  }
}

function openProfile() {
  playModal()
  profileModal.hidden = false
  void loadDevices()
  refreshSoundsToggle()
}
function closeProfile() {
  profileModal.hidden = true
}

userPill.addEventListener('click', openProfile)
profileClose.addEventListener('click', closeProfile)
profileBackdrop.addEventListener('click', closeProfile)
profileLogout.addEventListener('click', async () => {
  if (!confirm('Sign out?')) return
  if (IS_TAURI) {
    // Tauri owns sign-out: tear down SSE worker + wipe Keychain. The Rust
    // `sign_out` command also flips the webview back to the pairing view
    // via the existing `signed_out` event listener, so we just close the
    // profile modal here and let the shell take over.
    closeProfile()
    clearCachedName()
    await tauriSignOut()
    return
  }
  try {
    await fetch('/logout', { method: 'POST', credentials: 'include' })
  } finally {
    clearCachedName()
    // Send the user straight to /login — going to `/` would briefly
    // flash the cached home shell before /me 401-redirects, which is
    // jarring right after they hit "Sign out".
    window.location.href = '/login'
  }
})

// ---- recording ----

let mediaRecorder: MediaRecorder | undefined
let chunks: Blob[] = []
// The mic stream is kept alive ACROSS quick successive recordings (instant
// start, no per-press getUserMedia latency) but released after a short idle
// once a recording ends — otherwise iOS shows the orange "mic in use"
// indicator for the whole session. The release happens inside onstop AFTER
// the blob is assembled (NOT right after mediaRecorder.stop(), which used to
// race the recorder's final flush → empty 5-byte blob → server 502).
let micStream: MediaStream | undefined
// Idle-release timer: keep the mic ~MIC_IDLE_RELEASE_MS after a stop so
// back-to-back records reuse the live stream; then drop it (indicator off).
let micReleaseTimer: ReturnType<typeof setTimeout> | undefined
const MIC_IDLE_RELEASE_MS = 1200
let audioCtx: AudioContext | undefined
let micSource: MediaStreamAudioSourceNode | undefined
let analyser: AnalyserNode | undefined
let rafId = 0
let recording = false
let startedAt = 0
let timeTimer: ReturnType<typeof setInterval> | undefined
let recordMime = 'audio/webm'

// Below these a recording is treated as "nothing captured" and is NOT sent
// to the server (avoids the 400/502 from empty or sub-0.1s audio).
const MIN_RECORD_MS = 350
const MIN_RECORD_BYTES = 1200

// Silence guard. Whisper / gpt-4o-transcribe will confidently invent a
// sentence from a recording that contains only a tap-click + room
// ambience, so we filter those out BEFORE paying for the round-trip.
//
// Two complementary signals (RMS scale matches tickVoice — speech
// 0.05–0.30, room ambience 0.005–0.015, a single finger-tap into the
// mic spikes to ~0.10 for one frame):
//
//   1. Peak RMS — catches "truly silent" recordings where even the
//      loudest frame is below ambient.
//   2. Voice-active fraction — frames-above-VOICE_RMS / total-frames.
//      A finger-tap blows past Peak in one frame but leaves the rest
//      of the recording at ambient; requiring ≥MIN_VOICE_ACTIVE_FRACTION
//      of frames be "voice" rejects that pattern.
//
// Thresholds dialed back from the initial v23 values (peak 0.04,
// voice 0.06, fraction 0.15) — short conversational utterances like
// «раз, раз» were getting flagged false-positive. A finger-tap still
// produces only 1–2 voice frames in a ~30-frame second, so 8% rejects
// it cleanly.
const SILENCE_RMS_THRESHOLD = 0.025
const VOICE_RMS_THRESHOLD = 0.04
const MIN_VOICE_ACTIVE_FRACTION = 0.08

// A genuinely dead/muted mic track outputs digital silence (every sample
// == 128 → rms exactly 0). Even a quiet room floor sits at ~0.005–0.015,
// well above this, so a peak that never crosses DEAD_MIC_RMS after a couple
// seconds means the capture is dead — surfaced as a LIVE warning so the user
// isn't dictating into the void. Much lower than SILENCE_RMS_THRESHOLD on
// purpose: that one rejects quiet recordings, this one detects no-signal.
const DEAD_MIC_RMS = 0.002

// Hard ceiling on a single recording — matches the server-side 5MB bytes
// cap and gives the Pro tier a predictable per-clip cost ceiling. The UI
// auto-stops at this point so the user doesn't accidentally bank 20 min of
// audio that the server would then refuse.
const MAX_RECORD_MS = 5 * 60 * 1000

// Tap-to-toggle (not push-to-hold) + mid-recording pause. Pause is done by
// disabling the mic track (NOT MediaRecorder.pause()) so the result is one
// continuous, always-valid blob with a silent gap — robust across
// browsers/codecs (esp. iOS mp4, which we just fixed for corruption).
let paused = false
let pausedAt = 0
let pausedTotalMs = 0
let transcribing = false
// True between a tap and the mic actually going live. While set, taps on the
// record button are ignored so an impatient second tap during the iOS
// permission sheet can't fire stopRecording() on a not-yet-armed recorder.
let acquiringMic = false
// Set when the app is backgrounded mid-recording: we pause (flush + disable
// the track) instead of letting the recorder capture silence, then on return
// either let the user resume (track survived) or finalize what was already
// dictated (iOS killed the track). See the visibilitychange handler.
let suspendedWhileRecording = false
// One-shot guard so the live "mic is silent" warning fires at most once per
// recording.
let deadMicWarned = false

// Spoken time so far, excluding any paused stretches.
function elapsedMs(): number {
  const base = Date.now() - startedAt - pausedTotalMs
  return paused ? base - (Date.now() - pausedAt) : base
}

const VOICE_ALPHA = 0.16 // smoothing — see CLAUDE.md "Voice reactivity"
let smoothedLevel = 0
let maxRmsObserved = 0
let totalFrames = 0
let voiceFrames = 0

function tickVoice() {
  if (!analyser) return
  const buf = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(buf)
  let sumSq = 0
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i]! - 128) / 128
    sumSq += v * v
  }
  const rms = Math.sqrt(sumSq / buf.length)
  if (!paused) {
    totalFrames++
    if (rms > maxRmsObserved) maxRmsObserved = rms
    if (rms > VOICE_RMS_THRESHOLD) voiceFrames++
  }
  // Map RMS (0..~0.5 typical speech) into 0..1, then exponential-smooth.
  const target = Math.min(1, rms * 3.2)
  smoothedLevel += (target - smoothedLevel) * VOICE_ALPHA
  recBtn.style.setProperty('--voice-level', smoothedLevel.toFixed(3))
  rafId = requestAnimationFrame(tickVoice)
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// MediaRecorder output is browser-specific: Chrome/Firefox/Android → audio/webm
// (opus), iOS Safari → audio/mp4 (AAC) and CANNOT do webm at all. We must send
// the real container + a matching filename extension, because OpenAI's
// transcription API decodes by the filename extension — labelling iOS mp4
// bytes as "clip.webm" makes OpenAI reject them and the server returns 502.
const MIME_CANDIDATES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav']

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return undefined
  for (const m of MIME_CANDIDATES) if (MediaRecorder.isTypeSupported(m)) return m
  return undefined
}

function extForMime(mime: string): string {
  const base = (mime.split(';')[0] || '').trim()
  switch (base) {
    case 'audio/webm':
      return 'webm'
    case 'audio/mp4':
      return 'mp4'
    case 'audio/x-m4a':
    case 'audio/m4a':
      return 'm4a'
    case 'audio/ogg':
      return 'ogg'
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav'
    case 'audio/mpeg':
      return 'mp3'
    default:
      return 'webm'
  }
}

// Acquire the mic ONCE; reuse the live stream for every subsequent press
// (instant start, no per-press getUserMedia latency).
//
// Track liveness check: `readyState === 'live'` AND `muted === false`. iOS
// sets `muted = true` (without ending the track) when another app takes
// the mic mid-session — e.g. an incoming phone call. The old check passed
// these stale tracks through, so the next recording captured silence and
// the user got "Не услышал тебя — говори громче" on a 30-second dictation.
async function ensureMic(): Promise<MediaStream> {
  const usable = micStream
    ?.getAudioTracks()
    .some((t) => t.readyState === 'live' && !t.muted)
  if (micStream && usable) return micStream
  // Reacquiring — first stop any stale tracks so iOS releases the indicator
  // before the new stream lights it up again.
  if (micStream) for (const t of micStream.getTracks()) t.stop()
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  micSource = undefined // a new stream invalidates the old source node
  return micStream
}

function cancelMicRelease() {
  if (micReleaseTimer) {
    clearTimeout(micReleaseTimer)
    micReleaseTimer = undefined
  }
}

// Actually stop the mic tracks → iOS drops the "mic in use" indicator.
function releaseMic() {
  micReleaseTimer = undefined
  if (recording) return // a new recording started in the grace window
  if (micStream) for (const t of micStream.getTracks()) t.stop()
  micStream = undefined
  micSource = undefined
}

// Safe to call ONLY once the blob is captured (inside onstop). Defers the
// track stop by a short idle so a quick re-record keeps the stream live.
function scheduleMicRelease() {
  cancelMicRelease()
  micReleaseTimer = setTimeout(releaseMic, MIC_IDLE_RELEASE_MS)
}

// Drop the mic stream NOW, regardless of the `recording` guard in
// releaseMic(). Used after we've already finalized a recording that iOS
// killed in the background — the next press must reacquire a fresh stream.
function forceReleaseMic() {
  cancelMicRelease()
  if (micStream) for (const t of micStream.getTracks()) t.stop()
  micStream = undefined
  micSource = undefined
}

// A FRESH AudioContext per recording, created inside the user gesture and
// closed on stop. A persistent context gets auto-suspended by iOS between
// recordings → the analyser returned silence → the voice pulsation died.
// The mic STREAM stays persistent (that is the empty-blob fix); only this
// lightweight analyser graph is rebuilt.
function startMeters(s: MediaStream) {
  audioCtx = new AudioContext()
  if (audioCtx.state === 'suspended') void audioCtx.resume()
  micSource = audioCtx.createMediaStreamSource(s)
  analyser = audioCtx.createAnalyser()
  analyser.fftSize = 1024
  micSource.connect(analyser)
  // Safari only pulls data through the graph if it reaches a destination —
  // route the analyser through a muted gain so the meter stays live.
  const sink = audioCtx.createGain()
  sink.gain.value = 0
  analyser.connect(sink)
  sink.connect(audioCtx.destination)
}

async function startRecording() {
  if (recording) return
  recording = true
  cancelMicRelease() // re-recording within the idle window → keep the stream
  let s: MediaStream
  acquiringMic = true
  try {
    s = await ensureMic()
  } catch {
    recording = false
    acquiringMic = false
    showStatus('Нет доступа к микрофону', 'error')
    return
  }
  acquiringMic = false
  // An ultra-fast tap may have already fired stopRecording during the
  // (first-time only) getUserMedia await — abort cleanly.
  if (!recording) return
  // Play the start tick AFTER the mic is live. The iOS permission modal
  // (first run) and any context-suspended state coming back from
  // background both swallow audio scheduled before this point — placing
  // playStartRec here makes the first tap always audible.
  unlockAudio()
  playStartRec()

  chunks = []
  startedAt = Date.now()
  paused = false
  pausedTotalMs = 0
  for (const t of s.getAudioTracks()) t.enabled = true // clear any prior pause
  const chosenMime = pickRecorderMime()
  mediaRecorder = chosenMime
    ? new MediaRecorder(s, { mimeType: chosenMime })
    : new MediaRecorder(s)
  recordMime = mediaRecorder.mimeType || chosenMime || 'audio/webm'
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  mediaRecorder.onerror = (e) => {
    reportError('mediarecorder_error', (e as ErrorEvent).error ?? 'MediaRecorder error', {
      mime: recordMime,
      state: mediaRecorder?.state,
    })
  }
  // timeslice → periodic dataavailable, so audio is never lost even if the
  // final flush at stop() is abrupt.
  mediaRecorder.start(250)

  startMeters(s)
  smoothedLevel = 0
  maxRmsObserved = 0
  totalFrames = 0
  voiceFrames = 0
  deadMicWarned = false
  rafId = requestAnimationFrame(tickVoice)

  recBtn.classList.add('recording')
  recLabel.textContent = 'Recording'
  recTime.textContent = '00:00'
  recPause.classList.remove('is-paused')
  recPauseLabel.textContent = 'Pause'
  recPause.hidden = false
  timeTimer = setInterval(() => {
    const ms = elapsedMs()
    recTime.textContent = fmtElapsed(ms)
    // Dead-mic detector: after ~2.5s of (non-paused) recording, if the loudest
    // frame so far never crossed the no-signal floor, the capture is dead —
    // tell the user NOW so a long dictation isn't lost into the void.
    if (
      !deadMicWarned &&
      !paused &&
      ms >= 2500 &&
      totalFrames >= 60 &&
      maxRmsObserved < DEAD_MIC_RMS
    ) {
      deadMicWarned = true
      showStatus('Микрофон молчит — звука нет. Останови и запиши заново', 'error')
    }
    if (ms >= MAX_RECORD_MS) {
      showStatus('Достиг лимита 5 минут — остановил', 'info')
      void stopRecording()
    }
  }, 250)
}

// Pause/resume mid-recording by toggling the mic track. Recorder.state
// stays 'recording' the whole time → the final blob is one valid file.
function togglePause() {
  if (!recording || !micStream) return
  paused = !paused
  for (const t of micStream.getAudioTracks()) t.enabled = !paused
  if (paused) {
    pausedAt = Date.now()
    recBtn.classList.add('paused')
    recPause.classList.add('is-paused')
    recPauseLabel.textContent = 'Resume'
    playPause()
  } else {
    pausedTotalMs += Date.now() - pausedAt
    recBtn.classList.remove('paused')
    recPause.classList.remove('is-paused')
    recPauseLabel.textContent = 'Pause'
    playResume()
  }
}

// Tear down the per-recording analyser graph (NOT the mic stream — that
// stays persistent so the next press is instant and never races the
// recorder's flush). Closing the context releases the iOS audio slot.
function stopMeters() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  recBtn.style.setProperty('--voice-level', '0')
  if (timeTimer) clearInterval(timeTimer)
  timeTimer = undefined
  try {
    micSource?.disconnect()
  } catch {
    /* already disconnected */
  }
  micSource = undefined
  analyser = undefined
  if (audioCtx) {
    void audioCtx.close()
    audioCtx = undefined
  }
}

// The recurring "502 every few recordings" was NOT a tunnel flap — it was
// empty/short blobs (capture race, now fixed by the persistent stream +
// MIN_RECORD_* guard). This retry stays only as a thin safety net for a
// GENUINE one-off transport blip on an otherwise-valid recording (the blob
// is in memory and a 5xx means it was not processed → safe to resend).
const UPLOAD_MAX_ATTEMPTS = 3
const uploadBackoffMs = (attempt: number) => Math.min(600 * 2 ** (attempt - 1), 4000)
const delay = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

// Extract a human message from a failed response WITHOUT dumping the raw
// Cloudflare HTML error page into the toast. The server sends JSON
// {error:"…"}; Cloudflare/edge sends an HTML page — never surface the latter.
async function failureMessage(r: Response): Promise<string> {
  try {
    const t = await r.text()
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('application/json') || t.trimStart().startsWith('{')) {
      const j = JSON.parse(t) as { error?: string }
      if (j.error) return j.error
    }
  } catch {
    /* fall through to a generic message */
  }
  if (r.status === 502 || r.status === 503 || r.status === 504)
    return `сервер недоступен (${r.status}) — попробуй ещё раз`
  return `ошибка загрузки (${r.status})`
}

function uploadAndTranscribe(blob: Blob, recordedAt: string): Promise<string> {
  const filename = `clip.${extForMime(blob.type || recordMime)}`

  const attempt = async (n: number): Promise<string> => {
    const fd = new FormData()
    fd.set('audio', blob, filename)
    fd.set('recordedAt', recordedAt)

    let r: Response
    try {
      r = await fetch('/upload', { method: 'POST', body: fd, credentials: 'include' })
    } catch (e) {
      // transport-level failure (tunnel/connection dropped) — retry
      if (n < UPLOAD_MAX_ATTEMPTS) {
        showStatus(`Сеть нестабильна — повтор ${n}/${UPLOAD_MAX_ATTEMPTS - 1}…`, 'info')
        await delay(uploadBackoffMs(n))
        return attempt(n + 1)
      }
      reportError('network_error', e, { endpoint: '/upload', attempt: n, blobBytes: blob.size, mime: blob.type })
      throw new Error('сеть недоступна — запись не отправлена')
    }

    if (r.ok) {
      const body = (await r.json()) as UploadResponse
      showStatus('Transcribed', 'success', body.text)
      return body.text
    }

    // 502/503/504 = transient edge/tunnel flap → retry the same blob
    if ((r.status === 502 || r.status === 503 || r.status === 504) && n < UPLOAD_MAX_ATTEMPTS) {
      showStatus(`Сервер недоступен — повтор ${n}/${UPLOAD_MAX_ATTEMPTS - 1}…`, 'info')
      await delay(uploadBackoffMs(n))
      return attempt(n + 1)
    }

    const msg = await failureMessage(r)
    reportError(r.status === 502 ? 'transcription_error' : 'upload_failed', msg, {
      endpoint: '/upload',
      status: r.status,
      blobBytes: blob.size,
      mime: blob.type,
    })
    throw new Error(msg)
  }

  return attempt(1)
}

// Sentinel: nothing meaningful was captured — surfaced as a calm hint, not
// an error, and never sent to the server.
class TooShort extends Error {}
class TooQuiet extends Error {}

// Gate a finished recording on size + the silence heuristics, then upload.
// Throws TooShort / TooQuiet so callers can show the calm hint instead of an
// error. Shared by the normal stop path and the background-suspend finalize.
function gateAndUpload(
  blob: Blob,
  durationMs: number,
  recordedAt: string,
  peakRms: number,
  voiceFraction: number,
  snapTotalFrames: number,
  snapVoiceFrames: number,
): Promise<string> {
  if (durationMs < MIN_RECORD_MS || blob.size < MIN_RECORD_BYTES) {
    throw new TooShort()
  }
  // Whisper/gpt-4o-transcribe hallucinate confident sentences from silence;
  // gate the upload on real voice activity. Peak catches truly silent rooms,
  // voice-active fraction catches the "tap-the-mic + a second of nothing".
  if (peakRms < SILENCE_RMS_THRESHOLD || voiceFraction < MIN_VOICE_ACTIVE_FRACTION) {
    reportError('audio_encode_error', 'silence-detect rejected', {
      peakRms: Number(peakRms.toFixed(4)),
      voiceFraction: Number(voiceFraction.toFixed(4)),
      totalFrames: snapTotalFrames,
      voiceFrames: snapVoiceFrames,
      durationMs,
      blobBytes: blob.size,
    })
    throw new TooQuiet()
  }
  return uploadAndTranscribe(blob, recordedAt)
}

// Tear down the recording UI (pause control, paused state, meters) and
// always leave the mic track ENABLED so the next recording isn't silent
// if the user stopped while paused.
function endRecordingUi() {
  stopMeters()
  paused = false
  if (micStream) for (const t of micStream.getAudioTracks()) t.enabled = true
  recBtn.classList.remove('recording', 'paused')
  recPause.classList.remove('is-paused')
  recPause.hidden = true
  recTime.textContent = ''
}

async function stopRecording() {
  if (!recording) return
  recording = false
  playStopRec()
  const durationMs = elapsedMs()

  // Start still in flight (ultra-fast tap) or recorder never armed — nothing
  // was captured; just reset, no server round-trip.
  if (!mediaRecorder || mediaRecorder.state !== 'recording') {
    endRecordingUi()
    recBtn.classList.remove('busy')
    recLabel.textContent = 'Tap to record'
    showStatus('Слишком коротко — попробуй ещё раз', 'info')
    scheduleMicRelease() // mic was acquired but unused — let it go
    return
  }

  const recordedAt = new Date(startedAt).toISOString()
  const peakRms = maxRmsObserved
  // Snapshot the voice-activity counters at the moment of stop so they
  // can't drift if any later code reuses the top-level vars.
  const snapTotalFrames = totalFrames
  const snapVoiceFrames = voiceFrames
  const voiceFraction = snapTotalFrames > 0 ? snapVoiceFrames / snapTotalFrames : 0
  const stopped = new Promise<Blob>((resolve) => {
    mediaRecorder!.onstop = () => {
      const mime = mediaRecorder!.mimeType || recordMime
      resolve(new Blob(chunks, { type: mime }))
      // Blob fully assembled — now it's safe to drop the mic (no flush race).
      scheduleMicRelease()
    }
  })
  mediaRecorder.stop()

  endRecordingUi()
  recBtn.classList.add('busy')
  recLabel.textContent = ''
  transcribing = true

  // iOS Safari only honours navigator.clipboard.write() synchronously inside
  // the user gesture. Hand it a PENDING ClipboardItem promise NOW so the
  // grant survives the async upload — it resolves to the transcript once the
  // round-trip completes (or rejects harmlessly if nothing was captured).
  const textPromise = stopped.then((blob) =>
    gateAndUpload(
      blob,
      durationMs,
      recordedAt,
      peakRms,
      voiceFraction,
      snapTotalFrames,
      snapVoiceFrames,
    ),
  )

  let clipboardWritten = false
  try {
    if (
      typeof ClipboardItem !== 'undefined' &&
      navigator.clipboard &&
      'write' in navigator.clipboard
    ) {
      const item = new ClipboardItem({
        'text/plain': textPromise.then((t) => new Blob([t], { type: 'text/plain' })),
      })
      await navigator.clipboard.write([item])
      clipboardWritten = true
    }
  } catch {
    clipboardWritten = false
  }

  try {
    const text = await textPromise
    if (!clipboardWritten) {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        /* clipboard unavailable — toast still shows the transcript */
      }
    }
    playSuccess()
  } catch (e) {
    if (e instanceof TooShort) {
      showStatus('Слишком коротко — запиши подольше', 'info')
    } else if (e instanceof TooQuiet) {
      showStatus('Не услышал тебя — говори громче', 'info')
    } else {
      showStatus((e as Error).message || 'Не удалось распознать', 'error')
    }
  } finally {
    recBtn.classList.remove('busy')
    recLabel.textContent = 'Tap to record'
    recTime.textContent = ''
    transcribing = false
  }
}

// Salvage a recording that was paused by backgrounding when the mic did NOT
// survive (iOS muted/ended the track while we were away). The MediaRecorder
// is bound to that dead stream, so we can't continue it — instead assemble
// the blob from the chunks captured BEFORE the switch and run them through
// the same gate + upload, so what the user dictated isn't lost. Not inside a
// user gesture, so the local clipboard write is best-effort; the transcript
// still reaches the server (and the Mac daemon) and the history.
async function finalizeSuspended() {
  const durationMs = elapsedMs()
  const recordedAt = new Date(startedAt).toISOString()
  const peakRms = maxRmsObserved
  const snapTotalFrames = totalFrames
  const snapVoiceFrames = voiceFrames
  const voiceFraction = snapTotalFrames > 0 ? snapVoiceFrames / snapTotalFrames : 0

  recording = false
  paused = false

  let blob: Blob
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      const stopped = new Promise<Blob>((resolve) => {
        mediaRecorder!.onstop = () =>
          resolve(new Blob(chunks, { type: mediaRecorder!.mimeType || recordMime }))
      })
      mediaRecorder.stop()
      // If the recorder can't fire onstop (frozen by the OS) fall back to the
      // chunks we already have rather than hanging forever.
      blob = await Promise.race([
        stopped,
        delay(800).then(() => new Blob(chunks, { type: recordMime })),
      ])
    } else {
      blob = new Blob(chunks, { type: recordMime })
    }
  } catch {
    blob = new Blob(chunks, { type: recordMime })
  }

  endRecordingUi()
  forceReleaseMic()

  recBtn.classList.add('busy')
  recLabel.textContent = ''
  transcribing = true
  try {
    const text = await gateAndUpload(
      blob,
      durationMs,
      recordedAt,
      peakRms,
      voiceFraction,
      snapTotalFrames,
      snapVoiceFrames,
    )
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* no gesture / clipboard blocked — transcript still in toast + history */
    }
    playSuccess()
  } catch (e) {
    if (e instanceof TooShort || e instanceof TooQuiet) {
      showStatus('Запись свёрнута — нечего распознавать', 'info')
    } else {
      showStatus((e as Error).message || 'Не удалось распознать', 'error')
    }
  } finally {
    recBtn.classList.remove('busy')
    recLabel.textContent = 'Tap to record'
    recTime.textContent = ''
    transcribing = false
  }
}

// Tap to start, tap again to stop (no press-and-hold). Taps are ignored
// while a transcription is still in flight or the mic is still being acquired
// (so an impatient tap during the iOS permission sheet can't cancel the
// not-yet-armed recording).
recBtn.addEventListener('click', () => {
  if (transcribing || acquiringMic) return
  if (recording) void stopRecording()
  else void startRecording()
})

// Pre-warm the mic the moment the finger lands on the record button.
// `touchstart` fires 50-200ms before `click` on iOS, so the
// getUserMedia round-trip overlaps the click pipeline. If the click
// follows, startRecording() calls cancelMicRelease() and uses the
// warm stream. If the click never comes (user slid off the button),
// the scheduled release here drops the stream after the same
// MIC_IDLE_RELEASE_MS window — so the iOS "mic in use" indicator
// turns off and the mic isn't held open indefinitely. Failures are
// silent: this is a hint, the real error reporting happens inside
// startRecording.
//
// We also unlock the WebAudio context here. iOS keeps it 'suspended'
// until a user gesture explicitly resumes it; doing it at touchstart
// (rather than inside playStartRec()) means the start-of-record tick
// actually makes it out the speaker on the very first tap.
recBtn.addEventListener('touchstart', () => {
  unlockAudio()
  if (recording || transcribing) return
  ensureMic().then(() => scheduleMicRelease()).catch(() => {})
}, { passive: true })
// Desktop / non-touch: pointerdown is the equivalent first-gesture hook.
recBtn.addEventListener('pointerdown', () => {
  unlockAudio()
}, { passive: true })

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // Backgrounded mid-recording: iOS mutes the mic the moment we lose the
    // foreground, so continuing to "record" just banks silence — and the
    // user has no idea their dictation is being lost. PAUSE instead: flush
    // whatever audio is buffered into `chunks`, then disable the track (the
    // existing pause keeps the recorder armed and the blob valid). On return
    // we either resume or finalize what was already said — nothing is lost.
    if (recording && !paused) {
      try {
        if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.requestData()
      } catch {
        /* requestData unsupported / wrong state — chunks already has the audio */
      }
      togglePause()
      suspendedWhileRecording = true
      return
    }
    // Idle: proactively release the warm mic stream so iOS doesn't play its
    // "microphone in use changed" notification on the indicator handoff.
    if (!recording && !transcribing) {
      cancelMicRelease()
      releaseMic()
    }
    return
  }
  // Page came back. Returning the PWA from background suspends both the
  // AudioContext and the MediaStream tracks on iOS. Re-arm the audio graph
  // immediately so the first tap is instant.
  unlockAudio()

  // We paused an in-progress recording when we left. Decide what to do based
  // on whether the mic track actually survived the round trip.
  if (suspendedWhileRecording) {
    suspendedWhileRecording = false
    const track = micStream?.getAudioTracks()[0]
    const alive = !!track && track.readyState === 'live' && !track.muted
    if (alive) {
      // The OS kept the stream (short switch / Android). Stay paused and let
      // the user resume on their own terms — auto-resuming would capture the
      // fumble of returning to the app. Re-arm the (likely iOS-suspended)
      // analyser context so the voice meter pulses again on resume.
      if (audioCtx && audioCtx.state === 'suspended') void audioCtx.resume()
      showStatus('На паузе — нажми ⏸ чтобы продолжить', 'info')
    } else {
      // iOS killed/muted the track. The recorder is bound to that dead
      // stream and can't continue — finalize what was already dictated.
      showStatus('Распознаю надиктованное…', 'info')
      void finalizeSuspended()
    }
    return
  }

  if (recording || transcribing) return
  // Drop a stream whose tracks went 'ended' while backgrounded — the next
  // ensureMic() will reacquire cleanly. Don't proactively call ensureMic
  // here: that triggers the orange iOS mic indicator without user intent.
  const dead = micStream && micStream.getAudioTracks().every((t) => t.readyState !== 'live')
  if (dead) {
    for (const t of micStream!.getTracks()) t.stop()
    micStream = undefined
    micSource = undefined
  }
})

recPause.addEventListener('click', () => togglePause())

// ---- boot ----

// REC button is shown on every client — mobile, desktop browser, Tauri
// webview (ADR 0005). The download-CTA in the Profile modal is what
// nudges Mac browser users toward the .app for passive receiving; see
// updateDownloadCta() above.

// Paint the user pill from localStorage instantly — for the common
// returning-user case there is zero perceptible delay between shell
// paint and personalized UI. /me runs in the background to confirm or
// refresh.
const cachedName = readCachedName()
if (cachedName) userPillName.textContent = cachedName

async function bootAuth(): Promise<void> {
  let r: Response
  try {
    r = await fetch('/me', { credentials: 'include' })
  } catch {
    // Offline or transient network blip. The cached name is already
    // on screen; nothing else to do. /upload itself will retry/fail
    // visibly if the user actually tries to record.
    return
  }
  if (r.status === 401) {
    clearCachedName()
    if (IS_TAURI) {
      // Tauri devices are paired explicitly via the OAuth deep-link flow
      // (begin_pairing → voiceclip://callback). The webview has no /login
      // route — the Rust shell will surface the SignedOut view when the
      // Keychain is wiped. Kick off pairing as a safety-net for the rare
      // case where /me 401s with a token still present.
      tauriRedirectToLogin()
      return
    }
    // No valid session — full navigation to the login page. We replace
    // (not assign) so the back button doesn't bounce the user back into
    // the unauthenticated shell.
    window.location.replace('/login')
    return
  }
  if (!r.ok) return
  let me: Me
  try {
    me = (await r.json()) as Me
  } catch {
    return
  }
  if (me.name && me.name !== cachedName) {
    writeCachedName(me.name)
    userPillName.textContent = me.name
  } else if (!cachedName && me.name) {
    writeCachedName(me.name)
    userPillName.textContent = me.name
  }
  ownerInviteBlock.hidden = !me.is_owner
  paintQuotaChip(me)
}

void bootAuth()
