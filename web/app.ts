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
const statusEl = $<HTMLElement>('status')
const costPill = $<HTMLElement>('cost-pill')
const historyBtn = $<HTMLButtonElement>('history-btn')
const historyModal = $<HTMLElement>('history-modal')
const historyList = $<HTMLElement>('history-list')
const historyClose = $<HTMLButtonElement>('history-close')
const historyClear = $<HTMLButtonElement>('history-clear')
const historyBackdrop = $<HTMLElement>('history-backdrop')
const downloadCta = $<HTMLAnchorElement>('download-cta')
const userPill = $<HTMLElement>('user-pill')
const profileModal = $<HTMLElement>('profile-modal')
const profileBackdrop = $<HTMLElement>('profile-backdrop')
const profileClose = $<HTMLButtonElement>('profile-close')
const profileLogout = $<HTMLButtonElement>('profile-logout')
const profileDevices = $<HTMLElement>('profile-devices')

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
    try {
      await navigator.clipboard.writeText(clip.text)
      showStatus('Copied', 'success')
    } catch {
      showStatus('Copy failed', 'error')
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
historyClear.addEventListener('click', async () => {
  if (!confirm('Clear all your recordings? Cost totals are kept.')) return
  const r = await fetch('/history', { method: 'DELETE', credentials: 'include' })
  if (r.ok) {
    showStatus('History cleared', 'success')
    void loadHistory(true)
  } else {
    showStatus('Clear failed', 'error')
  }
})

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
    window.location.href = '/'
  }
})

// ---- recording ----

let mediaRecorder: MediaRecorder | undefined
let chunks: Blob[] = []
// The mic stream and AudioContext are acquired ONCE and kept alive for the
// whole page session. Re-running getUserMedia per press cost ~1s of latency
// AND — because teardownAudio() stopped the track right after
// mediaRecorder.stop() — raced the recorder's final flush, so every few
// recordings produced an empty (5-byte) blob → server 502. One persistent
// stream makes start instant and the capture deterministic.
let micStream: MediaStream | undefined
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

// One AudioContext + analyser for the page lifetime; created/resumed inside
// the user gesture (iOS rule). Reused across recordings.
function ensureAudioGraph(s: MediaStream) {
  if (!audioCtx) audioCtx = new AudioContext()
  if (audioCtx.state === 'suspended') void audioCtx.resume()
  if (!micSource) {
    micSource = audioCtx.createMediaStreamSource(s)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 1024
    micSource.connect(analyser)
  }
}

async function startRecording() {
  if (recording) return
  recording = true
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

  ensureAudioGraph(s)
  smoothedLevel = 0
  rafId = requestAnimationFrame(tickVoice)

  recBtn.classList.add('recording')
  recLabel.textContent = 'Recording'
  recTime.textContent = '00:00'
  timeTimer = setInterval(() => {
    recTime.textContent = fmtElapsed(Date.now() - startedAt)
  }, 250)
}

// Stop only the per-recording meters/visualiser. The mic stream AND the
// AudioContext stay alive so the next press is instant and never races the
// recorder's flush (the old teardown stopped the track here → empty blobs).
function stopMeters() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  recBtn.style.setProperty('--voice-level', '0')
  if (timeTimer) clearInterval(timeTimer)
  timeTimer = undefined
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

async function stopRecording() {
  if (!recording) return
  recording = false
  const durationMs = Date.now() - startedAt

  const resetUi = () => {
    recBtn.classList.remove('recording', 'busy')
    recLabel.textContent = 'Hold to talk'
    recTime.textContent = ''
  }

  // Start still in flight (ultra-fast tap) or recorder never armed — nothing
  // was captured; just reset, no server round-trip.
  if (!mediaRecorder || mediaRecorder.state !== 'recording') {
    stopMeters()
    resetUi()
    showStatus('Слишком коротко — удерживай дольше', 'info')
    return
  }

  const recordedAt = new Date(startedAt).toISOString()
  const stopped = new Promise<Blob>((resolve) => {
    mediaRecorder!.onstop = () => {
      const mime = mediaRecorder!.mimeType || recordMime
      resolve(new Blob(chunks, { type: mime }))
    }
  })
  mediaRecorder.stop()

  recBtn.classList.remove('recording')
  recBtn.classList.add('busy')
  recLabel.textContent = ''
  stopMeters()

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
      showStatus('Слишком коротко — удерживай дольше', 'info')
    } else {
      showStatus((e as Error).message || 'Не удалось распознать', 'error')
    }
  } finally {
    recBtn.classList.remove('busy')
    recLabel.textContent = 'Hold to talk'
    recTime.textContent = ''
  }
}

// Press-and-hold (pointer) — tap also works (down then up).
recBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  void startRecording()
})
recBtn.addEventListener('pointerup', (e) => {
  e.preventDefault()
  void stopRecording()
})
recBtn.addEventListener('pointercancel', () => void stopRecording())
recBtn.addEventListener('pointerleave', () => {
  if (recording) void stopRecording()
})

// ---- boot ----

// Desktop: hide record button, show macOS download CTA instead.
// Touch devices (phones/tablets): record button stays visible, CTA stays hidden.
if (isDesktop) {
  recBtn.hidden = true
  downloadCta.hidden = false
}

void refreshCost()
