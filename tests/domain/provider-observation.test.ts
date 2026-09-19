import { describe, expect, it } from 'vitest';
import {
  ProviderObservationSchema,
  StaleAfterSecondsSchema,
  parseProviderObservation,
  safeParseProviderObservation,
} from '../../src/domain/schemas.js';

const observedAt = '2026-09-14T11:00:00.000Z';

function window(providerId: string, windowKind: string) {
  return {
    providerId,
    windowKind,
    observedAt,
    phase: {
      value: 'UNKNOWN',
      source: 'unknown',
      confidence: 'unknown',
      observedAt,
    },
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    providerId: 'fake',
    health: 'UP',
    observedAt,
    windows: [window('fake', 'five_hour')],
    staleAfterSeconds: 10,
    ...overrides,
  };
}

describe('ProviderObservationSchema', () => {
  it('accepts healthy, multi-window and empty-window observations', () => {
    expect(parseProviderObservation(observation())).toMatchObject({
      providerId: 'fake',
      windows: [{ windowKind: 'five_hour' }],
    });
    expect(
      ProviderObservationSchema.parse(
        observation({ windows: [window('fake', 'five_hour'), window('fake', 'weekly')] }),
      ).windows,
    ).toHaveLength(2);
    expect(
      ProviderObservationSchema.parse(observation({ health: 'AUTH_REQUIRED', windows: [] })),
    ).toMatchObject({
      health: 'AUTH_REQUIRED',
      windows: [],
    });
    expect(
      ProviderObservationSchema.parse(observation({ health: 'UNAVAILABLE', windows: [] })),
    ).toMatchObject({
      health: 'UNAVAILABLE',
      windows: [],
    });
  });

  it('enforces observation-level identity and uniqueness invariants', () => {
    expect(() =>
      ProviderObservationSchema.parse(observation({ windows: [window('other', 'five_hour')] })),
    ).toThrow(/providerId/);
    expect(() =>
      ProviderObservationSchema.parse(
        observation({ windows: [window('fake', 'five_hour'), window('fake', 'five_hour')] }),
      ),
    ).toThrow(/unique/);
  });

  it('bounds staleness, summaries, and window collection size', () => {
    expect(StaleAfterSecondsSchema.safeParse(1).success).toBe(true);
    expect(StaleAfterSecondsSchema.safeParse(31_622_400).success).toBe(true);
    for (const staleAfterSeconds of [0, -1, 31_622_401, 1.5]) {
      expect(() => ProviderObservationSchema.parse(observation({ staleAfterSeconds }))).toThrow();
    }
    expect(() =>
      ProviderObservationSchema.parse(observation({ summary: 'x'.repeat(513) })),
    ).toThrow();
    expect(() =>
      ProviderObservationSchema.parse({
        ...observation(),
        windows: Array.from({ length: 33 }, (_value, index) => window('fake', `window_${index}`)),
      }),
    ).toThrow();
  });

  it('fails closed with safe structured issues for malformed observations', () => {
    const result = safeParseProviderObservation(observation({ observedAt: 'not-a-date' }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['observedAt']);
      expect(result.error.message).not.toContain('authorization');
    }
  });
});
