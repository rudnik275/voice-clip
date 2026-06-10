import { test, expect, describe } from 'bun:test';
import { RecorderMachine, type RecorderState } from '../../core/recorder-machine';
import type { AudioAdapter, RecordedClip, Uploader, UploadResult } from '../../core/ports';

// ---- fakes ----------------------------------------------------------------

/**
 * A fully observable fake AudioAdapter. Records every call and lets a test
 * drive finalize resolution and track-liveness deterministically.
 */
class FakeAudioAdapter implements AudioAdapter {
  calls: string[] = [];
  acquireCount = 0;
  startTimeslices: number[] = [];
  trackLive = true;
  contextOpen = false;
  finalizeCount = 0;
  acquireShouldFail = false;

  private finalizeResolvers: Array<(c: RecordedClip) => void> = [];

  async acquire(): Promise<void> {
    this.calls.push('acquire');
    this.acquireCount++;
    if (this.acquireShouldFail) throw new Error('permission denied');
    this.trackLive = true;
    this.contextOpen = true;
  }
  start(timesliceMs: number): void {
    this.calls.push(`start(${timesliceMs})`);
    this.startTimeslices.push(timesliceMs);
  }
  pause(): void {
    this.calls.push('pause');
  }
  resume(): void {
    this.calls.push('resume');
  }
  flush(): void {
    this.calls.push('flush');
  }
  primeAudioSession(): void {
    this.calls.push('primeAudioSession');
  }
  closeContext(): void {
    this.calls.push('closeContext');
    this.contextOpen = false;
  }
  isTrackLive(): boolean {
    return this.trackLive;
  }
  level(): number {
    return 0;
  }
  finalize(): Promise<RecordedClip> {
    this.calls.push('finalize');
    this.finalizeCount++;
    return new Promise((resolve) => {
      this.finalizeResolvers.push(resolve);
    });
  }
  /** test helper: resolve the pending finalize() with a clip */
  resolveFinalize(clip?: Partial<RecordedClip>): void {
    const r = this.finalizeResolvers.shift();
    if (!r) throw new Error('no pending finalize to resolve');
    r({
      blob: new Blob([new Uint8Array([1, 2, 3])]),
      mime: 'audio/webm;codecs=opus',
      durationMs: 3000,
      recordedAt: 1_700_000_000_000,
      stats: { avgRms: 0.2, voiceFraction: 0.5, peakLevel: 0.8 },
      ...clip,
    });
  }
}

class FakeUploader implements Uploader {
  result: UploadResult = { ok: true, text: 'done' };
  uploadCount = 0;
  lastClip: RecordedClip | null = null;

  async upload(clip: RecordedClip): Promise<UploadResult> {
    this.uploadCount++;
    this.lastClip = clip;
    return this.result;
  }
}

function make() {
  const adapter = new FakeAudioAdapter();
  const uploader = new FakeUploader();
  const states: RecorderState[] = [];
  const machine = new RecorderMachine({ adapter, uploader });
  machine.subscribe((s) => states.push(s.state));
  return { adapter, uploader, machine, states };
}

/** Drive idle → recording (TAP, await acquire, MIC_OK fires internally). */
async function toRecording(m: { machine: RecorderMachine; adapter: FakeAudioAdapter }) {
  m.machine.send('TAP');
  await m.machine.settled();
}

// ---- state / transition tests --------------------------------------------

describe('RecorderMachine — initial state', () => {
  test('starts in idle', () => {
    const { machine } = make();
    expect(machine.state).toBe('idle');
  });
});

describe('RecorderMachine — happy path transitions', () => {
  test('idle --TAP--> acquiring --MIC_OK--> recording', async () => {
    const { machine, adapter } = make();
    machine.send('TAP');
    expect(machine.state).toBe('acquiring');
    expect(adapter.acquireCount).toBe(1);
    await machine.settled();
    expect(machine.state).toBe('recording');
    expect(adapter.startTimeslices).toEqual([250]); // invariant 5
  });

  test('recording --STOP--> finalizing --(onstop)--> transcribing --UPLOAD_OK--> idle', async () => {
    const { machine, adapter, uploader } = make();
    await toRecording({ machine, adapter });
    machine.send('STOP');
    expect(machine.state).toBe('finalizing');
    adapter.resolveFinalize();
    await machine.settled();
    expect(uploader.uploadCount).toBe(1);
    expect(machine.state).toBe('idle');
    expect(adapter.calls).toContain('closeContext'); // invariant 6
  });
});

