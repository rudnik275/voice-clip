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
  const badge = document.createElement('span')
  badge.className = clip.source === 'offline' ? 'badge offline' : 'badge'
  badge.textContent = clip.source
  head.append(time, badge)

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
  const cost = document.createElement('span')
  cost.className = 'history-cost'
  cost.textContent = fmtUsd(clip.costUsd)
  actions.append(copyBtn, cost)

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

// ---- recording ----

let mediaRecorder: MediaRecorder | undefined
let chunks: Blob[] = []
let stream: MediaStream | undefined
let audioCtx: AudioContext | undefined
let analyser: AnalyserNode | undefined
let rafId = 0
let recording = false
let startedAt = 0
let timeTimer: ReturnType<typeof setInterval> | undefined

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

async function startRecording() {
  if (recording) return
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    showStatus('Microphone access denied', 'error')
    return
  }
  recording = true
  chunks = []
  startedAt = Date.now()
  mediaRecorder = new MediaRecorder(stream)
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  mediaRecorder.start()

  audioCtx = new AudioContext()
  const src = audioCtx.createMediaStreamSource(stream)
  analyser = audioCtx.createAnalyser()
  analyser.fftSize = 1024
  src.connect(analyser)
  smoothedLevel = 0
  rafId = requestAnimationFrame(tickVoice)

  recBtn.classList.add('recording')
  recLabel.textContent = 'Recording'
  recTime.textContent = '00:00'
  timeTimer = setInterval(() => {
    recTime.textContent = fmtElapsed(Date.now() - startedAt)
  }, 250)
}

function teardownAudio() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  recBtn.style.setProperty('--voice-level', '0')
  if (timeTimer) clearInterval(timeTimer)
  if (stream) for (const t of stream.getTracks()) t.stop()
  stream = undefined
  if (audioCtx) void audioCtx.close()
  audioCtx = undefined
  analyser = undefined
}

function uploadAndTranscribe(blob: Blob, recordedAt: string): Promise<string> {
  const fd = new FormData()
  fd.set('audio', blob, 'clip.webm')
  fd.set('recordedAt', recordedAt)
  fd.set('source', 'online')
  return fetch('/upload', { method: 'POST', body: fd, credentials: 'include' }).then(async (r) => {
    if (!r.ok) {
      const msg = await r.text().catch(() => '')
      throw new Error(msg || `upload failed (${r.status})`)
    }
    const body = (await r.json()) as UploadResponse
    void refreshCost()
    showStatus('Transcribed', 'success', body.text)
    return body.text
  })
}

async function stopRecording() {
  if (!recording || !mediaRecorder) return
  recording = false
  const recordedAt = new Date(startedAt).toISOString()

  const stopped = new Promise<Blob>((resolve) => {
    mediaRecorder!.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }))
  })
  mediaRecorder.stop()

  recBtn.classList.remove('recording')
  recBtn.classList.add('busy')
  recLabel.textContent = ''
  teardownAudio()

  // iOS Safari only honours navigator.clipboard.write() synchronously inside
  // the user gesture. Hand it a PENDING ClipboardItem promise NOW so the
  // grant survives the async upload — the promise resolves to the transcript
  // once the round-trip completes.
  const textPromise = stopped.then((blob) => uploadAndTranscribe(blob, recordedAt))

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
    showStatus((e as Error).message || 'Transcription failed', 'error')
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
void refreshCost()
