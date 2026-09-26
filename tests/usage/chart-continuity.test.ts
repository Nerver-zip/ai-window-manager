import { describe, expect, it } from 'vitest';
import { chartContinuityGapMs } from '../../src/usage/chart-continuity.js';

describe('Usage chart continuity', () => {
  it.each([
    [30, 30, 120_000],
    [60, 30, 210_000],
    [300, 30, 930_000],
    [30, 60, 240_000],
  ])('allows polling %is and reconcile %is for %ims', (poll, reconcile, expected) => {
    expect(chartContinuityGapMs(poll, reconcile)).toBe(expected);
  });

  it('rejects invalid cadence and unsafe millisecond arithmetic', () => {
    expect(() => chartContinuityGapMs(0, 30)).toThrow(RangeError);
    expect(() => chartContinuityGapMs(30, Number.NaN)).toThrow(RangeError);
    expect(() => chartContinuityGapMs(Number.MAX_SAFE_INTEGER, 30)).toThrow(RangeError);
  });
});
