// === DOM refs ===
declare global {
  interface Window {
    __voiceClipReady?: boolean
  }
}

const recBtn = document.getElementById('rec') as HTMLButtonElement
const recLabel = document.getElementById('rec-label') as HTMLElement
const recTime = document.getElementById('rec-time') as HTMLElement
const result = document.getElementById('result') as HTMLElement
const textArea = document.getElementById('text') as HTMLTextAreaElement
const copyBtn = document.getElementById('copy') as HTMLButtonElement
const statusEl = document.getElementById('status') as HTMLElement
const totalPill = document.getElementById('total-pill') as HTMLElement
const costLine = document.getElementById('cost-line') as HTMLElement
const historyBtn = document.getElementById('history-btn') as HTMLButtonElement
const historyBadge = document.getElementById('history-badge') as HTMLElement
const historyModal = document.getElementById('history-modal') as HTMLElement
const historyClose = document.getElementById('history-close') as HTMLButtonElement
const historyList = document.getElementById('history-list') as HTMLElement
const historyEmpty = document.getElementById('history-empty') as HTMLElement
const markAllReadBtn = document.getElementById('mark-all-read') as HTMLButtonElement
const offlinePill = document.getElementById('offline-pill') as HTMLElement
const userPill = document.getElementById('user-pill') as HTMLButtonElement
const userName = document.getElementById('user-name') as HTMLElement
const userMenu = document.getElementById('user-menu') as HTMLElement
const userMenuName = document.getElementById('user-menu-name') as HTMLElement
const userMenuClose = document.getElementById('user-menu-close') as HTMLButtonElement
const logoutBtn = document.getElementById('logout-btn') as HTMLButtonElement
const installDaemonBtn = document.getElementById('install-daemon-btn') as HTMLButtonElement

// === Types ===
interface HistoryItem {
  id: string
  ts: string
  recordedAt?: string
  text: string
  costUsd?: number
  source: 'online' | 'offline'
  readAt?: string
}

interface PendingItem {
  localId: string
  blob: Blob
  mime: string
  recordedAt: string
  durationSec?: number
}

interface UploadResponse {
  id?: string
  text?: string
  costUsd?: number
  totalUsd?: number
  totalRequests?: number
  source?: string
  error?: string
}

// === Recording state ===
let mediaRecorder: MediaRecorder | null = null
let chunks: Blob[] = []
let stream: MediaStream | null = null
let timerInterval: number | null = null
let startedAt = 0
let isRecording = false

let audioCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let analyserData: Uint8Array<ArrayBuffer> | null = null
let rafId: number | null = null
let smoothedLevel = 0
let maxObservedLevel = 0
let analyserAvailable = false

// Below this smoothed level the recording is treated as silence and the upload
// is skipped — Whisper/gpt-4o-transcribe hallucinates fake text on silent input.
const SILENCE_THRESHOLD = 0.04

let pendingResolve: ((b: Blob) => void) | null = null
let pendingReject: ((e: unknown) => void) | null = null

// Captured at the moment user taps Stop, so handleStop's offline path can persist it.
let lastDurationSec = 0

// === Drain state ===
let isDraining = false
let drainTimer: number | null = null

// === Reachability tracking ===
let isReachable = true
let heartbeatTimer: number | null = null

function setReachable(reachable: boolean): void {
  if (reachable === isReachable) return
  isReachable = reachable
  offlinePill.hidden = reachable
  if (reachable) {
    // Just came back online — drain queue and refresh views.
    void scheduleDrain(300)
    void refreshHistory()
  }
}

function scheduleHeartbeat(delayMs: number): void {
  if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
  heartbeatTimer = window.setTimeout(() => {
    void heartbeat()
  }, delayMs)
}

async function heartbeat(): Promise<void> {
  try {
    const r = await fetch('/cost', { cache: 'no-store' })
    if (r.ok) {
      const data = (await r.json()) as { totalUsd: number; totalRequests: number }
      updateTotalPill(data.totalUsd, data.totalRequests)
      setReachable(true)
    } else {
      setReachable(false)
    }
  } catch {
    setReachable(false)
  } finally {
    // Heartbeat cadence: faster while offline (so we notice recovery quickly),
    // calmer while everything's fine.
    scheduleHeartbeat(isReachable ? 30_000 : 8_000)
  }
}

