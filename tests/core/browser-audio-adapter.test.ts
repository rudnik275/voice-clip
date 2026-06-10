import { test, expect, describe, beforeEach, afterEach } from 'bun:test';

// The BrowserAudioAdapter is the ONLY place the 8 iOS invariants live. It
// touches getUserMedia / MediaRecorder / AudioContext, so here we install fake
// browser globals and assert the adapter pokes them exactly the way each
// invariant requires. No real browser needed.

// ---- fake browser environment --------------------------------------------

type FakeTrack = {
  kind: string;
  enabled: boolean;
  readyState: 'live' | 'ended';
  stop(): void;
};

class FakeMediaStream {
  tracks: FakeTrack[];
  constructor() {
    this.tracks = [
      {
        kind: 'audio',
        enabled: true,
        readyState: 'live',
        stop() {
          this.readyState = 'ended';
        },
      },
    ];
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

let lastConstraints: any = null;
let getUserMediaCalls = 0;
let currentStream: FakeMediaStream | null = null;

class FakeMediaRecorder {
  static supported = new Set<string>(['audio/mp4']);
  static isTypeSupported(m: string) {
    return FakeMediaRecorder.supported.has(m);
  }
  static suppressOnstop = false;
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  startTimeslice = -1;
  requestDataCalls = 0;
  constructor(_stream: any, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? '';
  }
  start(timeslice: number) {
    this.state = 'recording';
    this.startTimeslice = timeslice;
  }
  requestData() {
    this.requestDataCalls++;
  }
  stop() {
    this.state = 'inactive';
    if (!FakeMediaRecorder.suppressOnstop) {
      queueMicrotask(() => this.onstop?.());
    }
  }
}

let lastRecorder: FakeMediaRecorder | null = null;

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** when set, new contexts boot in this state (default 'running'). */
  static initialState: 'running' | 'suspended' = 'running';
  closed = false;
  primedBuffers = 0;
  destination = {};
  state: 'running' | 'suspended' | 'closed';
  resumeCalls = 0;
  constructor() {
    this.state = FakeAudioContext.initialState;
    FakeAudioContext.instances.push(this);
  }
  resume() {
    this.resumeCalls++;
    this.state = 'running';
    return Promise.resolve();
  }
  createAnalyser() {
    return {
      fftSize: 0,
      frequencyBinCount: 16,
      connect() {},
      getByteTimeDomainData(arr: Uint8Array) {
        arr.fill(128); // silence
      },
    } as any;
  }
  createMediaStreamSource() {
    return { connect() {} } as any;
  }
  createBuffer() {
    return {} as any;
  }
  createBufferSource() {
    const self = this;
    return {
      buffer: null,
      connect() {},
      start() {
        self.primedBuffers++;
      },
    } as any;
  }
  close() {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  }
}

function installGlobals() {
  getUserMediaCalls = 0;
  lastConstraints = null;
  lastRecorder = null;
  currentStream = null;
  FakeAudioContext.instances = [];
  FakeAudioContext.initialState = 'running';
  FakeMediaRecorder.supported = new Set(['audio/mp4']);
  FakeMediaRecorder.suppressOnstop = false;

  (globalThis as any).navigator = {
    mediaDevices: {
      getUserMedia: async (c: any) => {
        lastConstraints = c;
        getUserMediaCalls++;
        currentStream = new FakeMediaStream();
        return currentStream;
      },
    },
  };
  (globalThis as any).window = { AudioContext: FakeAudioContext };
  (globalThis as any).AudioContext = FakeAudioContext;
  (globalThis as any).MediaRecorder = new Proxy(FakeMediaRecorder, {
    construct(Target, args) {
      const inst = new (Target as any)(...args);
      lastRecorder = inst;
      return inst;
    },
  });
  // metering uses requestAnimationFrame — make it a no-op that doesn't loop
  (globalThis as any).requestAnimationFrame = () => 1;
  (globalThis as any).cancelAnimationFrame = () => {};
}

function uninstallGlobals() {
  for (const k of [
    'navigator',
    'window',
    'AudioContext',
    'MediaRecorder',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]) {
    delete (globalThis as any)[k];
  }
}

// import AFTER the fakes are declared; the module reads globals lazily at call time
import { BrowserAudioAdapter } from '../../core/browser-audio-adapter';

beforeEach(installGlobals);
afterEach(uninstallGlobals);

describe('BrowserAudioAdapter — iOS invariants', () => {
  test('invariant 1: acquire() requests a fresh getUserMedia each time', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    expect(getUserMediaCalls).toBe(1);
    const firstStream = currentStream;
    await a.acquire();
    expect(getUserMediaCalls).toBe(2);
    // the old stream's tracks were stopped before re-acquiring
    expect(firstStream!.getTracks()[0]!.readyState).toBe('ended');
  });

  test('invariant 2: autoGainControl is false in the constraints', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    expect(lastConstraints.audio.autoGainControl).toBe(false);
    expect(lastConstraints.audio.channelCount).toBe(1);
  });

