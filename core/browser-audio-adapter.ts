// ---- BrowserAudioAdapter: the ONE place iOS quirks live ----
//
// This is the single real implementation of the AudioAdapter port. It is the
// ONLY file in core/ that touches getUserMedia / MediaRecorder / AudioContext,
// and it is where all eight iOS invariants from PRD #99 are enforced. The
// RecorderMachine drives this adapter through the port and never sees a
// MediaStream / MediaRecorder / AudioContext.
//
// The eight invariants and where each lives below:
//   1. fresh getUserMedia per recording       → acquire()
//   2. autoGainControl: false                  → acquire() constraints
//   3. pause via track.enabled (not pause())   → pause() / resume()
//   4. mime via isTypeSupported                → acquire() (pickRecorderMime)
//   5. MediaRecorder.start(250) timeslice      → start()
//   6. close AudioContext at idle              → closeContext()
//   7. primeAudioSession() before resume       → primeAudioSession()
//   8. finalize: onstop vs 800ms race          → finalize()
//
// This file is typechecked under core/tsconfig.json (DOM lib). It is excluded
// from the DOM-less root tsconfig; the pure core files (ports/meters/mime/
// uploader/recorder-machine) carry no DOM dependency and stay testable in Bun.

import type { AudioAdapter, RecordedClip } from './ports';
import { pickRecorderMime } from './mime';
import { Meter, bytesToFloat, rms, levelTarget, smoothLevel } from './meters';

/** invariant 8: how long to wait for onstop before forcing finalize. */
const FINALIZE_TIMEOUT_MS = 800;
/** invariant 5: MediaRecorder timeslice. */
const TIMESLICE_MS = 250;

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error('AudioContext unsupported');
  return Ctor;
}

export class BrowserAudioAdapter implements AudioAdapter {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mime = '';

  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private meterData: Uint8Array<ArrayBuffer> | null = null;
  private meterRaf = 0;
  private meter = new Meter();
  private smoothed = 0;

  private startedAt = 0;
  private pausedAccumMs = 0;
  private pauseStartedAt = 0;

  /** invariant 1: ALWAYS request a fresh stream; tear down any prior one first. */
  async acquire(): Promise<void> {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    const constraints: MediaStreamConstraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false, // invariant 2: AGC boosts noise in silence → breaks dead-mic/silence guards
        channelCount: 1,
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.stream = stream;
    // invariant 4: choose container via isTypeSupported (Safari→mp4, else opus)
    this.mime = pickRecorderMime((m) =>
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported
        ? MediaRecorder.isTypeSupported(m)
        : false,
    );
    this.startMetering(stream);
  }