// === In-memory caches ===
let history: HistoryItem[] = []
let pendingItems: PendingItem[] = []

// === IndexedDB queue ===
const DB_NAME = 'voice-clip'
const DB_VERSION = 1
const STORE = 'queue'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'localId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function queueAdd(item: PendingItem): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(STORE).put(item)
  })
  db.close()
}

async function queueRemove(localId: string): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.objectStore(STORE).delete(localId)
  })
  db.close()
}

async function queueList(): Promise<PendingItem[]> {
  const db = await openDB()
  const items = await new Promise<PendingItem[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve((req.result as PendingItem[]) ?? [])
    req.onerror = () => reject(req.error)
  })
  db.close()
  return items
}

// === Helpers ===
function setStatus(msg: string, kind: 'idle' | 'error' | 'success' = 'idle'): void {
  statusEl.textContent = msg
  statusEl.classList.toggle('error', kind === 'error')
  statusEl.classList.toggle('success', kind === 'success')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function updateTime(): void {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000)
  recTime.textContent = `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)}`
}

function pickMime(): string {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

function extFor(mime: string): string {
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a'
  if (mime.includes('webm')) return '.webm'
  if (mime.includes('ogg')) return '.ogg'
  return '.bin'
}

function fmtUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(5)}`
  if (n < 1) return `$${n.toFixed(4)}`
  return `$${n.toFixed(3)}`
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return ''
  const total = Math.round(sec)
  return `${Math.floor(total / 60)}:${pad(total % 60)}`
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const dDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const nowDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (dDate === nowDate) return `сегодня ${time}`
  const yest = new Date(now)
  yest.setDate(yest.getDate() - 1)
  const yestDate = `${yest.getFullYear()}-${pad(yest.getMonth() + 1)}-${pad(yest.getDate())}`
  if (dDate === yestDate) return `вчера ${time}`
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${time}`
}

function localId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// === Sound effects (Web Audio synth) ===
let fxCtx: AudioContext | null = null

function getFxCtx(): AudioContext | null {
  try {
    if (!fxCtx) {
      const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
      fxCtx = new Ctor()
    }
    if (fxCtx.state === 'suspended') void fxCtx.resume()
    return fxCtx
  } catch {
    return null
  }
}

interface ToneSpec {
  freq: number
  start: number    // seconds from now
  duration: number // seconds
  type?: OscillatorType
  volume?: number  // 0..1
}

async function playTones(notes: ToneSpec[]): Promise<void> {
  const ctx = getFxCtx()
  if (!ctx) return
  // iOS Safari suspends AudioContext after long awaits — defensively wake it up.
  if (ctx.state === 'suspended') {
    try { await ctx.resume() } catch { /* may fail outside user gesture */ }
  }
  const now = ctx.currentTime
  const master = ctx.createGain()
  master.gain.value = 0.18
  master.connect(ctx.destination)
  for (const n of notes) {
    const osc = ctx.createOscillator()
    osc.type = n.type ?? 'triangle'
    osc.frequency.value = n.freq
    const gain = ctx.createGain()
    const t0 = now + n.start
    const tEnd = t0 + n.duration
    const vol = n.volume ?? 0.6
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, tEnd)
    osc.connect(gain).connect(master)
    osc.start(t0)
    osc.stop(tEnd + 0.05)
  }
}

// Keeps the AudioContext "running" by scheduling an inaudible sustained tone.
// Used to bridge the Stop → transcription-done gap so sfxDone() can play
// without the OS suspending the context mid-await.
function keepFxAlive(seconds: number): void {
  const ctx = getFxCtx()
  if (!ctx) return
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  gain.gain.value = 0.00001
  osc.frequency.value = 50
  osc.type = 'sine'
  osc.connect(gain).connect(ctx.destination)
  const now = ctx.currentTime
  osc.start(now)
  osc.stop(now + seconds)
}

