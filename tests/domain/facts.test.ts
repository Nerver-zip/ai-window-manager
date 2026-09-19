import { describe, expect, it } from 'vitest';
import {
  CapabilityContractSchema,
  ConfidenceSchema,
  DurationSecondsSchema,
  EvidenceSourceSchema,
  FactSchema,
  RatioSchema,
  UtcInstantSchema,
} from '../../src/domain/schemas.js';

const observedAt = '2026-09-14T11:00:00.000Z';

describe('domain fact schemas', () => {
  it('preserves every evidence source and confidence without coupling them', () => {
    const schema = FactSchema(RatioSchema);

    for (const source of EvidenceSourceSchema.options) {
      for (const confidence of ConfidenceSchema.options) {
        expect(schema.parse({ value: 0.5, source, confidence, observedAt })).toMatchObject({
          value: 0.5,
          source,
          confidence,
          observedAt,
        });
      }
    }

    expect(
      schema.parse({ value: 0.5, source: 'inferred', confidence: 'exact', observedAt }),
    ).toMatchObject({ source: 'inferred', confidence: 'exact' });
  });

  it('accepts normalized UTC instants and rejects malformed or offset timestamps', () => {
    expect(UtcInstantSchema.safeParse(observedAt).success).toBe(true);
    expect(UtcInstantSchema.safeParse('2026-09-14T11:00:00Z').success).toBe(true);
    expect(UtcInstantSchema.safeParse('2026-09-14T11:00:00.000-03:00').success).toBe(false);
    expect(UtcInstantSchema.safeParse('2026-09-14T25:00:00.000Z').success).toBe(false);
    expect(UtcInstantSchema.safeParse('2026-09-14T11:00:00.000').success).toBe(false);
  });

  it('enforces finite inclusive ratios', () => {
    for (const value of [0, 1]) {
      expect(RatioSchema.safeParse(value).success).toBe(true);
    }
    for (const value of [-0.001, 1.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(RatioSchema.safeParse(value).success).toBe(false);
    }
  });

  it('enforces positive integer durations within the safety bound', () => {
    expect(DurationSecondsSchema.safeParse(1).success).toBe(true);
    expect(DurationSecondsSchema.safeParse(31_622_400).success).toBe(true);
    for (const value of [0, -1, 1.5, 31_622_401, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(DurationSecondsSchema.safeParse(value).success).toBe(false);
    }
  });

  it('keeps capability contract values separate from fact evidence values', () => {
    expect(CapabilityContractSchema.options).toEqual([
      'official_supported',
      'official_client_internal',
      'observed_undocumented',
      'unknown',
    ]);
    expect(CapabilityContractSchema.safeParse('inferred').success).toBe(false);
  });
});