describe('RecorderMachine — mic failure', () => {
  test('acquiring --MIC_FAIL--> error', async () => {
    const { machine, adapter } = make();
    adapter.acquireShouldFail = true;
    machine.send('TAP');
    await machine.settled();
    expect(machine.state).toBe('error');
  });

  test('error --RESET--> idle (closes context)', async () => {
    const { machine, adapter } = make();
    adapter.acquireShouldFail = true;
    machine.send('TAP');
    await machine.settled();
    expect(machine.state).toBe('error');
    machine.send('RESET');
    expect(machine.state).toBe('idle');
    expect(adapter.calls).toContain('closeContext');
  });
});

describe('RecorderMachine — upload failure', () => {
  test('transcribing --UPLOAD_FAIL--> error', async () => {
    const { machine, adapter, uploader } = make();
    uploader.result = { ok: false, reason: 'server', status: 500 };
    await toRecording({ machine, adapter });
    machine.send('STOP');
    adapter.resolveFinalize();
    await machine.settled();
    expect(machine.state).toBe('error');
  });
});

// ---- the 8 iOS invariants -------------------------------------------------

describe('iOS invariant 1 — fresh getUserMedia per recording', () => {
  test('every new recording calls adapter.acquire() afresh', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    expect(adapter.acquireCount).toBe(1);
    machine.send('STOP');
    adapter.resolveFinalize();
    await machine.settled();
    expect(machine.state).toBe('idle');
    // second recording
    await toRecording({ machine, adapter });
    expect(adapter.acquireCount).toBe(2);
  });
});

describe('iOS invariant 3 — pause via track.enabled, never MediaRecorder.pause()', () => {
  test('PAUSE_TOGGLE in recording calls adapter.pause() (track.enabled=false)', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    machine.send('PAUSE_TOGGLE');
    expect(machine.state).toBe('paused');
    expect(adapter.calls).toContain('pause');
  });

  test('PAUSE_TOGGLE in paused resumes via primeAudioSession + resume', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    machine.send('PAUSE_TOGGLE'); // -> paused
    adapter.calls.length = 0;
    machine.send('PAUSE_TOGGLE'); // -> recording
    expect(machine.state).toBe('recording');
    // invariant 7: prime before resume, and in that order
    expect(adapter.calls).toEqual(['primeAudioSession', 'resume']);
  });

  test('PAUSE_TOGGLE resume with a DEAD track finalizes (never re-records silence)', async () => {
    // Manual pause → iOS kills the track (call/Siri) → manual resume must mirror
    // the FOREGROUNDED dead-track guard: finalize instead of re-enabling a dead
    // track and recording silence forever (issue #134 bug 3).
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    machine.send('PAUSE_TOGGLE'); // -> paused
    adapter.trackLive = false; // track died during the pause
    adapter.calls.length = 0;
    machine.send('PAUSE_TOGGLE');
    expect(machine.state).toBe('finalizing');
    expect(adapter.finalizeCount).toBe(1);
    // must NOT have re-enabled a dead track
    expect(adapter.calls).not.toContain('resume');
  });
});

describe('iOS invariant 5 — MediaRecorder.start(250) timeslice', () => {
  test('start always uses a 250ms timeslice', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    expect(adapter.startTimeslices).toEqual([250]);
  });
});

describe('iOS invariant 6 — close AudioContext at idle', () => {
  test('reaching idle after a successful upload closes the context exactly once', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    machine.send('STOP');
    adapter.resolveFinalize();
    await machine.settled();
    expect(machine.state).toBe('idle');
    expect(adapter.contextOpen).toBe(false);
    expect(adapter.calls.filter((c) => c === 'closeContext').length).toBe(1);
  });

  test('RESET from error closes the context', async () => {
    const { machine, adapter, uploader } = make();
    uploader.result = { ok: false, reason: 'network' };
    await toRecording({ machine, adapter });
    machine.send('STOP');
    adapter.resolveFinalize();
    await machine.settled();
    expect(machine.state).toBe('error');
    machine.send('RESET');
    expect(adapter.contextOpen).toBe(false);
  });
});

describe('iOS invariant 7 — primeAudioSession before resume', () => {
  test('resume path primes the audio session first', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    machine.send('PAUSE_TOGGLE');
    adapter.calls.length = 0;
    machine.send('PAUSE_TOGGLE');
    const prime = adapter.calls.indexOf('primeAudioSession');
    const resume = adapter.calls.indexOf('resume');
    expect(prime).toBeGreaterThanOrEqual(0);
    expect(resume).toBeGreaterThan(prime);
  });
});