function sfxStart(): void {
  // Ascending soft pair: D5 → A5 (perfect fifth, "we're going")
  void playTones([
    { freq: 587.33, start: 0,    duration: 0.10, volume: 0.55 },
    { freq: 880.00, start: 0.06, duration: 0.16, volume: 0.55 },
  ])
}

function sfxStop(): void {
  // Single short E5 tap ("captured")
  void playTones([
    { freq: 659.25, start: 0, duration: 0.18, volume: 0.50 },
  ])
}

function sfxDone(): void {
  // Major-arpeggio reward: E5 → A5 → E6 ("ready")
  void playTones([
    { freq: 659.25, start: 0,    duration: 0.10, volume: 0.42 },
    { freq: 880.00, start: 0.08, duration: 0.10, volume: 0.42 },
    { freq: 1318.5, start: 0.16, duration: 0.22, volume: 0.42 },
  ])
}

// === Audio reactivity (blob morph) ===
function pulseLoop(t: number): void {
  if (!analyser || !analyserData) return
  analyser.getByteTimeDomainData(analyserData)
  let sum = 0
  for (let i = 0; i < analyserData.length; i++) {
    const v = (analyserData[i] ?? 128) - 128
    sum += v * v
  }
  const rms = Math.sqrt(sum / analyserData.length) / 128
  const target = Math.min(1, rms * 5)
  smoothedLevel += (target - smoothedLevel) * 0.16
  if (smoothedLevel > maxObservedLevel) maxObservedLevel = smoothedLevel
  recBtn.style.setProperty('--voice-level', smoothedLevel.toFixed(3))

  const k = smoothedLevel * 18
  const a = 50 + k * Math.sin(t * 0.0060)
  const b = 50 - k * Math.sin(t * 0.0070)
  const c = 50 + k * Math.sin(t * 0.0050)
  const d = 50 - k * Math.sin(t * 0.0045)
  const e = 50 + k * Math.sin(t * 0.0058)
  const f = 50 - k * Math.sin(t * 0.0049)
  const g = 50 + k * Math.sin(t * 0.0042)
  const h = 50 - k * Math.sin(t * 0.0061)
  recBtn.style.borderRadius = `${a}% ${b}% ${c}% ${d}% / ${e}% ${f}% ${g}% ${h}%`

  rafId = requestAnimationFrame(pulseLoop)
}

// === Upload + queue ===
async function uploadAudio(blob: Blob, mime: string, recordedAt: string, source: 'online' | 'offline'): Promise<UploadResponse> {
  const fd = new FormData()
  fd.append('audio', blob, `voice${extFor(mime)}`)
  fd.append('recordedAt', recordedAt)
  fd.append('source', source)
  try {
    const r = await fetch('/upload', { method: 'POST', body: fd })
    if (!r.ok) {
      // Server reached but failed → still online from network's perspective; bubble error.
      setReachable(true)
      const errText = await r.text().catch(() => `HTTP ${r.status}`)
      throw new Error(errText || `HTTP ${r.status}`)
    }
    setReachable(true)
    return (await r.json()) as UploadResponse
  } catch (err) {
    // TypeError from fetch == network failure
    if (err instanceof TypeError) setReachable(false)
    throw err
  }
}

function scheduleDrain(delayMs: number): void {
  if (drainTimer !== null) {
    clearTimeout(drainTimer)
    drainTimer = null
  }
  drainTimer = window.setTimeout(() => {
    void drain()
  }, delayMs)
}

async function drain(): Promise<void> {
  if (isDraining) return
  isDraining = true
  try {
    const items = await queueList()
    if (items.length === 0) return
    let drained = 0
    for (const item of items) {
      try {
        await uploadAudio(item.blob, item.mime, item.recordedAt, 'offline')
        await queueRemove(item.localId)
        drained++
      } catch {
        // server still unreachable — try again later
        scheduleDrain(60_000)
        break
      }
    }
    if (drained > 0) {
      setStatus(`Синхронизировано: ${drained}`, 'success')
      void refreshTotal()
      void refreshHistory()
    }
  } finally {
    isDraining = false
  }
}