  /** invariant 5: start(250) so iOS doesn't drop tails on background/abrupt stop. */
  start(timesliceMs: number = TIMESLICE_MS): void {
    if (!this.stream) throw new Error('acquire() must precede start()');
    // Defensive: if a prior recorder is still around (finalize skipped, or a
    // crashed session), detach its handlers so a late dataavailable from the
    // OLD recorder can't push into the chunks array we're about to reset for
    // the new session (corrupt mixed-container blob — issue #135).
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
    }
    const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.recorder = rec;
    this.chunks = [];
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    rec.start(timesliceMs);
    this.startedAt = Date.now();
    this.pausedAccumMs = 0;
    this.pauseStartedAt = 0;
  }

  /** invariant 3: pause by DISABLING the track, NOT MediaRecorder.pause(). */
  pause(): void {
    this.pauseStartedAt = Date.now();
    for (const t of this.stream?.getTracks() ?? []) t.enabled = false;
  }

  /** True while a pause span is open (set by pause(), cleared by resume()). */
  private get isPaused(): boolean {
    return this.pauseStartedAt !== 0;
  }

  /** invariant 7: prime the audio session, then re-enable the track. */
  resume(): void {
    this.primeAudioSession();
    for (const t of this.stream?.getTracks() ?? []) t.enabled = true;
    if (this.pauseStartedAt) {
      this.pausedAccumMs += Date.now() - this.pauseStartedAt;
      this.pauseStartedAt = 0;
    }
  }

  /** Flush buffered chunks now (don't lose tails when backgrounding). */
  flush(): void {
    try {
      if (this.recorder && this.recorder.state === 'recording') this.recorder.requestData();
    } catch {
      // requestData can throw on some engines if state changed mid-call — ignore
    }
  }

  /** invariant 7: a short silent-buffer play wakes the iOS audio session. */
  primeAudioSession(): void {
    try {
      const ctx = this.audioCtx ?? new (getAudioContextCtor())();
      this.audioCtx = ctx;
      // On iOS Safari a context created/reused outside the original tap gesture
      // can be 'suspended' — priming into a suspended context is a silent no-op.
      // Resume first so the prime actually wakes the audio session (issue #135;
      // mirrors web/sounds.ts).
      this.resumeIfSuspended(ctx);
      const buffer = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      // priming is best-effort; failure must not break resume
    }
  }

  /**
   * invariant 8: stop and assemble the clip, racing the recorder's `onstop`
   * against an 800ms timeout (Safari sometimes never fires onstop when frozen
   * by the OS).
   */
  finalize(): Promise<RecordedClip> {
    const rec = this.recorder;
    const mime = rec?.mimeType || this.mime;
    return new Promise<RecordedClip>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = () => {
        if (settled) return;
        settled = true;
        // Clear the fallback timer when onstop wins (and is harmless when the
        // timeout itself fired). Detach the recorder's handlers BEFORE resolving
        // so a late dataavailable/onstop from THIS (now finalized) recorder can
        // never touch a newer session's chunks (issue #135).
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (rec) {
          rec.ondataavailable = null;
          rec.onstop = null;
        }
        this.stopMetering();
        for (const t of this.stream?.getTracks() ?? []) t.stop();
        const blob = new Blob(this.chunks, mime ? { type: mime } : undefined);
        // Stop-while-paused (paused --STOP--> finalizing) leaves an OPEN pause
        // span: pause() set pauseStartedAt but no resume() folded it into
        // pausedAccumMs. Fold it now (and clear it so a double-fold can't happen
        // if resume() had already run — resume() resets pauseStartedAt to 0).
        if (this.pauseStartedAt) {
          this.pausedAccumMs += Date.now() - this.pauseStartedAt;
          this.pauseStartedAt = 0;
        }
        const durationMs = Date.now() - this.startedAt - this.pausedAccumMs;
        const stats = this.meter.summary();
        resolve({ blob, mime, durationMs, recordedAt: this.startedAt, stats });
      };
      if (rec) {
        rec.onstop = done;
        timer = setTimeout(done, FINALIZE_TIMEOUT_MS); // the race
        try {
          rec.stop();
        } catch {
          done();
        }
      } else {
        done();
      }
    });
  }

  /** invariant 6: close the AudioContext when idle so iOS frees the slot. */
  closeContext(): void {
    this.stopMetering();
    if (this.audioCtx) {
      try {
        void this.audioCtx.close();
      } catch {
        // already closed
      }
      this.audioCtx = null;
    }
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    // Detach handlers before dropping the reference so a late event from a
    // recorder we never finalized (e.g. start() threw → error → RESET) can't
    // mutate chunks afterwards (issue #135).
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
    }
    this.recorder = null;
    this.chunks = [];
  }

  /** invariant 1 helper: is the capture track still live after backgrounding? */
  isTrackLive(): boolean {
    const track = this.stream?.getAudioTracks()[0];
    return !!track && track.readyState === 'live';
  }

  level(): number {
    return this.smoothed;
  }

  // ---- metering (uses pure helpers from meters.ts) -----------------------

  /**
   * iOS Safari hands back a 'suspended' AudioContext when it's created/resumed
   * outside a user-gesture tick. A suspended context yields a flat analyser
   * (dead meter + pure-silence gate stats → every clip rejected) and swallows
   * the priming play. Resume it (best-effort, async) wherever we touch the ctx.
   */
  private resumeIfSuspended(ctx: AudioContext): void {
    try {
      if (ctx.state === 'suspended') void ctx.resume();
    } catch {
      // resume() can reject if the context is closing — best-effort only
    }
  }

  private startMetering(stream: MediaStream): void {
    const ctx = this.audioCtx ?? new (getAudioContextCtor())();
    this.audioCtx = ctx;
    this.resumeIfSuspended(ctx);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    this.analyser = analyser;
    this.meterData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    this.meter = new Meter();
    this.smoothed = 0;
    const tick = () => {
      if (!this.analyser || !this.meterData) return;
      this.analyser.getByteTimeDomainData(this.meterData);
      const frame = bytesToFloat(this.meterData);
      // Exclude paused frames from the gate STATS: while paused the track is
      // disabled and yields flat/silent frames; pushing them would drag
      // voiceFraction below VOICE_FRACTION_MIN and reject otherwise-good clips
      // (issue #134 bug 2). The live level() needle keeps updating regardless.
      if (!this.isPaused) this.meter.push(frame);
      this.smoothed = smoothLevel(this.smoothed, levelTarget(rms(frame)));
      this.meterRaf = requestAnimationFrame(tick);
    };
    this.meterRaf = requestAnimationFrame(tick);
  }

  private stopMetering(): void {
    if (this.meterRaf) cancelAnimationFrame(this.meterRaf);
    this.meterRaf = 0;
    this.analyser = null;
    this.meterData = null;
  }
}
