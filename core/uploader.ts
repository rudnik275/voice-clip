// ---- Uploader port implementation ----
//
// Two responsibilities, both pure-ish and unit-tested with a fake `send`:
//   1. GATE — reject clips that are too short / too quiet before they ever hit
//      the wire (saves a round-trip and a useless transcription cost).
//   2. RETRY — exponential backoff on transient failures (network throw, 5xx).
//      4xx is a permanent client error and is NOT retried.
//
// The /upload contract is unchanged: multipart form with `audio`, `source`,
// `recordedAt`, `durationMs`. The client does NOT send `presetId` — server-side
// preset application is independent of this request (issue #101 / #98).
//
// No DOM globals beyond FormData/Blob/File (web standards, available in Bun's
// test runtime); the actual fetch lives behind the injectable `send`.

import type { RecordedClip, Uploader, UploadResult } from './ports';
import { extForMime } from './mime';
import { isTooShort, isTooQuiet } from './meters';

/** Raw response shape the transport must report back. */
export type SendResult = { ok: boolean; status: number; text: string };

/**
 * Transport seam: send a built multipart body, resolve with the raw result, or
 * throw on a network-level failure (offline, DNS, connection reset). The real
 * adapter wraps `fetch('/upload', …)`; tests pass a fake.
 */
export type SendFn = (form: FormData) => Promise<SendResult>;

export type UploaderOptions = {
  send: SendFn;
  /** Total attempts (not "extra" retries). Default 3. */
  maxRetries?: number;
  /** First backoff delay in ms; doubles each retry. Default 500. */
  baseDelayMs?: number;
  /** Injectable sleep so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Build the /upload multipart body. Exported for the form-contract tests and
 * for reuse by any offline-queue drainer.
 */
export function buildUploadForm(clip: RecordedClip): FormData {
  const fd = new FormData();
  const ext = extForMime(clip.mime);
  fd.append('audio', clip.blob, `clip.${ext}`);
  fd.append('source', clip.source ?? 'online');
  fd.append('recordedAt', String(clip.recordedAt));
  fd.append('durationMs', String(clip.durationMs));
  // NOTE: deliberately NO presetId — see issue #101 acceptance criteria.
  return fd;
}

/** Should this clip be allowed onto the wire at all? */
export function passesGate(clip: RecordedClip): boolean {
  if (isTooShort(clip.durationMs)) return false;
  if (isTooQuiet(clip.stats)) return false;
  return true;
}

export function createUploader(opts: UploaderOptions): Uploader {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;

  return {
    async upload(clip: RecordedClip): Promise<UploadResult> {
      if (!passesGate(clip)) {
        return { ok: false, reason: 'rejected', message: 'clip too short or too quiet' };
      }

      let lastErr: UploadResult = {
        ok: false,
        reason: 'network',
        message: 'no attempts made',
      };

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (attempt > 0) {
          // exponential backoff: base, base*2, base*4, …
          await sleep(baseDelayMs * 2 ** (attempt - 1));
        }
        // Rebuild the form each attempt — a consumed/streamed body can't be reused.
        const form = buildUploadForm(clip);
        try {
          const res = await opts.send(form);
          if (res.ok) {
            return { ok: true, text: res.text };
          }
          if (res.status >= 400 && res.status < 500) {
            // permanent client error — do not retry
            return { ok: false, reason: 'server', status: res.status, message: res.text };
          }
          // 5xx (or other non-ok): transient, keep retrying
          lastErr = { ok: false, reason: 'server', status: res.status, message: res.text };
        } catch (err) {
          lastErr = {
            ok: false,
            reason: 'network',
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }

      return lastErr;
    },
  };
}
