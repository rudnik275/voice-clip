import { test, expect, describe } from 'bun:test';
import { createUploader, buildUploadForm, passesGate, type SendFn } from '../../core/uploader';
import type { RecordedClip } from '../../core/ports';

function clip(over: Partial<RecordedClip> = {}): RecordedClip {
  return {
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }),
    mime: 'audio/webm;codecs=opus',
    durationMs: 3000,
    recordedAt: 1_700_000_000_000,
    stats: { avgRms: 0.2, voiceFraction: 0.5, peakLevel: 0.8 },
    ...over,
  };
}

// A deterministic backoff that records sleep durations instead of waiting.
function fakeSleeper() {
  const slept: number[] = [];
  return {
    slept,
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

describe('uploader gate', () => {
  test('rejects too-short clips without hitting the network', async () => {
    let calls = 0;
    const send: SendFn = async () => {
      calls++;
      return { ok: true, status: 200, text: 'hi' };
    };
    const up = createUploader({ send });
    const r = await up.upload(clip({ durationMs: 100 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rejected');
    expect(calls).toBe(0);
  });

  test('rejects too-quiet clips (low rms) without hitting the network', async () => {
    let calls = 0;
    const send: SendFn = async () => {
      calls++;
      return { ok: true, status: 200, text: 'hi' };
    };
    const up = createUploader({ send });
    const r = await up.upload(clip({ stats: { avgRms: 0.001, voiceFraction: 0.5, peakLevel: 0.1 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('rejected');
    expect(calls).toBe(0);
  });

  test('rejects clips with too little voice (low voiceFraction)', async () => {
    let calls = 0;
    const send: SendFn = async () => {
      calls++;
      return { ok: true, status: 200, text: 'hi' };
    };
    const up = createUploader({ send });
    const r = await up.upload(clip({ stats: { avgRms: 0.2, voiceFraction: 0.0, peakLevel: 0.8 } }));
    expect(r.ok).toBe(false);
    expect(calls).toBe(0);
  });

  test('passesGate is a pure predicate matching the gate', () => {
    expect(passesGate(clip())).toBe(true);
    expect(passesGate(clip({ durationMs: 10 }))).toBe(false);
    expect(passesGate(clip({ stats: { avgRms: 0, voiceFraction: 0, peakLevel: 0 } }))).toBe(false);
  });

  test('passes a valid clip through to send', async () => {
    let calls = 0;
    const send: SendFn = async () => {
      calls++;
      return { ok: true, status: 200, text: 'transcribed!' };
    };
    const up = createUploader({ send });
    const r = await up.upload(clip());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('transcribed!');
    expect(calls).toBe(1);
  });
});

describe('uploader form contract', () => {
  test('builds form fields and does NOT send presetId', () => {
    const fd = buildUploadForm(clip({ source: 'online' }));
    expect(fd.get('source')).toBe('online');
    expect(fd.get('recordedAt')).toBe('1700000000000');
    expect(fd.get('durationMs')).toBe('3000');
    expect(fd.get('audio')).toBeInstanceOf(Blob);
    expect(fd.get('presetId')).toBeNull();
    expect(fd.has('presetId')).toBe(false);
  });

  test('audio filename extension follows the mime', () => {
    const fd = buildUploadForm(clip({ mime: 'audio/mp4' }));
    const f = fd.get('audio') as File;
    expect(f.name).toBe('clip.m4a');
  });

  test('defaults source to online when unset', () => {
    const c = clip();
    delete (c as { source?: string }).source;
    const fd = buildUploadForm(c);
    expect(fd.get('source')).toBe('online');
  });

  test('passes offline source through', () => {
    const fd = buildUploadForm(clip({ source: 'offline' }));
    expect(fd.get('source')).toBe('offline');
  });
});

describe('uploader retry / backoff', () => {
  test('retries on network failure with exponential backoff then succeeds', async () => {
    const seq: Array<'throw' | 'ok'> = ['throw', 'throw', 'ok'];
    let i = 0;
    const send: SendFn = async () => {
      const step = seq[i++];
      if (step === 'throw') throw new Error('network down');
      return { ok: true, status: 200, text: 'finally' };
    };
    const sleeper = fakeSleeper();
    const up = createUploader({ send, maxRetries: 3, baseDelayMs: 100, sleep: sleeper.sleep });
    const r = await up.upload(clip());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('finally');
    expect(i).toBe(3); // two failures + one success
    // backoff doubles: 100ms then 200ms before the two retries
    expect(sleeper.slept).toEqual([100, 200]);
  });

  test('retries on 5xx server responses', async () => {
    const codes = [503, 502, 200];
    let i = 0;
    const send: SendFn = async () => {
      const status = codes[i++]!;
      return status === 200
        ? { ok: true, status, text: 'ok' }
        : { ok: false, status, text: 'err' };
    };
    const sleeper = fakeSleeper();
    const up = createUploader({ send, maxRetries: 3, baseDelayMs: 50, sleep: sleeper.sleep });
    const r = await up.upload(clip());
    expect(r.ok).toBe(true);
    expect(i).toBe(3);
    expect(sleeper.slept).toEqual([50, 100]);
  });

  test('does NOT retry on 4xx client errors', async () => {
    let calls = 0;
    const send: SendFn = async () => {
      calls++;
      return { ok: false, status: 400, text: 'bad request' };
    };
    const sleeper = fakeSleeper();
    const up = createUploader({ send, maxRetries: 5, baseDelayMs: 10, sleep: sleeper.sleep });
    const r = await up.upload(clip());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('server');
      expect(r.status).toBe(400);
    }
    expect(calls).toBe(1);
    expect(sleeper.slept).toEqual([]);
  });

  test('gives up after maxRetries on persistent network failure', async () => {
    let calls = 0;
    const send: SendFn = async () => {
      calls++;
      throw new Error('still down');
    };
    const sleeper = fakeSleeper();
    const up = createUploader({ send, maxRetries: 3, baseDelayMs: 20, sleep: sleeper.sleep });
    const r = await up.upload(clip());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('network');
    expect(calls).toBe(3); // attempts = maxRetries
    expect(sleeper.slept).toEqual([20, 40]); // sleeps between the 3 attempts
  });
});