// === Recording flow ===
async function startRecording(): Promise<void> {
  if (isRecording) return
  setStatus('')
  result.hidden = true
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    setStatus('Не дали доступ к микрофону', 'error')
    return
  }

  const mime = pickMime()
  mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
  chunks = []
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  mediaRecorder.onstop = () => void handleStop()
  mediaRecorder.start()
  sfxStart()

  try {
    const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
    audioCtx = new Ctor()
    const src = audioCtx.createMediaStreamSource(stream)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.85
    analyserData = new Uint8Array(new ArrayBuffer(analyser.fftSize))
    src.connect(analyser)
    smoothedLevel = 0
    maxObservedLevel = 0
    analyserAvailable = true
    rafId = requestAnimationFrame(pulseLoop)
  } catch {
    // pulsation is decorative — recording still works without it
    analyserAvailable = false
  }

  isRecording = true
  recBtn.classList.add('recording')
  recLabel.textContent = 'Stop'
  recBtn.setAttribute('aria-label', 'Stop recording')
  startedAt = Date.now()
  updateTime()
  timerInterval = window.setInterval(updateTime, 1000)
}

function stopRecording(): void {
  if (!isRecording || !mediaRecorder) return
  lastDurationSec = startedAt > 0 ? (Date.now() - startedAt) / 1000 : 0
  sfxStop()
  // Keep AudioContext warm across the transcription await so sfxDone() can fire.
  keepFxAlive(20)
  const textPromise = new Promise<Blob>((resolve, reject) => {
    pendingResolve = resolve
    pendingReject = reject
  })
  try {
    const item = new ClipboardItem({ 'text/plain': textPromise })
    navigator.clipboard.write([item]).catch(() => {})
  } catch {
    // ClipboardItem unsupported — fall back to manual Copy button
  }
  mediaRecorder.stop()
}

function teardownAudio(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  if (analyser) {
    try { analyser.disconnect() } catch {}
    analyser = null
  }
  analyserData = null
  if (audioCtx) {
    void audioCtx.close().catch(() => {})
    audioCtx = null
  }
  smoothedLevel = 0
  recBtn.style.setProperty('--voice-level', '0')
  recBtn.style.borderRadius = ''
}

async function handleStop(): Promise<void> {
  isRecording = false
  recBtn.classList.remove('recording')
  recBtn.classList.add('busy')
  recBtn.setAttribute('aria-label', 'Processing')
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop())
    stream = null
  }
  teardownAudio()

  const mime = mediaRecorder?.mimeType || 'audio/webm'
  const blob = new Blob(chunks, { type: mime })
  const recordedAt = new Date().toISOString()

  // Silence guard: if the analyser was active and the loudest moment of the
  // recording stayed below the threshold, skip the upload. Whisper hallucinates
  // plausible-but-fake transcripts on silent input — and we'd pay for it too.
  if (analyserAvailable && maxObservedLevel < SILENCE_THRESHOLD) {
    setStatus('Тишина — записывать нечего', 'error')
    pendingReject?.(new Error('silence'))
    pendingResolve = null
    pendingReject = null
    recBtn.classList.remove('busy')
    recLabel.textContent = 'Record'
    recBtn.setAttribute('aria-label', 'Record')
    recTime.textContent = '00:00'
    return
  }

  setStatus('Транскрибируем…')

  try {
    const data = await uploadAudio(blob, mime, recordedAt, 'online')
    const text = (data.text ?? '').trim()
    if (!text) {
      setStatus('Пустая транскрипция', 'error')
      pendingReject?.(new Error('empty'))
    } else {
      textArea.value = text
      result.hidden = false
      textArea.focus()
      textArea.select()
      setStatus('Готово — скопировано в буфер', 'success')
      pendingResolve?.(new Blob([text], { type: 'text/plain' }))
      sfxDone()
    }
    if (typeof data.costUsd === 'number') {
      costLine.textContent = `${fmtUsd(data.costUsd)} · this request`
    } else {
      costLine.textContent = ''
    }
    if (typeof data.totalUsd === 'number' && typeof data.totalRequests === 'number') {
      updateTotalPill(data.totalUsd, data.totalRequests)
    }
    void refreshHistory()
    void scheduleDrain(0)
  } catch (err) {
    // Server unreachable → save offline
    const id = localId()
    try {
      await queueAdd({ localId: id, blob, mime, recordedAt, durationSec: lastDurationSec })
      setStatus('Сохранено офлайн — транскрибируем как только Mac окажется в сети', 'idle')
      pendingItems = await queueList().catch(() => pendingItems)
      renderHistory()
      updateHistoryBadge()
    } catch {
      setStatus(`Ошибка: ${(err as Error).message}`, 'error')
    }
    pendingReject?.(err)
    scheduleDrain(20_000)
  } finally {
    pendingResolve = null
    pendingReject = null
    recBtn.classList.remove('busy')
    recLabel.textContent = 'Record'
    recBtn.setAttribute('aria-label', 'Record')
    recTime.textContent = '00:00'
  }
}