  test('invariant 3: pause() disables the track and does NOT pause the recorder', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    a.pause();
    expect(currentStream!.getTracks()[0]!.enabled).toBe(false);
    expect(lastRecorder!.state).toBe('recording'); // recorder NOT paused
  });

  test('invariant 3+7: resume() primes then re-enables the track', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    a.pause();
    const primedBefore = FakeAudioContext.instances.reduce((s, c) => s + c.primedBuffers, 0);
    a.resume();
    const primedAfter = FakeAudioContext.instances.reduce((s, c) => s + c.primedBuffers, 0);
    expect(primedAfter).toBeGreaterThan(primedBefore); // primeAudioSession ran
    expect(currentStream!.getTracks()[0]!.enabled).toBe(true);
  });

  test('invariant 4: mime picked via isTypeSupported (mp4 on Safari-like)', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    expect(lastRecorder!.mimeType).toBe('audio/mp4');
  });

  test('invariant 4: opus chosen when webm supported and mp4 not', async () => {
    FakeMediaRecorder.supported = new Set(['audio/webm;codecs=opus', 'audio/webm']);
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    expect(lastRecorder!.mimeType).toBe('audio/webm;codecs=opus');
  });

  test('invariant 5: start uses a 250ms timeslice', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    expect(lastRecorder!.startTimeslice).toBe(250);
  });

  test('invariant 6: closeContext() closes the AudioContext and stops tracks', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    a.closeContext();
    const anyClosed = FakeAudioContext.instances.some((c) => c.closed);
    expect(anyClosed).toBe(true);
    expect(currentStream!.getTracks()[0]!.readyState).toBe('ended');
  });

  test('invariant 8: finalize resolves on onstop with the assembled clip', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    lastRecorder!.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
    const clip = await a.finalize();
    expect(clip.blob).toBeInstanceOf(Blob);
    expect(clip.blob.size).toBeGreaterThan(0);
    expect(clip.mime).toBe('audio/mp4');
    expect(typeof clip.durationMs).toBe('number');
    expect(clip.stats).toBeDefined();
  });

  test('invariant 8: finalize falls back to the 800ms timeout when onstop never fires', async () => {
    FakeMediaRecorder.suppressOnstop = true;
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    lastRecorder!.ondataavailable?.({ data: new Blob([new Uint8Array([9])]) });
    const clip = await a.finalize();
    expect(clip.blob.size).toBeGreaterThan(0);
  }, 2000);

  test('flush() requests data when recording (no lost tails)', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    a.flush();
    expect(lastRecorder!.requestDataCalls).toBe(1);
  });

  test('isTrackLive reflects the track readyState (dead after background+end)', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    expect(a.isTrackLive()).toBe(true);
    currentStream!.getTracks()[0]!.readyState = 'ended';
    expect(a.isTrackLive()).toBe(false);
  });
});

// ---- issue #135: adapter lifecycle (stale handlers + suspended context) ----

