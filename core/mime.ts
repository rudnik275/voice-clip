// ---- pure mime selection ----
//
// invariant 4: pick the recorder container via isTypeSupported. Safari supports
// audio/mp4; Chromium/Firefox support audio/webm;codecs=opus. We probe in
// preference order and take the first supported. The probe function is injected
// so this is testable without a real MediaRecorder.

/** Returns true if MediaRecorder can produce the given mime type. */
export type IsTypeSupported = (mime: string) => boolean;

/**
 * Candidate containers in preference order. mp4 first so Safari (which reports
 * webm unsupported) lands on mp4; Chromium/Firefox skip it and take opus.
 *
 * NOTE: OpenAI's transcription API decodes by filename extension, so the
 * chosen mime must round-trip through extForMime to a correct extension —
 * labelling iOS mp4 bytes as ".webm" makes the API reject them (502).
 */
export const MIME_CANDIDATES = [
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
] as const;

/**
 * Pick the first supported recorder mime. Returns '' if none match — callers
 * pass `''` to MediaRecorder which then uses the browser default.
 */
export function pickRecorderMime(isSupported: IsTypeSupported): string {
  for (const c of MIME_CANDIDATES) {
    if (isSupported(c)) return c;
  }
  return '';
}

/** Map a mime type to the file extension used in the /upload form field. */
export function extForMime(mime: string): string {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg')) return 'mp3';
  return 'bin';
}