// === History ===
async function refreshHistory(): Promise<void> {
  try {
    const r = await fetch('/history', { cache: 'no-store' })
    if (r.ok) {
      const list = (await r.json()) as HistoryItem[]
      history = list.slice().sort((a, b) => (b.recordedAt ?? b.ts).localeCompare(a.recordedAt ?? a.ts))
      setReachable(true)
    }
  } catch (err) {
    if (err instanceof TypeError) setReachable(false)
    // keep current cache
  }
  pendingItems = await queueList().catch(() => pendingItems)
  renderHistory()
  updateHistoryBadge()
}

function updateHistoryBadge(): void {
  const unread = history.filter((h) => !h.readAt).length + pendingItems.length
  if (unread > 0) {
    historyBadge.hidden = false
    historyBadge.textContent = String(unread)
  } else {
    historyBadge.hidden = true
  }
}

function renderHistory(): void {
  historyList.innerHTML = ''

  if (history.length === 0 && pendingItems.length === 0) {
    historyEmpty.hidden = false
    return
  }
  historyEmpty.hidden = true

  // pending first (newest first by recordedAt)
  const pendingsSorted = [...pendingItems].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
  for (const p of pendingsSorted) {
    const el = document.createElement('div')
    el.className = 'history-item unread'
    const head = document.createElement('div')
    head.className = 'history-item-head'
    const time = document.createElement('span')
    time.className = 'history-time'
    time.textContent = fmtTime(p.recordedAt)
    const badge = document.createElement('span')
    badge.className = 'badge pending'
    badge.textContent = 'PENDING'
    head.append(time, badge)
    if (typeof p.durationSec === 'number') {
      const dur = document.createElement('span')
      dur.className = 'history-cost'
      dur.textContent = fmtDuration(p.durationSec)
      if (dur.textContent) head.appendChild(dur)
    }
    const body = document.createElement('p')
    body.className = 'history-pending'
    body.textContent = '— ожидает синхронизации —'
    const actions = document.createElement('div')
    actions.className = 'history-actions'
    const delBtn = document.createElement('button')
    delBtn.className = 'danger'
    delBtn.type = 'button'
    delBtn.textContent = 'Удалить'
    delBtn.addEventListener('click', async () => {
      await queueRemove(p.localId)
      pendingItems = pendingItems.filter((x) => x.localId !== p.localId)
      renderHistory()
      updateHistoryBadge()
    })
    actions.appendChild(delBtn)
    el.append(head, body, actions)
    historyList.appendChild(el)
  }

  // server items (already sorted)
  for (const h of history) {
    const el = document.createElement('div')
    el.className = 'history-item ' + (h.readAt ? 'read' : 'unread')

    const head = document.createElement('div')
    head.className = 'history-item-head'
    const time = document.createElement('span')
    time.className = 'history-time'
    time.textContent = fmtTime(h.recordedAt ?? h.ts)
    head.appendChild(time)
    if (h.source === 'offline') {
      const offlineBadge = document.createElement('span')
      offlineBadge.className = 'badge offline'
      offlineBadge.textContent = 'OFFLINE'
      head.appendChild(offlineBadge)
    }
    if (typeof h.costUsd === 'number') {
      const cost = document.createElement('span')
      cost.className = 'history-cost'
      cost.textContent = fmtUsd(h.costUsd)
      head.appendChild(cost)
    }

    const body = document.createElement('p')
    body.className = 'history-text'
    body.textContent = h.text

    const actions = document.createElement('div')
    actions.className = 'history-actions'

    const copyItemBtn = document.createElement('button')
    copyItemBtn.type = 'button'
    copyItemBtn.textContent = 'Копировать'
    copyItemBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(h.text)
        setStatus('Скопировано', 'success')
      } catch {
        // best effort
      }
    })
    actions.appendChild(copyItemBtn)

    if (!h.readAt) {
      const readBtn = document.createElement('button')
      readBtn.type = 'button'
      readBtn.textContent = 'Прочитано'
      readBtn.addEventListener('click', async () => {
        await fetch(`/history/${encodeURIComponent(h.id)}/read`, { method: 'POST' }).catch(() => {})
        h.readAt = new Date().toISOString()
        el.classList.remove('unread')
        el.classList.add('read')
        readBtn.remove()
        updateHistoryBadge()
      })
      actions.appendChild(readBtn)
    }

    el.append(head, body, actions)
    historyList.appendChild(el)
  }
}

