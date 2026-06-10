// Tests for issue #140 — offline upload queue (core drain controller +
// uploader fallback), driven entirely through fakes:
//   * withOfflineFallback: transport failure → enqueued + success-to-machine;
//     4xx / 5xx / gate rejection → NOT enqueued; enqueue failure → real error.
//   * createOfflineSync.drain(): item removed only on 2xx; drained form posts
//     source=offline + the ORIGINAL recordedAt; first failure stops the drain;
//     concurrent drain calls share one in-flight drain (no double-upload).

import { test, expect, describe } from 'bun:test';
import {
  createOfflineSync,
  withOfflineFallback,
  buildOfflineForm,
  type OfflineQueue,
  type QueuedClip,
} from '../../core/offline-sync';
import type { SendFn } from '../../core/uploader';
import type { RecordedClip, Uploader, UploadResult } from '../../core/ports';

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

/** In-memory fake of the OfflineQueue port. */
function fakeQueue(initial: QueuedClip[] = []): OfflineQueue & { items: Map<string, QueuedClip> } {
  const items = new Map(initial.map((i) => [i.localId, i]));
  return {
    items,
    async put(item) {
      items.set(item.localId, item);
    },
    async list() {
      return [...items.values()];
    },
    async delete(id) {
      items.delete(id);
    },
  };
}

function failingUploader(reason: 'network' | 'server' | 'rejected', status?: number): Uploader {
  return {
    async upload(): Promise<UploadResult> {
      return { ok: false, reason, status, message: `${reason} ${status ?? ''}` };
    },
  };
}

