// ---- RecorderMachine: the framework-agnostic capture FSM ----
//
// A finite-state machine that exactly mirrors the PRD #99 diagram. It depends
// ONLY on the two ports (AudioAdapter, Uploader) plus the pure helpers
// (meters, mime, used by the adapter/uploader). It touches no DOM, no Vue.
//
// Design:
//   * `send(event)` applies a transition SYNCHRONOUSLY (so a UI can read the
//     new state immediately) and fires the matching side-effect on the ports.
//   * Async side-effects (acquire / finalize / upload) don't block `send`.
//     When they settle, the machine dispatches the appropriate follow-up event
//     (MIC_OK/MIC_FAIL, finalize→transcribing, UPLOAD_OK/UPLOAD_FAIL).
//   * `settled()` resolves once no async side-effect is in flight — tests await
//     it for determinism; a UI never needs it.
//   * Every transition is appended to an observable transition log
//     (transitionLog()) so the "next recording is silent after backgrounding"
//     bug becomes diagnosable in-browser (PRD user story 31).
//
// The 8 iOS invariants live in BrowserAudioAdapter; the machine only encodes
// WHICH port method to call WHEN (e.g. flush-before-pause on BACKGROUNDED,
// prime-before-resume on PAUSE_TOGGLE, finalize-vs-record on FOREGROUNDED).

import type { AudioAdapter, RecordedClip, Uploader } from './ports';

export type RecorderState =
  | 'idle'
  | 'acquiring'
  | 'recording'
  | 'paused'
  | 'finalizing'
  | 'transcribing'
  | 'error';

export type RecorderEvent =
  | 'TAP'
  | 'MIC_OK'
  | 'MIC_FAIL'
  | 'PAUSE_TOGGLE'
  | 'STOP'
  | 'BACKGROUNDED'
  | 'FOREGROUNDED'
  | 'UPLOAD_OK'
  | 'UPLOAD_FAIL'
  | 'RESET';

/** Timeslice handed to MediaRecorder.start (invariant 5). */
export const TIMESLICE_MS = 250;

/**
 * Internal pseudo-event that isn't part of the public event set but appears in
 * the transition log so it stays truthful. `FINALIZED` marks the adapter's
 * onstop-or-800ms-timeout completion driving finalizing → transcribing.
 */
export type InternalEvent = 'FINALIZED' | 'START_FAILED';

/** A transition log entry carries either a public event or an internal one. */
export type TransitionEntry = {
  from: RecorderState;
  event: RecorderEvent | InternalEvent;
  to: RecorderState;
  at: number;
};

export type RecorderSnapshot = {
  state: RecorderState;
  /** the last finished clip, if any (set when finalize resolves). */
  lastClip: RecordedClip | null;
  /** last error message, if in `error`. */
  error: string | null;
};

export type RecorderMachineDeps = {
  adapter: AudioAdapter;
  uploader: Uploader;
  /** injectable clock for the transition log (tests can freeze it). */
  now?: () => number;
};

type Subscriber = (snap: RecorderSnapshot) => void;

export class RecorderMachine {
  private _state: RecorderState = 'idle';
  private readonly adapter: AudioAdapter;
  private readonly uploader: Uploader;
  private readonly now: () => number;

  private readonly log: TransitionEntry[] = [];
  private readonly subscribers = new Set<Subscriber>();

  private _lastClip: RecordedClip | null = null;
  private _error: string | null = null;

  /** in-flight async side-effect; settled() awaits it. */
  private pending: Promise<void> | null = null;

  constructor(deps: RecorderMachineDeps) {
    this.adapter = deps.adapter;
    this.uploader = deps.uploader;
    this.now = deps.now ?? (() => Date.now());
  }

  get state(): RecorderState {
    return this._state;
  }

  snapshot(): RecorderSnapshot {
    return { state: this._state, lastClip: this._lastClip, error: this._error };
  }

  /** Subscribe to state changes. Returns an unsubscribe fn. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Observable transition log (a copy — callers can't mutate internal state). */
  transitionLog(): TransitionEntry[] {
    return this.log.slice();
  }