describe('iOS invariant 8 — finalize races onstop vs 800ms timeout', () => {
  test('if finalize resolves (onstop) we move past finalizing', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    machine.send('STOP');
    expect(machine.state).toBe('finalizing');
    adapter.resolveFinalize();
    await machine.settled();
    expect(machine.state).not.toBe('finalizing');
  });

  test('finalize is delegated to the adapter (which owns the 800ms race)', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    machine.send('STOP');
    expect(adapter.finalizeCount).toBe(1);
  });
});

// ---- background / foreground (the bug under study) ------------------------

describe('iOS invariant 2 (background) — flush+disable; never record silence on return', () => {
  test('recording --BACKGROUNDED--> paused: flushes chunks BEFORE disabling track', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    machine.send('BACKGROUNDED');
    expect(machine.state).toBe('paused');
    const flushIdx = adapter.calls.indexOf('flush');
    const pauseIdx = adapter.calls.indexOf('pause');
    expect(flushIdx).toBeGreaterThanOrEqual(0);
    expect(pauseIdx).toBeGreaterThan(flushIdx);
  });

  test('paused --FOREGROUNDED--> recording when track alive', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    machine.send('BACKGROUNDED'); // -> paused
    adapter.trackLive = true;
    adapter.calls.length = 0;
    machine.send('FOREGROUNDED');
    expect(machine.state).toBe('recording');
    expect(adapter.calls).toContain('resume');
  });

  test('paused --FOREGROUNDED--> finalizing when track DEAD (no silent recording)', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    machine.send('BACKGROUNDED'); // -> paused
    adapter.trackLive = false; // iOS killed the track
    machine.send('FOREGROUNDED');
    // must NOT silently keep recording silence — it finalizes instead
    expect(machine.state).toBe('finalizing');
    expect(adapter.finalizeCount).toBe(1);
  });

  test('paused --STOP--> finalizing', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    machine.send('PAUSE_TOGGLE'); // -> paused
    machine.send('STOP');
    expect(machine.state).toBe('finalizing');
  });
});

// ---- double-tap / spurious events ----------------------------------------

describe('robustness — ignores out-of-state events', () => {
  test('a too-fast double TAP in acquiring is ignored (single acquire)', async () => {
    const { machine, adapter } = make();
    machine.send('TAP'); // -> acquiring, acquire() in flight
    machine.send('TAP'); // ignored — still acquiring
    expect(machine.state).toBe('acquiring');
    await machine.settled();
    expect(adapter.acquireCount).toBe(1); // only one fresh getUserMedia
    expect(machine.state).toBe('recording');
  });

  test('TAP in recording is ignored', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    machine.send('TAP');
    expect(machine.state).toBe('recording');
    expect(adapter.acquireCount).toBe(1);
  });

  test('STOP in idle is a no-op', () => {
    const { machine } = make();
    machine.send('STOP');
    expect(machine.state).toBe('idle');
  });

  test('FOREGROUNDED while recording is a no-op', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    const before = machine.state;
    machine.send('FOREGROUNDED');
    expect(machine.state).toBe(before);
  });
});

// ---- observable transition log -------------------------------------------

describe('observable transition log', () => {
  test('records every transition with from/event/to', async () => {
    const { machine, adapter } = make();
    await toRecording({ machine, adapter });
    machine.send('STOP');
    adapter.resolveFinalize();
    await machine.settled();
    const log = machine.transitionLog();
    expect(log[0]).toMatchObject({ from: 'idle', event: 'TAP', to: 'acquiring' });
    const events = log.map((l) => l.event);
    expect(events).toContain('TAP');
    expect(events).toContain('MIC_OK');
    expect(events).toContain('STOP');
    expect(events).toContain('FINALIZED'); // internal onstop/timeout completion
    expect(events).toContain('UPLOAD_OK');
    // log captures finalizing → transcribing explicitly
    expect(log).toContainEqual(
      expect.objectContaining({ from: 'finalizing', event: 'FINALIZED', to: 'transcribing' }),
    );
    for (const e of log) expect(typeof e.at).toBe('number');
  });

  test('subscribers receive state snapshots', async () => {
    const { machine, adapter, states } = make();
    await toRecording({ machine, adapter });
    expect(states).toContain('acquiring');
    expect(states).toContain('recording');
  });
});