// === Modal ===
function openHistory(): void {
  historyModal.hidden = false
  historyModal.setAttribute('aria-hidden', 'false')
  void refreshHistory()
}

function closeHistory(): void {
  historyModal.hidden = true
  historyModal.setAttribute('aria-hidden', 'true')
}

historyBtn.addEventListener('click', openHistory)
historyClose.addEventListener('click', closeHistory)
const backdrop = historyModal.querySelector('.history-backdrop')
if (backdrop) backdrop.addEventListener('click', closeHistory)
markAllReadBtn.addEventListener('click', async () => {
  await fetch('/history/read-all', { method: 'POST' }).catch(() => {})
  const now = new Date().toISOString()
  for (const h of history) {
    if (!h.readAt) h.readAt = now
  }
  renderHistory()
  updateHistoryBadge()
})

// === Total cost pill ===
function updateTotalPill(usd: number, count: number): void {
  totalPill.textContent = `${fmtUsd(usd)} · ${count}`
  totalPill.title = `Total spent: ${fmtUsd(usd)} across ${count} request(s)`
}

async function refreshTotal(): Promise<void> {
  try {
    const r = await fetch('/cost', { cache: 'no-store' })
    if (!r.ok) return
    const data = (await r.json()) as { totalUsd: number; totalRequests: number }
    updateTotalPill(data.totalUsd, data.totalRequests)
    setReachable(true)
  } catch (err) {
    if (err instanceof TypeError) setReachable(false)
  }
}

// === Wire up ===
recBtn.addEventListener('click', () => {
  if (isRecording) stopRecording()
  else void startRecording()
})

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(textArea.value)
    copyBtn.classList.add('copied')
    copyBtn.textContent = 'Copied'
    setStatus('Скопировано', 'success')
    setTimeout(() => {
      copyBtn.classList.remove('copied')
      copyBtn.textContent = 'Copy'
    }, 1400)
  } catch {
    textArea.focus()
    textArea.select()
    setStatus('Скопируй вручную (Cmd/Ctrl+C)', 'error')
  }
})

window.addEventListener('online', () => {
  scheduleHeartbeat(0)
})

window.addEventListener('offline', () => {
  setReachable(false)
})

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleHeartbeat(0)
})

