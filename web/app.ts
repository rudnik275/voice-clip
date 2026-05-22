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
//   - Cost pill: per-user + aggregate, refreshed after every upload.

type HistoryClip = {
  seq: number
  text: string
  source: string
  recordedAt: string
  costUsd: number
  ts: number
}
type HistoryPage = { items: HistoryClip[]; nextSince?: number }
type CostResponse = { user: number; aggregate: number }
type UploadResponse = { text: string; seq: number; recordedAt: string; cost: number }

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const recBtn = $<HTMLButtonElement>('rec')
const recLabel = $<HTMLElement>('rec-label')
const recTime = $<HTMLElement>('rec-time')
const recPause = $<HTMLButtonElement>('rec-pause')
const recPauseLabel = $<HTMLElement>('rec-pause-label')
const statusEl = $<HTMLElement>('status')
const costPill = $<HTMLElement>('cost-pill')
const historyBtn = $<HTMLButtonElement>('history-btn')
const historyModal = $<HTMLElement>('history-modal')
const historyList = $<HTMLElement>('history-list')
const historyClose = $<HTMLButtonElement>('history-close')
const historyBackdrop = $<HTMLElement>('history-backdrop')
const downloadCta = $<HTMLAnchorElement>('download-cta')
const userPill = $<HTMLElement>('user-pill')
const profileModal = $<HTMLElement>('profile-modal')
const profileBackdrop = $<HTMLElement>('profile-backdrop')
const profileClose = $<HTMLButtonElement>('profile-close')
const profileLogout = $<HTMLButtonElement>('profile-logout')
const profileDevices = $<HTMLElement>('profile-devices')
const userPillName = $<HTMLElement>('user-pill-name')

// The shell HTML carries no user-specific text (see
// docs/adr/0001-pwa-boot-architecture.md). On boot we paint the cached
// identity from localStorage immediately, then fetch /me to confirm or
// refresh. The cache key is namespaced so multiple stored values stay
// independent of each other.
const NAME_CACHE_KEY = 'vc:name'

type Me = { id: string; email: string; name: string; picture_url: string | null }

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

// Detect desktop (no coarse pointer = no touch screen) once at load.
// Live re-detection on resize is NOT required — spec says load-time only.
const isDesktop = !window.matchMedia('(pointer: coarse)').matches

let statusTimer: ReturnType<typeof setTimeout> | undefined