describe('BrowserAudioAdapter — finalize detaches handlers (issue #135)', () => {
  test('a late dataavailable from a finalized recorder cannot pollute the next session', async () => {
    // Force the 800ms-timeout path (onstop never fires) — the exact Safari
    // freeze the timer guards against, and where a late event from the old
    // recorder used to land in the next session's chunks.
    FakeMediaRecorder.suppressOnstop = true;
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    const oldRec = lastRecorder!;
    oldRec.ondataavailable?.({ data: new Blob([new Uint8Array([1, 1, 1, 1])]) });
    const firstClip = await a.finalize();
    expect(firstClip.blob.size).toBe(4);

    // After finalize resolves, the OLD recorder's handlers must be detached so
    // a late dataavailable is inert.
    expect(oldRec.ondataavailable).toBeNull();
    expect(oldRec.onstop).toBeNull();

    // Start a NEW session, fire the OLD recorder's (now-detached) handler if it
    // somehow still held a reference, then feed only the new session's chunk.
    FakeMediaRecorder.suppressOnstop = false;
    a.start(250);
    // simulate a stray late event referencing the old handler shape — must be a
    // no-op because we detached it; calling null is guarded by `?.`
    oldRec.ondataavailable?.({ data: new Blob([new Uint8Array([7, 7, 7, 7, 7, 7])]) });
    const newRec = lastRecorder!;
    newRec.ondataavailable?.({ data: new Blob([new Uint8Array([2, 2])]) });
    const secondClip = await a.finalize();
    // ONLY the new session's 2-byte chunk — no stale old-container fragment
    expect(secondClip.blob.size).toBe(2);
  });

  test('start() detaches a prior recorder defensively (finalize skipped)', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    const oldRec = lastRecorder!;
    expect(oldRec.ondataavailable).not.toBeNull();
    // start again WITHOUT finalizing — old recorder's handlers must be detached
    a.start(250);
    expect(oldRec.ondataavailable).toBeNull();
    expect(oldRec.onstop).toBeNull();
  });

  test('onstop path clears the fallback timer (no late done effect)', async () => {
    // onstop wins the race; the 800ms timer must be cleared. We assert the
    // resolved clip is stable and a subsequent timer-fire would be a no-op
    // (settled flag + cleared timer). Use a spy on clearTimeout.
    const realClear = globalThis.clearTimeout;
    let clears = 0;
    (globalThis as any).clearTimeout = (id: any) => {
      clears++;
      return realClear(id);
    };
    try {
      const a = new BrowserAudioAdapter();
      await a.acquire();
      a.start(250);
      lastRecorder!.ondataavailable?.({ data: new Blob([new Uint8Array([5])]) });
      await a.finalize(); // onstop fires (suppressOnstop=false) → done() clears timer
      expect(clears).toBeGreaterThanOrEqual(1);
    } finally {
      (globalThis as any).clearTimeout = realClear;
    }
  });

  test('closeContext detaches a never-finalized recorder (start threw upstream)', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    const rec = lastRecorder!;
    a.closeContext();
    expect(rec.ondataavailable).toBeNull();
    expect(rec.onstop).toBeNull();
  });
});

describe('BrowserAudioAdapter — suspended AudioContext is resumed (issue #135)', () => {
  test('acquire() (startMetering) resumes a suspended context', async () => {
    FakeAudioContext.initialState = 'suspended';
    const a = new BrowserAudioAdapter();
    await a.acquire();
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.resumeCalls).toBeGreaterThanOrEqual(1);
    expect(ctx.state).toBe('running');
  });

  test('primeAudioSession() resumes a suspended context before playing', async () => {
    FakeAudioContext.initialState = 'suspended';
    const a = new BrowserAudioAdapter();
    await a.acquire(); // creates + resumes the ctx in startMetering
    const ctx = FakeAudioContext.instances[0]!;
    // pretend the OS suspended it again between acquire and prime
    ctx.state = 'suspended';
    const resumesBefore = ctx.resumeCalls;
    a.primeAudioSession();
    expect(ctx.resumeCalls).toBeGreaterThan(resumesBefore);
    expect(ctx.state as string).toBe('running');
    // the prime play still happened (on the now-running context)
    expect(ctx.primedBuffers).toBeGreaterThan(0);
  });
});

