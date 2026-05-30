// Synthesized UI sounds — Neo-Brutalism style.
//
// All sounds are generated on-demand via Web Audio API (no .wav/.mp3
// assets, no fetching). Each sound is short (10–250ms), uses square or
// sine waves with hard envelopes — synthetic, mechanical, no reverb.
//
// AudioContext is lazy: the first user gesture creates it; subsequent
// calls reuse the same context. iOS Safari requires the gesture to
// unlock audio.
//
// Mute state is persisted in localStorage as 'voice-clip:sounds' = '0'|'1'
// (default '1' = on). Toggle via `setMuted(true/false)` / read with
// `isMuted()`. When muted, every play function is a no-op.

const STORAGE_KEY = 'voice-clip:sounds'

let _ctx: AudioContext | null = null
function ctx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (isMuted()) return null
  if (!_ctx) {
    const C = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
    if (!C) return null
    _ctx = new C()
  }
  if (_ctx.state === 'suspended') void _ctx.resume()
  return _ctx
}

export function isMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '0'
  } catch {
    return false
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, muted ? '0' : '1')
  } catch {
    /* ignore */
  }
}

// Assert the iOS AVAudioSession category to play-and-record BEFORE any
// AudioContext or getUserMedia negotiates the session. Calling this from
// unlockAudio() (which fires on the first touchstart/pointerdown on the
// rec button) means the hint lands before EITHER the sounds.ts context or
// the app.ts meter context is first created, so iOS has no reason to emit
// a session-route-change click.
//
// Must also be called after every background/foreground round-trip:
// iOS resets the audio session category when the PWA is backgrounded,
// so re-asserting on visibilitychange and pageshow prevents the click
// that would otherwise fire at the start of the next recording.
//
// Feature-detected (audioSession is iOS 16.4+ only). No-op elsewhere.
export function primeAudioSession(): void {
  if (typeof navigator === 'undefined') return
  const nav = navigator as unknown as { audioSession?: { type: string } }
  if (nav.audioSession) nav.audioSession.type = 'play-and-record'
}

// Eagerly create + resume the AudioContext from a user-gesture callback
// (touchstart on the rec button, etc.) so the FIRST playStartRec() inside
// the subsequent click handler isn't silent because iOS hadn't unlocked
// audio yet. Safe to call repeatedly — no-op once the context is running.
// Also re-resumes a context that iOS suspended while the page was hidden.
export function unlockAudio(): void {
  if (typeof window === 'undefined') return
  // Re-assert the audio session category first — before creating or resuming
  // any AudioContext — so iOS won't switch categories and emit a click.
  primeAudioSession()
  if (isMuted()) return
  if (!_ctx) {
    const C =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!C) return
    _ctx = new C()
  }
  if (_ctx.state === 'suspended') void _ctx.resume()
}

// Short filtered-noise burst — physical "click" component.
function noise(durationS: number, peak: number, highpass: number): void {
  const c = ctx()
  if (!c) return
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * durationS), c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const src = c.createBufferSource()
  src.buffer = buf
  const filter = c.createBiquadFilter()
  filter.type = 'highpass'
  filter.frequency.value = highpass
  const gain = c.createGain()
  const t = c.currentTime
  gain.gain.setValueAtTime(0, t)
  gain.gain.linearRampToValueAtTime(peak, t + 0.001)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + durationS)
  src.connect(filter)
  filter.connect(gain)
  gain.connect(c.destination)
  src.start()
  src.stop(c.currentTime + durationS + 0.01)
}

// Pitched tone with hard ADSR.
function tone(
  freq: number,
  type: OscillatorType,
  attack: number,
  sustain: number,
  release: number,
  peak: number,
  startDelay = 0,
): void {
  const c = ctx()
  if (!c) return
  const osc = c.createOscillator()
  osc.type = type
  osc.frequency.value = freq
  const g = c.createGain()
  const t0 = c.currentTime + startDelay
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(peak, t0 + attack)
  g.gain.setValueAtTime(peak, t0 + attack + sustain)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + sustain + release)
  osc.connect(g)
  g.connect(c.destination)
  osc.start(t0)
  osc.stop(t0 + attack + sustain + release + 0.02)
}

// === Public sounds ===

// Single tick — used on Pause button AND on stop-of-recording (same
// metaphor: a hard "this stops" snap).
export function playPause(): void {
  noise(0.005, 0.30, 4000)
  tone(1500, 'sine', 0.001, 0.005, 0.018, 0.18)
}

// Double tick at slightly different pitch — used on Resume button AND
// on start-of-recording (metaphor: "play").
export function playResume(): void {
  playPause()
  setTimeout(() => {
    noise(0.005, 0.30, 4000)
    tone(1900, 'sine', 0.001, 0.005, 0.018, 0.18)
  }, 80)
}

// Start of recording shares Resume's double tick.
export function playStartRec(): void {
  playResume()
}

// Stop of recording — short tick + brighter sine, distinct from Pause so
// "stop recording" and "pause during recording" are audibly different.
export function playStopRec(): void {
  noise(0.012, 0.45, 2500)
  tone(550, 'sine', 0.001, 0.008, 0.035, 0.20)
}

// "Done" pop pair — same 800 → 500 Hz as playCopy. Transcription landing
// in the clipboard IS a copy event from the user's POV, so the two events
// share the sound. Picked over the original mini-bell on user feedback
// (the bell felt too "notification-y" after every clip).
export function playSuccess(): void {
  playCopy()
}

// Big red button slam — low square wave + noise burst. Used to be the
// start-of-record sound; its blunt, "wrong"-sounding character makes it
// a better error cue, so it's been moved here.
export function playError(): void {
  const c = ctx()
  if (!c) return
  noise(0.015, 0.6, 2000)
  const osc = c.createOscillator()
  osc.type = 'square'
  osc.frequency.setValueAtTime(90, c.currentTime)
  osc.frequency.exponentialRampToValueAtTime(48, c.currentTime + 0.06)
  const g = c.createGain()
  const t = c.currentTime
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(0.35, t + 0.002)
  g.gain.setValueAtTime(0.35, t + 0.022)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07)
  osc.connect(g)
  g.connect(c.destination)
  osc.start()
  osc.stop(c.currentTime + 0.09)
}

// Short pop pair — used on successful clipboard copy from history.
export function playCopy(): void {
  noise(0.008, 0.35, 3000)
  tone(800, 'sine', 0.001, 0.01, 0.03, 0.16, 0)
  tone(500, 'sine', 0.001, 0.01, 0.03, 0.14, 0.04)
}

// Swoosh tick — modal open/close.
export function playModal(): void {
  const c = ctx()
  if (!c) return
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * 0.18), c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length)
  const src = c.createBufferSource()
  src.buffer = buf
  const filter = c.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.setValueAtTime(2000, c.currentTime)
  filter.frequency.exponentialRampToValueAtTime(400, c.currentTime + 0.15)
  filter.Q.value = 4
  const g = c.createGain()
  const t = c.currentTime
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(0.22, t + 0.005)
  g.gain.setValueAtTime(0.22, t + 0.035)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
  src.connect(filter)
  filter.connect(g)
  g.connect(c.destination)
  src.start()
  src.stop(c.currentTime + 0.2)
  tone(2200, 'sine', 0.001, 0.005, 0.015, 0.12, 0.12)
}
