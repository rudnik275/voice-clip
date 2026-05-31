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
  closed = false;
  primedBuffers = 0;
  destination = {};
  constructor() {
    FakeAudioContext.instances.push(this);
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
    return Promise.resolve();
  }
}

function installGlobals() {
  getUserMediaCalls = 0;
  lastConstraints = null;
  lastRecorder = null;
  currentStream = null;
  FakeAudioContext.instances = [];
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