// ---- issue #134: pause-related duration + metering bugs -------------------

describe('BrowserAudioAdapter — durationMs excludes pause spans (issue #134 bug 1)', () => {
  // Date.now is the adapter's only clock for duration; stub it so the test is
  // deterministic without real sleeps.
  let realNow: () => number;
  let clock = 0;
  beforeEach(() => {
    realNow = Date.now;
    clock = 1_000_000;
    Date.now = () => clock;
  });
  afterEach(() => {
    Date.now = realNow;
  });

  test('stop while PAUSED subtracts the still-open pause span', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250); // startedAt = 1_000_000
    clock += 2_000; // 2s of actual recording
    a.pause(); // pause span opens at 1_002_000
    clock += 240_000; // 4 minutes paused
    // finalize WITHOUT resume() — the open pause span must be folded out
    const clip = await a.finalize();
    expect(clip.durationMs).toBe(2_000); // not ~242_000
  });

  test('pause → resume → stop counts both recorded spans, not the pause', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250); // startedAt = 1_000_000
    clock += 2_000; // record 2s
    a.pause();
    clock += 5_000; // pause 5s
    a.resume(); // folds 5s into pausedAccumMs
    clock += 3_000; // record 3s more
    const clip = await a.finalize();
    expect(clip.durationMs).toBe(5_000); // 2s + 3s recorded, 5s pause excluded
  });

  test('resume() before stop does not get double-folded by finalize()', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);
    clock += 1_000;
    a.pause();
    clock += 4_000;
    a.resume(); // pauseStartedAt reset to 0 here
    clock += 1_000;
    const clip = await a.finalize();
    // 2s recorded, single 4s pause excluded (NOT 8s from a double-fold)
    expect(clip.durationMs).toBe(2_000);
  });
});

describe('BrowserAudioAdapter — meter excludes paused frames (issue #134 bug 2)', () => {
  // The metering loop is rAF-driven; the suite default stubs rAF to a no-op, so
  // here we capture the registered tick callback and invoke it manually to drive
  // metering deterministically through the same seam the adapter uses.
  let capturedTick: (() => void) | null = null;
  beforeEach(() => {
    capturedTick = null;
    (globalThis as any).requestAnimationFrame = (fn: () => void) => {
      capturedTick = fn;
      return 1;
    };
  });

  test('frames pushed while paused do not change summary() stats', async () => {
    const a = new BrowserAudioAdapter();
    await a.acquire();
    a.start(250);

    // Drive several metering ticks while RECORDING. The fake analyser fills
    // silence (128 → 0.0 rms), so to get a measurable signal we feed a loud
    // frame by swapping the analyser's data filler.
    const analyser: any = (a as any).analyser;
    analyser.getByteTimeDomainData = (arr: Uint8Array) => arr.fill(255); // loud
    for (let i = 0; i < 5; i++) capturedTick!();
    const recordingStats = a['meter'].summary();
    expect(recordingStats.voiceFraction).toBeGreaterThan(0);
    const framesWhileRecording = a['meter'].frameCount;

    // Now PAUSE and drive many more ticks: a disabled track yields flat/silent
    // frames. These must NOT be ingested into the gate stats.
    a.pause();
    analyser.getByteTimeDomainData = (arr: Uint8Array) => arr.fill(128); // silence
    for (let i = 0; i < 100; i++) capturedTick!();

    expect(a['meter'].frameCount).toBe(framesWhileRecording); // paused frames excluded
    const afterPauseStats = a['meter'].summary();
    expect(afterPauseStats).toEqual(recordingStats); // stats unchanged by the pause
  });
});