  /**
   * Resolve once any in-flight async side-effect (acquire/finalize/upload) has
   * settled AND its follow-up event has been processed. Loops because one
   * settling effect can kick off another (finalize → transcribing → upload).
   */
  async settled(): Promise<void> {
    while (this.pending) {
      const p = this.pending;
      await p;
      // if p was still the current pending, clear it (a new one may be set)
      if (this.pending === p) this.pending = null;
    }
  }

  /**
   * Apply an event. Synchronous: transitions + sync side-effects happen now;
   * async side-effects are kicked off and tracked via `pending`.
   */
  send(event: RecorderEvent): void {
    const from = this._state;
    const to = this.next(from, event);
    if (to === null) {
      // out-of-state event — ignored by design (e.g. double TAP, STOP in idle)
      return;
    }
    this.transition(from, event, to);
    this.runEffect(from, event, to);
  }

  // ---- transition table (mirrors PRD #99) --------------------------------

  /** Pure: given (state, event) return the next state, or null if no edge. */
  private next(state: RecorderState, event: RecorderEvent): RecorderState | null {
    switch (state) {
      case 'idle':
        return event === 'TAP' ? 'acquiring' : null;
      case 'acquiring':
        if (event === 'MIC_OK') return 'recording';
        if (event === 'MIC_FAIL') return 'error';
        return null; // ignore TAP / everything else while acquiring
      case 'recording':
        if (event === 'PAUSE_TOGGLE') return 'paused';
        if (event === 'BACKGROUNDED') return 'paused';
        if (event === 'STOP') return 'finalizing';
        return null;
      case 'paused':
        if (event === 'PAUSE_TOGGLE') {
          // guard: manual resume must mirror the FOREGROUNDED guard — a track
          // iOS killed during the pause (call/Siri) must NOT be re-enabled and
          // recorded as silence. Alive → resume recording; dead → finalize.
          return this.adapter.isTrackLive() ? 'recording' : 'finalizing';
        }
        if (event === 'FOREGROUNDED') {
          // guard: alive track → resume recording; dead track → finalize
          // (never silently keep recording silence).
          return this.adapter.isTrackLive() ? 'recording' : 'finalizing';
        }
        if (event === 'STOP') return 'finalizing';
        return null;
      case 'finalizing':
        // finalize completion is dispatched internally as a state change, not
        // via a public event; no external event advances finalizing.
        return null;
      case 'transcribing':
        if (event === 'UPLOAD_OK') return 'idle';
        if (event === 'UPLOAD_FAIL') return 'error';
        return null;
      case 'error':
        return event === 'RESET' ? 'idle' : null;
      default:
        return null;
    }
  }

  // ---- side-effects -------------------------------------------------------

