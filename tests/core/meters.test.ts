import { test, expect, describe } from 'bun:test';
import {
  rms,
  peak,
  bytesToFloat,
  Meter,
  smoothLevel,
  levelTarget,
  isDeadMic,
  isTooQuiet,
  isTooShort,
  RMS_DEAD_MIC,
  RMS_SILENCE,
  VOICE_RMS_THRESH,
  VOICE_FRACTION_MIN,
  MIN_DURATION_MS,
} from '../../core/meters';

describe('rms', () => {
  test('empty frame is 0', () => {
    expect(rms([])).toBe(0);
  });

  test('silence is 0', () => {
    expect(rms([0, 0, 0, 0])).toBe(0);
  });

  test('constant amplitude equals that amplitude', () => {
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5, 10);
  });

  test('matches sqrt(mean(square))', () => {
    const frame = [0.1, -0.2, 0.3, -0.4];
    const expected = Math.sqrt((0.01 + 0.04 + 0.09 + 0.16) / 4);
    expect(rms(frame)).toBeCloseTo(expected, 10);
  });
});

describe('peak', () => {
  test('empty frame is 0', () => {
    expect(peak([])).toBe(0);
  });

  test('returns max absolute value', () => {
    expect(peak([0.1, -0.9, 0.3])).toBeCloseTo(0.9, 10);
  });
});

describe('bytesToFloat', () => {
  test('128 maps to 0 (centre)', () => {
    expect(Array.from(bytesToFloat([128]))).toEqual([0]);
  });

  test('255 and 0 map near +1 / -1', () => {
    const f = bytesToFloat([255, 0]);
    expect(f[0]).toBeCloseTo(0.9921875, 6);
    expect(f[1]).toBeCloseTo(-1, 6);
  });
});

describe('Meter', () => {
  test('summary of no frames is all zero', () => {
    const m = new Meter();
    expect(m.summary()).toEqual({ avgRms: 0, voiceFraction: 0, peakLevel: 0 });
    expect(m.frameCount).toBe(0);
  });

  test('counts voice frames above threshold', () => {
    const m = new Meter();
    // one loud frame (rms 0.5 >= 0.04), one silent frame
    m.push([0.5, -0.5]);
    m.push([0, 0]);
    expect(m.frameCount).toBe(2);
    const s = m.summary();
    expect(s.voiceFraction).toBeCloseTo(0.5, 10);
    expect(s.peakLevel).toBeCloseTo(0.5, 10);
    expect(s.avgRms).toBeCloseTo(Math.sqrt((0.25 + 0) / 2), 10);
  });

  test('all-quiet frames give voiceFraction 0', () => {
    const m = new Meter();
    m.push([0.001, -0.001]);
    m.push([0.001, -0.001]);
    expect(m.summary().voiceFraction).toBe(0);
  });
});

describe('smoothing', () => {
  test('smoothLevel moves toward target by alpha', () => {
    expect(smoothLevel(0, 1, 0.16)).toBeCloseTo(0.16, 10);
    expect(smoothLevel(0.5, 0.5, 0.16)).toBeCloseTo(0.5, 10);
  });

  test('levelTarget caps at 1 and scales by 3.2 (matches web/app.ts)', () => {
    expect(levelTarget(0)).toBe(0);
    expect(levelTarget(0.1)).toBeCloseTo(0.32, 10);
    expect(levelTarget(0.3125)).toBe(1);
    expect(levelTarget(5)).toBe(1);
  });
});

describe('clip gates', () => {
  test('isDeadMic uses RMS_DEAD_MIC threshold', () => {
    expect(isDeadMic(RMS_DEAD_MIC - 0.0001)).toBe(true);
    expect(isDeadMic(RMS_DEAD_MIC)).toBe(false);
    expect(isDeadMic(0.5)).toBe(false);
  });

  test('isTooQuiet trips on low rms OR low voice fraction', () => {
    // low rms
    expect(isTooQuiet({ avgRms: RMS_SILENCE - 0.001, voiceFraction: 1 })).toBe(true);
    // low voice fraction
    expect(isTooQuiet({ avgRms: 0.5, voiceFraction: VOICE_FRACTION_MIN - 0.001 })).toBe(true);
    // clearly fine
    expect(isTooQuiet({ avgRms: 0.5, voiceFraction: 0.5 })).toBe(false);
  });

  test('isTooShort uses MIN_DURATION_MS', () => {
    expect(isTooShort(MIN_DURATION_MS - 1)).toBe(true);
    expect(isTooShort(MIN_DURATION_MS)).toBe(false);
    expect(isTooShort(5000)).toBe(false);
  });

  test('thresholds keep their documented values', () => {
    expect(RMS_DEAD_MIC).toBe(0.002);
    expect(RMS_SILENCE).toBe(0.025);
    expect(VOICE_RMS_THRESH).toBe(0.04);
    expect(VOICE_FRACTION_MIN).toBe(0.08);
    expect(MIN_DURATION_MS).toBe(350);
  });
});
