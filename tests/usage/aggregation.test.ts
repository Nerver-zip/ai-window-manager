import { describe, expect, it } from 'vitest';
import {
  aggregateDailyUsage,
  transitionUsageSample,
  WEEK_SECONDS,
  type UsageSampleInput,
  type UsageSeriesState,
} from '../../src/usage/aggregation.js';
import { resolveLocalOccurrenceOnDate } from '../../src/scheduler/time.js';

const minute = 60_000;
const origin = Date.parse('2026-09-20T10:00:00.000Z');

function sample(
  id: number,
  usage: number,
  offsetMinutes: number,
  overrides: Partial<UsageSampleInput> = {},
): UsageSampleInput {
  const observedAtMs = origin + offsetMinutes * minute;
  return {
    id,
    providerId: 'codex',
    windowKind: 'codex_weekly',
    observedAtMs,
    durationSeconds: WEEK_SECONDS,
    durationConfidence: 'exact',
    resetAtMs: origin + 7 * 24 * 60 * minute,
    resetConfidence: 'exact',
    usageRatio: usage,
    usageConfidence: 'exact',
    usageObservedAtMs: observedAtMs,
    ...overrides,
  };
}

function stateFor(input: UsageSampleInput): UsageSeriesState {
  return {
    version: 1,
    lastSampleId: input.id,
    lastObservedAtMs: input.observedAtMs,
    lastUsageRatio: input.usageRatio!,
    highWaterRatio: input.usageRatio!,
    durationSeconds: WEEK_SECONDS,
    resetAtMs: input.resetAtMs,
  };
}

