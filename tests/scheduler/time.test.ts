import { describe, expect, it } from 'vitest';
import {
  compareWallAndMonotonicElapsed,
  resolveLocalOccurrence,
  type LocalOccurrenceInput,
} from '../../src/scheduler/time.js';

function occurrence(overrides: Partial<LocalOccurrenceInput> = {}): LocalOccurrenceInput {
  return {
    localTime: '13:00',
    timeZone: 'America/Sao_Paulo',
    referenceInstant: new Date('2026-09-19T15:00:00.000Z'),
    ...overrides,
  };
}

describe('resolveLocalOccurrence', () => {
  it.each([
    {
      label: 'normal America/Sao_Paulo day',
      input: occurrence(),
      instant: '2026-09-19T16:00:00.000Z',
      localDate: '2026-09-19',
      resolvedLocalTime: '13:00',
      resolution: 'exact',
    },
    {
      label: 'spring-forward gap at the first valid instant after it',
      input: occurrence({
        localTime: '02:30',
        timeZone: 'America/New_York',
        referenceInstant: new Date('2024-03-10T12:00:00.000Z'),
      }),
      instant: '2024-03-10T07:00:00.000Z',
      localDate: '2024-03-10',
      resolvedLocalTime: '03:00',
      resolution: 'nonexistent_shifted_to_next_valid',
    },
    {
      label: 'spring-forward gap at its exact first missing minute',
      input: occurrence({
        localTime: '02:00',
        timeZone: 'America/New_York',
        referenceInstant: new Date('2024-03-10T12:00:00.000Z'),
      }),
      instant: '2024-03-10T07:00:00.000Z',
      localDate: '2024-03-10',
      resolvedLocalTime: '03:00',
      resolution: 'nonexistent_shifted_to_next_valid',
    },
    {
      label: 'fall-back ambiguity at the earlier occurrence',
      input: occurrence({
        localTime: '01:30',
        timeZone: 'America/New_York',
        referenceInstant: new Date('2024-11-03T12:00:00.000Z'),
      }),
      instant: '2024-11-03T05:30:00.000Z',
      localDate: '2024-11-03',
      resolvedLocalTime: '01:30',
      resolution: 'ambiguous_earlier',
    },
  ])('resolves $label', ({ input, instant, localDate, resolvedLocalTime, resolution }) => {
    const result = resolveLocalOccurrence(input);

    expect(result.instant.toISOString()).toBe(instant);
    expect(result.localDate).toBe(localDate);
    expect(result.requestedLocalTime).toBe(input.localTime);
    expect(result.resolvedLocalTime).toBe(resolvedLocalTime);
    expect(result.resolution).toBe(resolution);
    expect(result.wasAdjusted).toBe(resolution === 'nonexistent_shifted_to_next_valid');
    expect(result.wasAmbiguous).toBe(resolution === 'ambiguous_earlier');
  });

  it.each([
    ['7:00', 'localTime must use the HH:mm format'],
    ['24:00', 'localTime must be a valid 24-hour time'],
    ['12:60', 'localTime must be a valid 24-hour time'],
  ])('rejects invalid local time %s', (localTime, message) => {
    expect(() => resolveLocalOccurrence(occurrence({ localTime }))).toThrow(message);
  });

  it('rejects an invalid IANA timezone without consulting the machine timezone', () => {
    expect(() => resolveLocalOccurrence(occurrence({ timeZone: 'Not/An_IANA_Zone' }))).toThrow(
      'Invalid IANA timezone',
    );
  });

  it('rejects an invalid reference instant', () => {
    expect(() =>
      resolveLocalOccurrence(occurrence({ referenceInstant: new Date(Number.NaN) })),
    ).toThrow('referenceInstant must be a valid Date');
  });
});

describe('compareWallAndMonotonicElapsed', () => {
  it.each([
    {
      label: 'steady progress',
      currentWall: '2026-09-19T15:00:10.000Z',
      currentMonotonicMs: 10_000,
      expectedWallElapsedMs: 10_000,
      expectedSkewMs: 0,
      significant: false,
    },
    {
      label: 'wall clock moved forward',
      currentWall: '2026-09-19T15:02:10.000Z',
      currentMonotonicMs: 10_000,
      expectedWallElapsedMs: 130_000,
      expectedSkewMs: 120_000,
      significant: true,
    },
    {
      label: 'wall clock moved backward',
      currentWall: '2026-09-19T14:59:50.000Z',
      currentMonotonicMs: 10_000,
      expectedWallElapsedMs: -10_000,
      expectedSkewMs: -20_000,
      significant: false,
    },
  ])(
    'reports $label',
    ({ currentWall, currentMonotonicMs, expectedWallElapsedMs, expectedSkewMs, significant }) => {
      const result = compareWallAndMonotonicElapsed(
        {
          wallTime: new Date('2026-09-19T15:00:00.000Z'),
          monotonicMs: 0,
        },
        {
          wallTime: new Date(currentWall),
          monotonicMs: currentMonotonicMs,
        },
      );

      expect(result).toEqual({
        wallElapsedMs: expectedWallElapsedMs,
        monotonicElapsedMs: currentMonotonicMs,
        skewMs: expectedSkewMs,
        significant,
      });
    },
  );

  it('allows a caller to choose the significant-jump threshold', () => {
    const result = compareWallAndMonotonicElapsed(
      {
        wallTime: new Date('2026-09-19T15:00:00.000Z'),
        monotonicMs: 0,
      },
      {
        wallTime: new Date('2026-09-19T15:00:10.000Z'),
        monotonicMs: 0,
      },
      10_000,
    );

    expect(result.skewMs).toBe(10_000);
    expect(result.significant).toBe(false);
  });

  it('rejects invalid monotonic samples and thresholds', () => {
    const sample = {
      wallTime: new Date('2026-09-19T15:00:00.000Z'),
      monotonicMs: 0,
    };
    expect(() =>
      compareWallAndMonotonicElapsed(sample, { ...sample, monotonicMs: Number.NaN }),
    ).toThrow('monotonicMs values must be finite');
    expect(() => compareWallAndMonotonicElapsed(sample, sample, -1)).toThrow(
      'significantSkewMs must be a non-negative finite number',
    );
  });
});
