import { describe, expect, it } from 'vitest';
import { WindowSnapshotSchema } from '../../src/domain/schemas.js';

const observedAt = '2026-09-14T11:00:00.000Z';

function fact<T>(value: T, source: 'observed' | 'inferred' = 'observed', confidence = 'exact') {
  return { value, source, confidence, observedAt };
}

function baseWindow() {
  return {
    providerId: 'fake',
    windowKind: 'five_hour',
    observedAt,
    phase: fact('UNKNOWN'),
  };
}

describe('WindowSnapshotSchema', () => {
  it.each([
    ['unknown without optional facts', baseWindow()],
    [
      'inactive with duration',
      { ...baseWindow(), phase: fact('INACTIVE'), durationSeconds: fact(300) },
    ],
    [
      'active with reset but no start',
      {
        ...baseWindow(),
        phase: fact('ACTIVE'),
        resetAt: fact('2026-09-14T16:00:00.000Z', 'inferred', 'high'),
      },
    ],
    [
      'active with usage but no reset',
      {
        ...baseWindow(),
        phase: fact('ACTIVE'),
        usageRatio: fact(0.4),
      },
    ],
    [
      'active with rounded non-complementary ratios',
      {
        ...baseWindow(),
        phase: fact('ACTIVE'),
        usageRatio: fact(0.33),
        remainingRatio: fact(0.68, 'inferred'),
      },
    ],
  ])('accepts %s', (_name, value) => {
    expect(WindowSnapshotSchema.parse(value)).toMatchObject(value);
  });

  it('accepts a known start and duration without inventing reset or usage', () => {
    const parsed = WindowSnapshotSchema.parse({
      ...baseWindow(),
      phase: fact('INACTIVE'),
      startedAt: fact('2026-09-14T10:00:00.000Z'),
      durationSeconds: fact(300),
    });

    expect(parsed.startedAt?.value).toBe('2026-09-14T10:00:00.000Z');
    expect(parsed.resetAt).toBeUndefined();
    expect(parsed.usageRatio).toBeUndefined();
  });

  it.each([
    ['empty provider id', { ...baseWindow(), providerId: '' }],
    ['invalid provider id casing', { ...baseWindow(), providerId: 'Fake Provider' }],
    ['invalid window kind', { ...baseWindow(), windowKind: 'Five Hour' }],
    ['invalid snapshot timestamp', { ...baseWindow(), observedAt: 'yesterday' }],
    ['invalid phase fact', { ...baseWindow(), phase: fact('NOT_A_PHASE') }],
    ['invalid optional ratio fact', { ...baseWindow(), usageRatio: fact(1.1) }],
    [
      'unexpected raw payload field',
      { ...baseWindow(), rawProviderPayload: { token: 'synthetic' } },
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => WindowSnapshotSchema.parse(value)).toThrow();
  });
});