describe('weekly usage deltas', () => {
  it('starts with a baseline, then counts positive cumulative changes once', () => {
    const first = sample(1, 0.2, 0);
    const baseline = transitionUsageSample(null, first);
    const second = transitionUsageSample(baseline.state, sample(2, 0.25, 5));
    const third = transitionUsageSample(second.state, sample(3, 0.31, 10));
    expect(baseline.interval).toBeUndefined();
    expect(second.interval?.usageDeltaRatio).toBeCloseTo(0.05);
    expect(third.interval?.usageDeltaRatio).toBeCloseTo(0.06);
    expect(
      (second.interval!.usageDeltaRatio! + third.interval!.usageDeltaRatio!) * 100,
    ).toBeCloseTo(11);
  });

  it('does not infer consumption from the first observation', () => {
    const result = transitionUsageSample(null, sample(1, 0.69, 0));
    expect(result.state?.highWaterRatio).toBe(0.69);
    expect(result.interval).toBeUndefined();
  });

  it('keeps the high-water mark across a counter correction', () => {
    const first = sample(1, 0.4, 0);
    const second = transitionUsageSample(stateFor(first), sample(2, 0.35, 5));
    const third = transitionUsageSample(second.state, sample(3, 0.4, 10));
    const fourth = transitionUsageSample(third.state, sample(4, 0.43, 15));
    expect(second.interval).toMatchObject({
      usageDeltaRatio: 0,
      quality: 'partial',
      reasonCode: 'COUNTER_CORRECTION',
    });
    expect(third.interval?.usageDeltaRatio).toBe(0);
    expect(fourth.interval?.usageDeltaRatio).toBeCloseTo(0.03);
  });

  it('preserves the old cycle and counts only observed usage after a proven weekly reset', () => {
    const oldReset = origin + 60 * minute;
    const prior = sample(1, 0.95, 0, { resetAtMs: oldReset });
    const currentTime = oldReset + 5 * minute;
    const next = sample(2, 0.02, 65, {
      observedAtMs: currentTime,
      usageObservedAtMs: currentTime,
      resetAtMs: oldReset + WEEK_SECONDS * 1000,
    });
    const after = sample(3, 0.06, 70, {
      observedAtMs: currentTime + 5 * minute,
      usageObservedAtMs: currentTime + 5 * minute,
      resetAtMs: oldReset + WEEK_SECONDS * 1000,
    });
    const transition = transitionUsageSample(stateFor(prior), next);
    const continued = transitionUsageSample(transition.state, after);
    expect(transition.interval).toMatchObject({
      usageDeltaRatio: 0.02,
      quality: 'partial',
      reasonCode: 'WEEKLY_RESET_CONFIRMED',
    });
    expect(continued.interval?.usageDeltaRatio).toBeCloseTo(0.04);
    expect(
      (0.05 + transition.interval!.usageDeltaRatio! + continued.interval!.usageDeltaRatio!) * 100,
    ).toBeCloseTo(11);
  });

  it('does not treat a moving future reset as a new cycle', () => {
    const prior = sample(1, 0.1, 0);
    const moved = sample(2, 0.1, 5, { resetAtMs: origin + 8 * 24 * 60 * minute });
    const result = transitionUsageSample(stateFor(prior), moved);
    expect(result.interval?.usageDeltaRatio).toBe(0);
    expect(result.interval?.reasonCode).toBeNull();
    expect(result.state?.highWaterRatio).toBe(0.1);
  });

  it('requires a trusted future reset boundary and falls back to the previous weekly duration', () => {
    const prior = sample(1, 0.2, 0);
    const previous = stateFor(prior);
    const cases: Array<Partial<UsageSampleInput>> = [
      { resetAtMs: null, resetConfidence: null },
      { resetConfidence: 'low' },
      { resetAtMs: origin + 5 * minute, resetConfidence: 'exact' },
      { resetAtMs: origin + 4 * minute, resetConfidence: 'exact' },
      { resetAtMs: origin + 8 * 24 * 60 * minute, resetConfidence: 'high' },
    ];
    for (const reset of cases) {
      const current = sample(2, 0.25, 5, {
        durationSeconds: null,
        durationConfidence: null,
        ...reset,
      });
      const interval = transitionUsageSample(previous, current).interval;
      expect(interval?.usageDeltaRatio).toBeCloseTo(0.05);
      expect(interval?.reasonCode).toBeNull();
    }

    const highConfidence = sample(3, 0.2, 10, {
      durationConfidence: 'high',
      usageConfidence: 'high',
      resetConfidence: 'high',
    });
    expect(transitionUsageSample(null, highConfidence).state?.resetAtMs).toBe(
      highConfidence.resetAtMs,
    );
  });

  it('rejects an invalid first reading and conflicting timestamps without advancing state', () => {
    const invalid = transitionUsageSample(
      null,
      sample(1, 0.2, 0, { usageObservedAtMs: origin - 20 * minute }),
    );
    expect(invalid.state).toBeNull();
    expect(invalid.interval).toBeUndefined();

    const prior = sample(2, 0.2, 0);
    const conflict = transitionUsageSample(
      stateFor(prior),
      sample(3, 0.3, 5, {
        observedAtMs: prior.observedAtMs,
        usageObservedAtMs: prior.observedAtMs,
      }),
    );
    expect(conflict.state).toEqual(stateFor(prior));
    expect(conflict.interval?.reasonCode).toBe('CONFLICTING_SAMPLE_TIMESTAMP');
  });

  it('marks only gaps longer than the interpolation limit as partial and keeps the last reset', () => {
    const prior = sample(1, 0.2, 0);
    const boundary = transitionUsageSample(
      stateFor(prior),
      sample(2, 0.21, 15, { resetAtMs: null, resetConfidence: null }),
    );
    expect(boundary.interval?.quality).toBe('observed');
    expect(boundary.state?.resetAtMs).toBe(prior.resetAtMs);

    const afterLimit = transitionUsageSample(
      boundary.state,
      sample(3, 0.22, 30.01, { resetAtMs: null, resetConfidence: null }),
    );
    expect(afterLimit.interval).toMatchObject({
      quality: 'partial',
      reasonCode: 'OBSERVATION_GAP',
    });
  });

  it('does not invent missing weekly cycles after an outage spanning multiple weeks', () => {
    const oldReset = origin + 10 * minute;
    const prior = sample(1, 0.8, 0, { resetAtMs: oldReset });
    const afterManyWeeks = oldReset + 3 * WEEK_SECONDS * 1000;
    const current = sample(2, 0.04, 0, {
      observedAtMs: afterManyWeeks,
      usageObservedAtMs: afterManyWeeks,
      resetAtMs: afterManyWeeks + WEEK_SECONDS * 1000,
    });
    expect(transitionUsageSample(stateFor(prior), current).interval).toMatchObject({
      usageDeltaRatio: null,
      quality: 'unknown',
      reasonCode: 'MULTIPLE_CYCLES_UNOBSERVED',
    });
  });

  it('uses known weekly duration only and rejects stale, low-confidence and out-of-order usage', () => {
    expect(
      transitionUsageSample(null, sample(1, 0.2, 0, { durationSeconds: 18_000 })).state,
    ).toBeNull();
    const prior = sample(1, 0.2, 0);
    const stale = sample(2, 0.3, 5, { usageObservedAtMs: origin - 20 * minute });
    expect(transitionUsageSample(stateFor(prior), stale).interval?.reasonCode).toBe(
      'WEEKLY_USAGE_UNAVAILABLE',
    );
    const low = sample(3, 0.3, 5, { usageConfidence: 'low' });
    expect(transitionUsageSample(stateFor(prior), low).interval?.usageDeltaRatio).toBeNull();
    const late = sample(4, 0.3, -5);
    expect(transitionUsageSample(stateFor(prior), late).interval?.reasonCode).toBe(
      'OUT_OF_ORDER_SAMPLE',
    );
  });
});

