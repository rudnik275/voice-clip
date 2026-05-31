// ---- pure metering helpers ----
//
// No DOM, no AudioContext: these operate on plain sample buffers (the kind
// AnalyserNode.getByteTimeDomainData / getFloatTimeDomainData fills, or a fake
// in tests). The BrowserAudioAdapter feeds real frames here; tests feed
// synthetic ones.
//
// Thresholds mirror the ones the imperative engine in web/app.ts settled on
// (SILENCE 0.025, VOICE 0.04, fraction 0.08, DEAD_MIC 0.002).

/** RMS below this average over the whole clip ⇒ likely dead/muted mic. */
export const RMS_DEAD_MIC = 0.002;
/** Peak/avg RMS below this ⇒ "too quiet, probably silence". */
export const RMS_SILENCE = 0.025;
/** Per-frame RMS at/above this counts the frame as "voice". */
export const VOICE_RMS_THRESH = 0.04;
/** Fraction of voice frames at/above this counts the clip as speech. */
export const VOICE_FRACTION_MIN = 0.08;
/** Clips shorter than this are accidental taps. */
export const MIN_DURATION_MS = 350;

/**
 * Root-mean-square amplitude of a single frame of normalised samples
 * (each in roughly [-1, 1]). Returns 0 for an empty frame.
 */
export function rms(frame: ArrayLike<number>): number {
  const n = frame.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = frame[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** Peak absolute amplitude of a frame. Returns 0 for an empty frame. */
export function peak(frame: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < frame.length; i++) {
    const a = Math.abs(frame[i]!);
    if (a > p) p = a;
  }
  return p;
}

/**
 * Convert a raw byte time-domain frame (Uint8, centred on 128, as
 * AnalyserNode.getByteTimeDomainData produces) into normalised [-1, 1] floats.
 * Lets the adapter use the cheap byte API while keeping the math pure here.
 */
export function bytesToFloat(bytes: ArrayLike<number>): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = (bytes[i]! - 128) / 128;
  }
  return out;
}

/**
 * Incrementally accumulate frame metering. Construct one Meter per recording,
 * push each analysed frame, then call summary() at finalize.
 */
export class Meter {
  private sumSq = 0;
  private frames = 0;
  private voiceFrames = 0;
  private peakLevel = 0;

  /** Feed one frame of normalised samples. */
  push(frame: ArrayLike<number>): void {
    const r = rms(frame);
    this.sumSq += r * r;
    this.frames += 1;
    if (r >= VOICE_RMS_THRESH) this.voiceFrames += 1;
    const p = peak(frame);
    if (p > this.peakLevel) this.peakLevel = p;
  }

  /** Number of frames pushed so far. */
  get frameCount(): number {
    return this.frames;
  }

  /** Summary stats over all pushed frames. */
  summary(): { avgRms: number; voiceFraction: number; peakLevel: number } {
    const avgRms = this.frames > 0 ? Math.sqrt(this.sumSq / this.frames) : 0;
    const voiceFraction = this.frames > 0 ? this.voiceFrames / this.frames : 0;
    return { avgRms, voiceFraction, peakLevel: this.peakLevel };
  }
}

/**
 * Exponential smoothing for the UI voice-level needle. Alpha 0.16 (~95ms time
 * constant at 60fps) — the value the design system locked in; don't change
 * without a reason (see CLAUDE.md "Voice reactivity").
 */
export const SMOOTHING_ALPHA = 0.16;

/** previous ∈ [0,1], target ∈ [0,1] ⇒ next smoothed level. */
export function smoothLevel(previous: number, target: number, alpha = SMOOTHING_ALPHA): number {
  return previous + (target - previous) * alpha;
}

/** Map a raw frame RMS to a 0..1 UI target (matches web/app.ts `rms * 3.2`). */
export function levelTarget(frameRms: number): number {
  return Math.min(1, frameRms * 3.2);
}

/** True if the clip's average RMS is so low the mic was probably dead. */
export function isDeadMic(avgRms: number): boolean {
  return avgRms < RMS_DEAD_MIC;
}

/**
 * True if the clip is too quiet to be intentional speech. Two complementary
 * signals: peak/avg RMS below the silence floor, OR too few voice-active
 * frames (catches "tap the mic + a second of room ambience").
 */
export function isTooQuiet(stats: { avgRms: number; voiceFraction: number }): boolean {
  return stats.avgRms < RMS_SILENCE || stats.voiceFraction < VOICE_FRACTION_MIN;
}

/** True if the clip is too short to be intentional. */
export function isTooShort(durationMs: number): boolean {
  return durationMs < MIN_DURATION_MS;
}