function queuedItem(over: Partial<QueuedClip> = {}): QueuedClip {
  return {
    localId: 'q1',
    blob: new Blob([new Uint8Array([9, 9])], { type: 'audio/mp4' }),
    mime: 'audio/mp4',
    recordedAt: 1_700_000_111_000,
    durationMs: 4200,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// withOfflineFallback — what gets enqueued
// ---------------------------------------------------------------------------

describe('withOfflineFallback', () => {
  test('transport failure → enqueued with blob/mime/recordedAt and reported as success', async () => {
    const q = fakeQueue();
    const sync = createOfflineSync({ queue: q, send: async () => { throw new Error('x'); }, newId: () => 'id-1' });
    let queuedToasts = 0;
    const up = withOfflineFallback(failingUploader('network'), sync, () => queuedToasts++);

    const c = clip();
    const res = await up.upload(c);

    expect(res).toEqual({ ok: true, text: '' }); // machine goes to idle, not error
    expect(queuedToasts).toBe(1);
    expect(q.items.size).toBe(1);
    const item = q.items.get('id-1')!;
    expect(item.blob).toBe(c.blob);
    expect(item.mime).toBe(c.mime);
    expect(item.recordedAt).toBe(c.recordedAt);
    expect(item.durationMs).toBe(c.durationMs);
  });

  test('4xx server rejection → NOT enqueued, error passes through', async () => {
    const q = fakeQueue();
    const sync = createOfflineSync({ queue: q, send: async () => { throw new Error('x'); } });
    let queuedToasts = 0;
    const up = withOfflineFallback(failingUploader('server', 400), sync, () => queuedToasts++);

    const res = await up.upload(clip());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
    expect(q.items.size).toBe(0);
    expect(queuedToasts).toBe(0);
  });

  test('5xx after retries → NOT enqueued (server received the audio)', async () => {
    const q = fakeQueue();
    const sync = createOfflineSync({ queue: q, send: async () => { throw new Error('x'); } });
    const up = withOfflineFallback(failingUploader('server', 503), sync);

    const res = await up.upload(clip());
    expect(res.ok).toBe(false);
    expect(q.items.size).toBe(0);
  });

  test('gate rejection (too short/quiet) → NOT enqueued', async () => {
    const q = fakeQueue();
    const sync = createOfflineSync({ queue: q, send: async () => { throw new Error('x'); } });
    const up = withOfflineFallback(failingUploader('rejected'), sync);

    const res = await up.upload(clip());
    expect(res.ok).toBe(false);
    expect(q.items.size).toBe(0);
  });

  test('success passes through untouched and enqueues nothing', async () => {
    const q = fakeQueue();
    const sync = createOfflineSync({ queue: q, send: async () => { throw new Error('x'); } });
    const base: Uploader = { async upload() { return { ok: true, text: 'привет' }; } };
    const up = withOfflineFallback(base, sync);

    const res = await up.upload(clip());
    expect(res).toEqual({ ok: true, text: 'привет' });
    expect(q.items.size).toBe(0);
  });

  test('enqueue failure (e.g. IndexedDB unavailable) → original error surfaces', async () => {
    const sync = { enqueue: async () => { throw new Error('idb dead'); } };
    let queuedToasts = 0;
    const up = withOfflineFallback(failingUploader('network'), sync, () => queuedToasts++);

    const res = await up.upload(clip());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('network');
    expect(queuedToasts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildOfflineForm — the drained /upload contract
// ---------------------------------------------------------------------------

describe('buildOfflineForm', () => {
  test('posts source=offline + the ORIGINAL recordedAt + durationMs + audio', () => {
    const fd = buildOfflineForm(queuedItem());
    expect(fd.get('source')).toBe('offline');
    expect(fd.get('recordedAt')).toBe('1700000111000');
    expect(fd.get('durationMs')).toBe('4200');
    const f = fd.get('audio') as File;
    expect(f).toBeInstanceOf(Blob);
    expect(f.name).toBe('clip.m4a'); // extension follows the stored mime
    expect(fd.has('presetId')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createOfflineSync.drain()
// ---------------------------------------------------------------------------

describe('offline drain', () => {
  test('uploads queued items oldest-first and removes each ONLY on 2xx', async () => {
    const q = fakeQueue([
      queuedItem({ localId: 'b', recordedAt: 2000 }),
      queuedItem({ localId: 'a', recordedAt: 1000 }),
    ]);
    const sent: string[] = [];
    const send: SendFn = async (form) => {
      sent.push(String(form.get('recordedAt')));
      return { ok: true, status: 200, text: 'ok' };
    };
    const sync = createOfflineSync({ queue: q, send });

    const r = await sync.drain();
    expect(r).toEqual({ uploaded: 2, remaining: 0 });
    expect(sent).toEqual(['1000', '2000']); // oldest first
    expect(q.items.size).toBe(0);
    expect(await sync.hasItems()).toBe(false);
  });

  test('non-2xx response → item KEPT, drain stops', async () => {
    const q = fakeQueue([
      queuedItem({ localId: 'a', recordedAt: 1000 }),
      queuedItem({ localId: 'b', recordedAt: 2000 }),
    ]);
    let calls = 0;
    const send: SendFn = async () => {
      calls++;
      return { ok: false, status: 500, text: 'boom' };
    };
    const sync = createOfflineSync({ queue: q, send });

    const r = await sync.drain();
    expect(r).toEqual({ uploaded: 0, remaining: 2 });
    expect(calls).toBe(1); // stopped at the first failure
    expect(q.items.size).toBe(2);
    expect(await sync.hasItems()).toBe(true);
  });

  test('transport throw → item KEPT, drain stops, next drain retries', async () => {
    const q = fakeQueue([queuedItem({ localId: 'a' })]);
    let online = false;
    const send: SendFn = async () => {
      if (!online) throw new Error('offline');
      return { ok: true, status: 200, text: 'ok' };
    };
    const sync = createOfflineSync({ queue: q, send });

    expect(await sync.drain()).toEqual({ uploaded: 0, remaining: 1 });
    expect(q.items.size).toBe(1);

    online = true; // the `online` event / 60s retry fires drain again
    expect(await sync.drain()).toEqual({ uploaded: 1, remaining: 0 });
    expect(q.items.size).toBe(0);
  });

  test('partial drain: first ok, second fails → only first removed', async () => {
    const q = fakeQueue([
      queuedItem({ localId: 'a', recordedAt: 1000 }),
      queuedItem({ localId: 'b', recordedAt: 2000 }),
    ]);
    let calls = 0;
    const send: SendFn = async () => {
      calls++;
      if (calls === 1) return { ok: true, status: 200, text: 'ok' };
      throw new Error('net died mid-drain');
    };
    const sync = createOfflineSync({ queue: q, send });

    const r = await sync.drain();
    expect(r).toEqual({ uploaded: 1, remaining: 1 });
    expect([...q.items.keys()]).toEqual(['b']);
  });

  test('concurrent drain triggers share one in-flight drain — no double upload', async () => {
    const q = fakeQueue([queuedItem({ localId: 'a' })]);
    let sends = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send: SendFn = async () => {
      sends++;
      await gate; // hold the drain in flight while more triggers arrive
      return { ok: true, status: 200, text: 'ok' };
    };
    const sync = createOfflineSync({ queue: q, send });

    // four triggers land at once: app init + online event + post-upload + 60s timer
    const p1 = sync.drain();
    const p2 = sync.drain();
    const p3 = sync.drain();
    const p4 = sync.drain();
    expect(p2).toBe(p1); // literally the same promise
    release();
    const results = await Promise.all([p1, p2, p3, p4]);
    expect(sends).toBe(1); // the item went up exactly once
    for (const r of results) expect(r).toEqual({ uploaded: 1, remaining: 0 });
    expect(q.items.size).toBe(0);
  });

  test('a NEW drain is possible after the previous one settles', async () => {
    const q = fakeQueue([queuedItem({ localId: 'a' })]);
    let sends = 0;
    const send: SendFn = async () => {
      sends++;
      return { ok: true, status: 200, text: 'ok' };
    };
    const sync = createOfflineSync({ queue: q, send });

    await sync.drain();
    expect(sends).toBe(1);
    await q.put(queuedItem({ localId: 'b' }));
    await sync.drain(); // not stuck on the settled single-flight guard
    expect(sends).toBe(2);
    expect(q.items.size).toBe(0);
  });

  test('drain on an empty queue is a no-op', async () => {
    const q = fakeQueue();
    let sends = 0;
    const sync = createOfflineSync({
      queue: q,
      send: async () => {
        sends++;
        return { ok: true, status: 200, text: 'ok' };
      },
    });
    expect(await sync.drain()).toEqual({ uploaded: 0, remaining: 0 });
    expect(sends).toBe(0);
  });
});
