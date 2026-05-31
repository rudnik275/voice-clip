// ---- core ports: the only seams between the framework-agnostic capture core
//      and the outside world (browser audio APIs, network) ----
//
// The RecorderMachine depends ONLY on these two interfaces plus the pure
// helpers in meters.ts / mime.ts. Anything that touches getUserMedia /
// MediaRecorder / AudioContext lives behind AudioAdapter; anything that talks
// to /upload lives behind Uploader. This is what makes the core unit-testable
// with fakes (see tests/core/*).

/**
 * A finished recording handed off by the AudioAdapter when finalize completes.
 * `blob` is the assembled audio, `mime` its container type, `durationMs` the
 * wall-clock recording time (minus paused spans), and `stats` the metering
 * summary used by the upload gate to reject silent / too-quiet clips.
 */
export type RecordedClip = {
  blob: Blob;
  mime: string;
  durationMs: number;
  stats: ClipStats;
  /** epoch ms when recording started — used for history ordering. */
  recordedAt: number;
  /**
   * Upload source. `online` = recorded just now (server pbcopies + inserts
   * history); `offline` = drained later (history insert only). Defaults to
   * `online` in the uploader when unset.
   */
  source?: 'online' | 'offline';
};

/** Metering summary computed over the whole clip. */
export type ClipStats = {
  /** Average RMS across all analysed frames (0..1). */
  avgRms: number;
  /** Fraction of frames whose RMS crossed the voice threshold (0..1). */
  voiceFraction: number;
  /** Loudest single sample seen (0..1). */
  peakLevel: number;
};

/**
 * AudioAdapter — the audio port.
 *
 * All eight iOS invariants (see PRD #99) live in the single real
 * implementation, BrowserAudioAdapter. The machine only ever calls these
 * methods; it never sees a MediaStream, MediaRecorder, or AudioContext.
 *
 * Lifecycle expected by RecorderMachine:
 *   acquire() -> start() -> [pause()/resume()]* -> finalize() -> closeContext()
 */
export interface AudioAdapter {
  /**
   * Request a FRESH microphone stream (invariant 1: never reuse an old
   * stream/track — iOS hands back a dead track after backgrounding). Resolves
   * once a live track is available; rejects on permission denial / no device.
   */
  acquire(): Promise<void>;

  /**
   * Begin recording. `timesliceMs` is the MediaRecorder timeslice
   * (invariant 5: 250ms so iOS doesn't drop tails on background/abrupt stop).
   */
  start(timesliceMs: number): void;

  /**
   * Pause WITHOUT calling MediaRecorder.pause() (invariant 3): toggles
   * `track.enabled = false`. Buffered chunks are kept; the blob stays valid.
   */
  pause(): void;

  /**
   * Resume after a pause. Implementation calls primeAudioSession() first
   * (invariant 7) then `track.enabled = true`.
   */
  resume(): void;

  /**
   * Stop recording and resolve with the assembled clip. The implementation
   * races the MediaRecorder `onstop` event against an 800ms timeout
   * (invariant 8) so a missing onstop on Safari can't hang finalize forever.
   */
  finalize(): Promise<RecordedClip>;

  /**
   * Flush any buffered chunks immediately (MediaRecorder.requestData) — used
   * when backgrounding so tails aren't lost.
   */
  flush(): void;

  /**
   * Close the AudioContext (invariant 6: iOS limits live contexts and keeps
   * the lock-screen "Now Playing" + mic hold alive; leaking one makes the next
   * getUserMedia silent). Called whenever the machine reaches idle.
   */
  closeContext(): void;

  /**
   * Wake the iOS audio session by playing a 1-sample silent buffer
   * (invariant 7). Called before resume.
   */
  primeAudioSession(): void;

  /**
   * Is the current capture track still live? After backgrounding, iOS may end
   * the track; the machine uses this on FOREGROUNDED to decide
   * recording-vs-finalizing.
   */
  isTrackLive(): boolean;

  /** Current smoothed input level (0..1) for UI metering. */
  level(): number;
}

/** Outcome of an upload attempt. */
export type UploadResult =
  | { ok: true; text: string }
  | {
      ok: false;
      reason: 'rejected' | 'network' | 'server';
      status?: number;
      message?: string;
    };

/**
 * Uploader — the network port. The real implementation (uploader.ts) gates
 * out too-short / too-quiet clips before they hit the wire, then retries with
 * exponential backoff. The /upload contract is unchanged and the client does
 * NOT send presetId.
 */
export interface Uploader {
  upload(clip: RecordedClip): Promise<UploadResult>;
}