function showStatus(msg: string, kind: 'info' | 'error' | 'success' = 'info', preview?: string) {
  statusEl.className = ''
  if (kind === 'error') statusEl.classList.add('error')
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

// ---- cost pill ----

function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`
}

async function refreshCost(): Promise<void> {
  try {
    const r = await fetch('/cost', { credentials: 'include' })
    if (!r.ok) return
    const c = (await r.json()) as CostResponse
    costPill.textContent = `${fmtUsd(c.user)} · Σ ${fmtUsd(c.aggregate)}`
  } catch {
    /* network blip — leave the last good value */
  }
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
  const cost = document.createElement('span')
  cost.className = 'history-cost'
  cost.textContent = fmtUsd(clip.costUsd)
  head.append(time, cost)

  const text = document.createElement('p')
  text.className = 'history-text'
  text.textContent = clip.text || '—'

  const actions = document.createElement('div')
  actions.className = 'history-actions'
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.textContent = 'Copy'
  copyBtn.addEventListener('click', async () => {
    // A plain navigator.clipboard.writeText() only reaches THIS device's
    // clipboard (the tablet/phone doing the tapping) — it never gets to the
    // Mac. The Mac receives clips over the daemon SSE stream, so re-sending
    // a history clip means asking the server to fan it out, exactly like a
    // fresh /upload does. We still write the local clipboard best-effort so
    // copying on the same device keeps working.
    void navigator.clipboard?.writeText(clip.text).catch(() => {})
    copyBtn.disabled = true
    try {
      const r = await fetch('/clip/copy', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seq: clip.seq }),
      })
      if (!r.ok) {
        showStatus('Copy failed', 'error')
        return
      }
      const body = (await r.json()) as { ok: boolean; devices: number }
      if (body.devices > 0) {
        showStatus(body.devices === 1 ? 'Sent to your Mac' : 'Sent to your Macs', 'success')
      } else {
        // No paired Mac — the text is on this device's clipboard only.
        showStatus('Copied — pair a Mac to paste there', 'info')
      }
    } catch {
      showStatus('Copy failed', 'error')
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

async function loadDevices(): Promise<void> {
  profileDevices.innerHTML = ''
  try {
    const r = await fetch('/devices', { credentials: 'include' })
    if (!r.ok) {
      showStatus('Failed to load devices', 'error')
      return
    }
    const list = (await r.json()) as DeviceRow[]
    if (list.length === 0) {
      renderDevicesEmpty()
      return
    }
    for (const d of list) profileDevices.append(renderDevice(d))
  } catch {
    showStatus('Failed to load devices', 'error')
  }
}

function openProfile() {
  profileModal.hidden = false
  void loadDevices()
}
function closeProfile() {
  profileModal.hidden = true
}

userPill.addEventListener('click', openProfile)
profileClose.addEventListener('click', closeProfile)
profileBackdrop.addEventListener('click', closeProfile)
profileLogout.addEventListener('click', async () => {
  if (!confirm('Sign out?')) return
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

// Tap-to-toggle (not push-to-hold) + mid-recording pause. Pause is done by
// disabling the mic track (NOT MediaRecorder.pause()) so the result is one
// continuous, always-valid blob with a silent gap — robust across
// browsers/codecs (esp. iOS mp4, which we just fixed for corruption).
let paused = false
let pausedAt = 0
let pausedTotalMs = 0
let transcribing = false

// Spoken time so far, excluding any paused stretches.
function elapsedMs(): number {
  const base = Date.now() - startedAt - pausedTotalMs
  return paused ? base - (Date.now() - pausedAt) : base
}

const VOICE_ALPHA = 0.16 // smoothing — see CLAUDE.md "Voice reactivity"
let smoothedLevel = 0

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
async function ensureMic(): Promise<MediaStream> {
  const live = micStream?.getAudioTracks().some((t) => t.readyState === 'live')
  if (micStream && live) return micStream
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
  try {
    s = await ensureMic()
  } catch {
    recording = false
    showStatus('Нет доступа к микрофону', 'error')
    return
  }
  // An ultra-fast tap may have already fired stopRecording during the
  // (first-time only) getUserMedia await — abort cleanly.
  if (!recording) return

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
  // timeslice → periodic dataavailable, so audio is never lost even if the
  // final flush at stop() is abrupt.
  mediaRecorder.start(250)

  startMeters(s)
  smoothedLevel = 0
  rafId = requestAnimationFrame(tickVoice)

  recBtn.classList.add('recording')
  recLabel.textContent = 'Recording'
  recTime.textContent = '00:00'
  recPause.classList.remove('is-paused')
  recPauseLabel.textContent = 'Pause'
  recPause.hidden = false
  timeTimer = setInterval(() => {
    recTime.textContent = fmtElapsed(elapsedMs())
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
  } else {
    pausedTotalMs += Date.now() - pausedAt
    recBtn.classList.remove('paused')
    recPause.classList.remove('is-paused')
    recPauseLabel.textContent = 'Pause'
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
    } catch {
      // transport-level failure (tunnel/connection dropped) — retry
      if (n < UPLOAD_MAX_ATTEMPTS) {
        showStatus(`Сеть нестабильна — повтор ${n}/${UPLOAD_MAX_ATTEMPTS - 1}…`, 'info')
        await delay(uploadBackoffMs(n))
        return attempt(n + 1)
      }
      throw new Error('сеть недоступна — запись не отправлена')
    }

    if (r.ok) {
      const body = (await r.json()) as UploadResponse
      void refreshCost()
      showStatus('Transcribed', 'success', body.text)
      return body.text
    }

    // 502/503/504 = transient edge/tunnel flap → retry the same blob
    if ((r.status === 502 || r.status === 503 || r.status === 504) && n < UPLOAD_MAX_ATTEMPTS) {
      showStatus(`Сервер недоступен — повтор ${n}/${UPLOAD_MAX_ATTEMPTS - 1}…`, 'info')
      await delay(uploadBackoffMs(n))
      return attempt(n + 1)
    }

    throw new Error(await failureMessage(r))
  }

  return attempt(1)
}

// Sentinel: nothing meaningful was captured — surfaced as a calm hint, not
// an error, and never sent to the server.
class TooShort extends Error {}

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
  const textPromise = stopped.then((blob) => {
    if (durationMs < MIN_RECORD_MS || blob.size < MIN_RECORD_BYTES) {
      throw new TooShort()
    }
    return uploadAndTranscribe(blob, recordedAt)
  })

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
  } catch (e) {
    if (e instanceof TooShort) {
      showStatus('Слишком коротко — запиши подольше', 'info')
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
// while a transcription is still in flight.
recBtn.addEventListener('click', () => {
  if (transcribing) return
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
recBtn.addEventListener('touchstart', () => {
  if (recording || transcribing) return
  ensureMic().then(() => scheduleMicRelease()).catch(() => {})
}, { passive: true })

recPause.addEventListener('click', () => togglePause())

// ---- boot ----

// Desktop: hide record button, show macOS download CTA instead.
// Touch devices (phones/tablets): record button stays visible, CTA stays hidden.
if (isDesktop) {
  recBtn.hidden = true
  downloadCta.hidden = false
}

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
  // Cost pill is non-critical for the first paint, so we kick it off
  // only after the auth check returned green.
  void refreshCost()
}

void bootAuth()