  private runEffect(from: RecorderState, event: RecorderEvent, to: RecorderState): void {
    // idle --TAP--> acquiring : fresh getUserMedia (invariant 1)
    if (from === 'idle' && event === 'TAP') {
      this.track(
        this.adapter
          .acquire()
          .then(() => {
            // only honour MIC_OK if we're still acquiring (not aborted meanwhile)
            if (this._state === 'acquiring') this.send('MIC_OK');
          })
          .catch((err: unknown) => {
            // A synchronous throw from adapter.start() inside the MIC_OK effect
            // propagates here, but by then state is already 'recording' (start
            // ran in the transition) — that case is handled directly in the
            // MIC_OK effect below. Only treat this as a mic-acquisition failure
            // while we're still 'acquiring'.
            if (this._state !== 'acquiring') return;
            this._error = err instanceof Error ? err.message : String(err);
            this.send('MIC_FAIL');
          }),
      );
      return;
    }

    // acquiring --MIC_OK--> recording : start(250) (invariant 5)
    if (from === 'acquiring' && event === 'MIC_OK') {
      try {
        this.adapter.start(TIMESLICE_MS);
      } catch (err: unknown) {
        // A synchronous throw here (NotSupportedError from `new MediaRecorder`,
        // InvalidStateError from rec.start() if the track died between acquire
        // and start) must NEVER leave us claiming to be recording with no live
        // recorder. Route straight to the error state and tear down the stream/
        // context so RESET starts clean. Mirrors the MIC_FAIL error path.
        this._error = err instanceof Error ? err.message : String(err);
        try {
          this.adapter.closeContext();
        } catch {
          // teardown is best-effort; we're already heading to error
        }
        // internal transition (keeps the public event surface unchanged; the
        // throw came from inside the MIC_OK effect, not a separate event)
        if (this._state === 'recording') {
          this.transition('recording', 'START_FAILED', 'error');
        }
      }
      return;
    }

    // recording --PAUSE_TOGGLE--> paused : track.enabled=false (invariant 3)
    if (from === 'recording' && event === 'PAUSE_TOGGLE') {
      this.adapter.pause();
      return;
    }

    // paused --PAUSE_TOGGLE--> recording (track alive) : prime then enable (invariant 7)
    if (from === 'paused' && event === 'PAUSE_TOGGLE' && to === 'recording') {
      this.adapter.primeAudioSession();
      this.adapter.resume();
      return;
    }

    // paused --PAUSE_TOGGLE--> finalizing (track dead) : do NOT record silence
    if (from === 'paused' && event === 'PAUSE_TOGGLE' && to === 'finalizing') {
      this.beginFinalize();
      return;
    }

    // recording --BACKGROUNDED--> paused : flush buffered chunks THEN disable track
    if (from === 'recording' && event === 'BACKGROUNDED') {
      this.adapter.flush();
      this.adapter.pause();
      return;
    }

    // paused --FOREGROUNDED--> recording (track alive) : prime + resume
    if (from === 'paused' && event === 'FOREGROUNDED' && to === 'recording') {
      this.adapter.primeAudioSession();
      this.adapter.resume();
      return;
    }

    // paused --FOREGROUNDED--> finalizing (track dead) : do NOT record silence
    if (from === 'paused' && event === 'FOREGROUNDED' && to === 'finalizing') {
      this.beginFinalize();
      return;
    }

    // (recording|paused) --STOP--> finalizing : adapter.finalize()
    // (the onstop-vs-800ms race is owned by the adapter, invariant 8)
    if ((from === 'recording' || from === 'paused') && event === 'STOP') {
      this.beginFinalize();
      return;
    }

    // transcribing --UPLOAD_OK--> idle : close context (invariant 6)
    if (from === 'transcribing' && event === 'UPLOAD_OK') {
      this.adapter.closeContext();
      return;
    }

    // error --RESET--> idle : close context (invariant 6)
    if (from === 'error' && event === 'RESET') {
      this.adapter.closeContext();
      return;
    }
  }

  /**
   * Drive finalizing → transcribing → upload. The adapter owns the onstop-vs-
   * 800ms race; we just await its resolved clip, move to transcribing, then
   * upload and dispatch UPLOAD_OK / UPLOAD_FAIL.
   */
  private beginFinalize(): void {
    this.track(
      this.adapter
        .finalize()
        .then((clip) => {
          this._lastClip = clip;
          // finalizing → transcribing (internal: adapter onstop/timeout)
          if (this._state === 'finalizing') {
            this.transition('finalizing', 'FINALIZED', 'transcribing');
          }
          return this.uploader.upload(clip).then((res) => {
            if (this._state !== 'transcribing') return;
            if (res.ok) {
              this.send('UPLOAD_OK');
            } else {
              this._error = res.message ?? res.reason;
              this.send('UPLOAD_FAIL');
            }
          });
        })
        .catch((err: unknown) => {
          this._error = err instanceof Error ? err.message : String(err);
          // force into error regardless of where finalize broke
          if (this._state === 'finalizing') {
            this.transition('finalizing', 'FINALIZED', 'transcribing');
          }
          if (this._state === 'transcribing') {
            this.send('UPLOAD_FAIL');
          }
        }),
    );
  }

  // ---- internals ----------------------------------------------------------

  /** Commit a state change: update state, append to log, notify subscribers. */
  private transition(
    from: RecorderState,
    event: RecorderEvent | InternalEvent,
    to: RecorderState,
  ): void {
    this._state = to;
    if (to === 'idle') {
      this._error = null;
    }
    this.log.push({ from, event, to, at: this.now() });
    const snap = this.snapshot();
    for (const fn of this.subscribers) fn(snap);
  }

  /** Track an in-flight async effect so settled() can await all of them. */
  private track(p: Promise<void>): void {
    this.pending = this.pending ? this.pending.then(() => p) : p;
  }
}