// === Service Worker registration ===
if ('serviceWorker' in navigator) {
  // Auto-reload when a NEW SW takes control (after an update). Skip the very
  // first install (controller goes from null → set), only reload when an
  // already-running PWA gets superseded by a fresh SW.
  const hadController = !!navigator.serviceWorker.controller
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloading) {
      reloading = true
      location.reload()
    }
  })

  navigator.serviceWorker
    .register('/sw.js')
    .then(async (registration) => {
      try {
        await navigator.serviceWorker.ready

        // Tell the SW about Bun's hashed asset URLs we just loaded so it can
        // cache them — they were fetched before the SW activated and therefore
        // missed runtime caching.
        const assets: string[] = []
        document.querySelectorAll('script[src]').forEach((s) => {
          const src = (s as HTMLScriptElement).src
          if (src) assets.push(new URL(src, location.href).pathname)
        })
        document.querySelectorAll('link[rel="stylesheet"], link[rel="manifest"]').forEach((l) => {
          const href = (l as HTMLLinkElement).href
          if (href) assets.push(new URL(href, location.href).pathname)
        })
        const send = (): void => {
          navigator.serviceWorker.controller?.postMessage({ type: 'precache', assets })
        }
        if (navigator.serviceWorker.controller) {
          send()
        } else {
          navigator.serviceWorker.addEventListener('controllerchange', send, { once: true })
        }
      } catch {
        // best effort — if precache messaging fails, runtime caching still works
      }

      // Periodic update probe so already-running PWAs pick up new builds
      // without requiring a manual close+reopen. registration.update() is
      // browser-rate-limited; calling more often is harmless.
      const checkForUpdate = (): void => {
        void registration.update().catch(() => {})
      }
      window.setInterval(checkForUpdate, 30 * 60_000)
      window.addEventListener('online', checkForUpdate)
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) checkForUpdate()
      })
    })
    .catch((err) => {
      console.warn('SW register failed:', err)
    })
}

// === Account / session ===
interface MeResponse {
  id: string
  name: string
  daemonToken: string
}
let me: MeResponse | null = null

async function fetchMe(): Promise<MeResponse | null> {
  const r = await fetch('/me', { cache: 'no-store' })
  if (r.status === 401) return null
  if (!r.ok) return null
  return (await r.json()) as MeResponse
}

function openUserMenu(): void {
  if (!me) return
  userMenuName.textContent = me.name
  userMenu.hidden = false
  userMenu.setAttribute('aria-hidden', 'false')
}

function closeUserMenu(): void {
  userMenu.hidden = true
  userMenu.setAttribute('aria-hidden', 'true')
}

userPill.addEventListener('click', openUserMenu)
userMenuClose.addEventListener('click', closeUserMenu)
const userBackdrop = userMenu.querySelector('.user-menu-backdrop')
if (userBackdrop) userBackdrop.addEventListener('click', closeUserMenu)

logoutBtn.addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' }).catch(() => {})
  // After the cookie is cleared, route the user to the access-needed page.
  // Don't redirect to '/' — they'd just bounce back to /signup-needed.
  location.replace('/signup-needed')
})

installDaemonBtn.addEventListener('click', async () => {
  if (!me) return
  // Phase 1: surface the curl command. Phase 2 will add the real /install endpoint.
  const cmd = `curl -fsSL "${location.origin}/install/voice-clip-daemon?token=${encodeURIComponent(me.daemonToken)}" | bash`
  try {
    await navigator.clipboard.writeText(cmd)
    setStatus('Команда скопирована — вставь в Terminal на Маке', 'success')
  } catch {
    // Best-effort: show in status, user can copy by hand.
    setStatus(cmd, 'idle')
  }
  closeUserMenu()
})

// === Init ===
async function init(): Promise<void> {
  me = await fetchMe()
  if (!me) {
    location.replace('/signup-needed')
    return
  }
  userName.textContent = me.name
  userPill.hidden = false

  void refreshTotal()
  void refreshHistory()
  void scheduleDrain(1000)
  scheduleHeartbeat(30_000)

  // Signal to the offline-redirect guard in index.html that the bundled app loaded.
  window.__voiceClipReady = true
}

void init()
