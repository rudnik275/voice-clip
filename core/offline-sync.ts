// ---- Offline upload queue: port + drain controller + uploader fallback ----
//
// Restores the pre-Vue offline protocol (issue #140, CLAUDE.md "Offline
// protocol"): when the online upload ultimately fails with a TRANSPORT error
// (fetch threw — offline, DNS, connection reset), the clip is persisted to a
// queue and drained later with `source=offline` + the ORIGINAL `recordedAt`.
// The server inserts history only for offline clips (enforced by #128), so a
// drained stale clip can never clobber the user's current clipboard.
//
// Framework-agnostic: this module depends only on the ports/helpers in core.
// The browser IndexedDB implementation of `OfflineQueue` lives in the web
// layer (web/src/offline-queue-idb.ts); tests use an in-memory fake.
//
// What is and is NOT enqueued:
//   * `reason: 'network'` (fetch threw on every retry)  → enqueued.
//   * 4xx server rejection (`reason: 'server'`, status < 500) → REAL error,
//     NOT enqueued — the server saw the clip and refused it; retrying the
//     same bytes later would fail the same way.
//   * 5xx after retries → NOT enqueued (the server received the audio; this
//     mirrors the pre-rewrite app, which only queued on fetch failure).
//   * gate rejection (`reason: 'rejected'`, too short/quiet) → NOT enqueued.

import type { RecordedClip, Uploader, UploadResult } from './ports';
import { buildUploadForm, type SendFn } from './uploader';

/**
 * A queued clip — everything `/upload` needs, minus the metering stats (the
 * clip already passed the gate before its online attempt; we never re-gate).
 * `localId` is the IndexedDB key (DB `voice-clip`, store `queue`).
 */
export type QueuedClip = {
  localId: string;
  blob: Blob;
  mime: string;
  /** original recording time (epoch ms) — preserved across the drain. */
  recordedAt: number;
  durationMs: number;
};

/**
 * OfflineQueue — the storage port. The web layer implements it over raw
 * IndexedDB; tests pass an in-memory fake. All methods are async because
 * IndexedDB is.
 */
export interface OfflineQueue {
  put(item: QueuedClip): Promise<void>;
  /** All queued items, oldest first (recordedAt ascending). */
  list(): Promise<QueuedClip[]>;
  delete(localId: string): Promise<void>;
}

export type DrainResult = {
  /** items removed from the queue this drain (got a 2xx). */
  uploaded: number;
  /** items still queued after this drain. */
  remaining: number;
};

export type OfflineSync = {
  /** Persist a clip that failed its online upload with a transport error. */
  enqueue(clip: RecordedClip): Promise<void>;
  /**
   * Upload queued items oldest-first with `source=offline` + the original
   * `recordedAt`. An item is deleted ONLY after a 2xx; the first failure
   * stops the drain (the next trigger retries). Concurrent calls share a
   * single in-flight drain — no double-uploads.
   */
  drain(): Promise<DrainResult>;
  /** Is anything queued? (used to decide whether to keep the 60s retry alive) */
  hasItems(): Promise<boolean>;
};

export type OfflineSyncOptions = {
  queue: OfflineQueue;
  /** Same transport seam as the uploader (the real one wraps fetch('/upload')). */
  send: SendFn;
  /** Injectable id generator for tests. */
  newId?: () => string;
};

const defaultNewId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Build the /upload form for a drained item: source=offline, original recordedAt. */
export function buildOfflineForm(item: QueuedClip): FormData {
  // Reuse buildUploadForm so the multipart contract stays single-sourced.
  // The stats are a dummy — they only feed the pre-upload gate, never the form.
  const clip: RecordedClip = {
    blob: item.blob,
    mime: item.mime,
    durationMs: item.durationMs,
    recordedAt: item.recordedAt,
    stats: { avgRms: 1, voiceFraction: 1, peakLevel: 1 },
    source: 'offline',
  };
  return buildUploadForm(clip);
}

export function createOfflineSync(opts: OfflineSyncOptions): OfflineSync {
  const newId = opts.newId ?? defaultNewId;
  let draining: Promise<DrainResult> | null = null;

  async function doDrain(): Promise<DrainResult> {
    const items = (await opts.queue.list()).slice().sort((a, b) => a.recordedAt - b.recordedAt);
    let uploaded = 0;
    for (const item of items) {
      try {
        const res = await opts.send(buildOfflineForm(item));
        if (!res.ok) break; // still failing — stop, retry on the next trigger
        await opts.queue.delete(item.localId); // remove ONLY on 2xx
        uploaded++;
      } catch {
        break; // transport still down — stop, retry on the next trigger
      }
    }
    return { uploaded, remaining: items.length - uploaded };
  }

  return {
    async enqueue(clip: RecordedClip): Promise<void> {
      await opts.queue.put({
        localId: newId(),
        blob: clip.blob,
        mime: clip.mime,
        recordedAt: clip.recordedAt,
        durationMs: clip.durationMs,
      });
    },

    drain(): Promise<DrainResult> {
      // single-flight guard: every concurrent trigger shares one drain
      if (draining) return draining;
      draining = doDrain().finally(() => {
        draining = null;
      });
      return draining;
    },

    async hasItems(): Promise<boolean> {
      return (await opts.queue.list()).length > 0;
    },
  };
}

/**
 * Wrap an Uploader with the offline fallback: when the inner upload fails with
 * a TRANSPORT error, persist the clip and report success to the recorder
 * machine (`{ ok: true, text: '' }`) so it returns to idle instead of `error`
 * — the clip is safe, not lost. `onQueued` lets the UI swap the success toast
 * for an honest "saved offline" one (see the recorder store).
 *
 * If enqueueing itself fails (e.g. IndexedDB unavailable in private mode),
 * the original failure is returned — never fake success for a lost clip.
 */
export function withOfflineFallback(
  base: Uploader,
  sync: Pick<OfflineSync, 'enqueue'>,
  onQueued?: () => void,
): Uploader {
  return {
    async upload(clip: RecordedClip): Promise<UploadResult> {
      const res = await base.upload(clip);
      if (!res.ok && res.reason === 'network') {
        try {
          await sync.enqueue(clip);
        } catch {
          return res; // queue write failed — surface the real error
        }
        onQueued?.();
        return { ok: true, text: '' };
      }
      return res;
    },
  };
}
