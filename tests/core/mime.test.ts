import { test, expect, describe } from 'bun:test';
import { pickRecorderMime, extForMime, MIME_CANDIDATES } from '../../core/mime';

describe('pickRecorderMime (invariant 4)', () => {
  test('Safari → audio/mp4 (webm unsupported)', () => {
    const safari = (m: string) => m === 'audio/mp4';
    expect(pickRecorderMime(safari)).toBe('audio/mp4');
  });

  test('Chromium → audio/webm;codecs=opus (mp4 unsupported)', () => {
    const chromium = (m: string) => m.startsWith('audio/webm');
    expect(pickRecorderMime(chromium)).toBe('audio/webm;codecs=opus');
  });

  test('plain webm fallback when opus codec not advertised', () => {
    const onlyPlainWebm = (m: string) => m === 'audio/webm';
    expect(pickRecorderMime(onlyPlainWebm)).toBe('audio/webm');
  });

  test('mp4 wins over webm when both supported (preference order)', () => {
    const both = () => true;
    expect(pickRecorderMime(both)).toBe('audio/mp4');
    expect(pickRecorderMime(both)).toBe(MIME_CANDIDATES[0]);
  });

  test('returns empty string when nothing supported', () => {
    expect(pickRecorderMime(() => false)).toBe('');
  });
});

describe('extForMime', () => {
  test('mp4 → m4a', () => {
    expect(extForMime('audio/mp4')).toBe('m4a');
  });
  test('webm (with codecs) → webm', () => {
    expect(extForMime('audio/webm;codecs=opus')).toBe('webm');
  });
  test('ogg → ogg', () => {
    expect(extForMime('audio/ogg')).toBe('ogg');
  });
  test('unknown / empty → bin', () => {
    expect(extForMime('')).toBe('bin');
    expect(extForMime('audio/flac')).toBe('bin');
  });
});