describe('daily local-calendar projection', () => {
  it('splits a short observed delta proportionally across midnight without changing its sum', () => {
    const midnight = resolveLocalOccurrenceOnDate({
      localDate: '2026-09-20',
      localTime: '00:00',
      timeZone: 'America/Sao_Paulo',
    }).instant.getTime();
    const cells = aggregateDailyUsage({
      intervals: [
        {
          fromMs: midnight - 2 * minute,
          toMs: midnight + 2 * minute,
          usageDeltaRatio: 0.04,
          quality: 'observed',
          reasonCode: null,
        },
      ],
      fromLocalDate: '2026-09-19',
      toLocalDate: '2026-09-20',
      timeZone: 'America/Sao_Paulo',
      nowMs: midnight + 4 * minute,
    });
    expect(cells[0]?.usagePercentagePoints).toBeCloseTo(2);
    expect(cells[1]?.usagePercentagePoints).toBeCloseTo(2);
    expect(cells.reduce((sum, cell) => sum + (cell.usagePercentagePoints ?? 0), 0)).toBeCloseTo(4);
    expect(cells.every((cell) => cell.status === 'partial')).toBe(true);
  });

  it('uses the real 23-hour and 25-hour lengths of DST calendar days', () => {
    const spring = aggregateDailyUsage({
      intervals: [],
      fromLocalDate: '2026-03-08',
      toLocalDate: '2026-03-08',
      timeZone: 'America/New_York',
      nowMs: Date.parse('2026-03-09T12:00:00Z'),
    })[0]!;
    const fall = aggregateDailyUsage({
      intervals: [],
      fromLocalDate: '2026-11-01',
      toLocalDate: '2026-11-01',
      timeZone: 'America/New_York',
      nowMs: Date.parse('2026-11-02T12:00:00Z'),
    })[0]!;
    expect(spring.daySeconds).toBe(23 * 60 * 60);
    expect(fall.daySeconds).toBe(25 * 60 * 60);
  });

  it('resolves a skipped local midnight and keeps the following local day boundary', () => {
    const cells = aggregateDailyUsage({
      intervals: [],
      fromLocalDate: '2018-11-04',
      toLocalDate: '2018-11-04',
      timeZone: 'America/Sao_Paulo',
      nowMs: Date.parse('2018-11-05T12:00:00Z'),
    });
    expect(cells[0]?.daySeconds).toBe(23 * 60 * 60);
  });

  it('keeps gaps unknown and distinguishes missing data from zero observed', () => {
    const day = resolveLocalOccurrenceOnDate({
      localDate: '2026-09-20',
      localTime: '00:00',
      timeZone: 'UTC',
    }).instant.getTime();
    const cells = aggregateDailyUsage({
      intervals: [
        {
          fromMs: day + minute,
          toMs: day + 2 * minute,
          usageDeltaRatio: 0,
          quality: 'observed',
          reasonCode: null,
        },
        {
          fromMs: day + 2 * minute,
          toMs: day + 3 * minute,
          usageDeltaRatio: null,
          quality: 'unknown',
          reasonCode: 'OUT_OF_ORDER_SAMPLE',
        },
      ],
      fromLocalDate: '2026-09-20',
      toLocalDate: '2026-09-21',
      timeZone: 'UTC',
      nowMs: day + 10 * minute,
    });
    expect(cells[0]).toMatchObject({ usagePercentagePoints: 0, status: 'partial' });
    expect(cells[0]?.reasons).toContain('OUT_OF_ORDER_SAMPLE');
    expect(cells[1]).toMatchObject({ usagePercentagePoints: null, status: 'no_data' });
  });

  it('distinguishes full historical coverage, partial amounts and unassigned multi-day gaps', () => {
    const dayStart = Date.parse('2026-09-20T00:00:00.000Z');
    const nextDay = dayStart + 24 * 60 * minute;
    const cells = aggregateDailyUsage({
      intervals: [
        {
          fromMs: dayStart + minute,
          toMs: nextDay - minute,
          usageDeltaRatio: 0.1,
          quality: 'observed',
          reasonCode: null,
        },
        {
          fromMs: nextDay + minute,
          toMs: nextDay + 2 * minute,
          usageDeltaRatio: 0.02,
          quality: 'partial',
          reasonCode: 'COUNTER_CORRECTION',
        },
        {
          fromMs: nextDay + 23 * 60 * minute,
          toMs: nextDay + 25 * 60 * minute,
          usageDeltaRatio: 0.03,
          quality: 'partial',
          reasonCode: 'OBSERVATION_GAP',
        },
        {
          fromMs: dayStart - 2 * 24 * 60 * minute,
          toMs: dayStart - 24 * 60 * minute,
          usageDeltaRatio: null,
          quality: 'unknown',
          reasonCode: null,
        },
        {
          fromMs: nextDay + 24 * 60 * minute + 5 * minute,
          toMs: nextDay + 24 * 60 * minute + 6 * minute,
          usageDeltaRatio: null,
          quality: 'unknown',
          reasonCode: null,
        },
        {
          fromMs: nextDay + 47 * 60 * minute,
          toMs: nextDay + 49 * 60 * minute,
          usageDeltaRatio: 0.01,
          quality: 'partial',
          reasonCode: 'OUTSIDE_PROJECTION',
        },
      ],
      fromLocalDate: '2026-09-20',
      toLocalDate: '2026-09-22',
      timeZone: 'UTC',
      nowMs: nextDay + 24 * 60 * minute + 26 * minute,
    });
    expect(cells[0]).toMatchObject({ status: 'observed', usagePercentagePoints: 10 });
    expect(cells[1]).toMatchObject({ status: 'partial', usagePercentagePoints: 2 });
    expect(cells[1]?.reasons).toContain('OBSERVATION_GAP');
    expect(cells[1]?.reasons).toContain('COUNTER_CORRECTION');
  });

  it('returns no data for future dates and rejects malformed dates or timezones', () => {
    const future = aggregateDailyUsage({
      intervals: [],
      fromLocalDate: '2026-09-21',
      toLocalDate: '2026-09-21',
      timeZone: 'UTC',
      nowMs: Date.parse('2026-09-20T12:00:00Z'),
    });
    expect(future[0]).toMatchObject({ status: 'no_data', daySeconds: 0 });
    expect(() =>
      aggregateDailyUsage({
        intervals: [],
        fromLocalDate: '2026-02-30',
        toLocalDate: '2026-02-30',
        timeZone: 'UTC',
        nowMs: origin,
      }),
    ).toThrow('valid calendar date');
    expect(() =>
      aggregateDailyUsage({
        intervals: [],
        fromLocalDate: '2026-09-20',
        toLocalDate: '2026-09-20',
        timeZone: 'Not/A_Timezone',
        nowMs: origin,
      }),
    ).toThrow();
  });
});
