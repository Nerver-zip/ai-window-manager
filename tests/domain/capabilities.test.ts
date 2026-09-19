import { describe, expect, it } from 'vitest';
import {
  ProviderActionResultSchema,
  ProviderCapabilitiesSchema,
  ReadCapabilitySchema,
  TriggerCapabilitySchema,
  TriggerWindowRequestSchema,
} from '../../src/domain/schemas.js';

const capabilities = {
  usageRead: { supported: true, contract: 'official_supported' },
  resetRead: { supported: false, contract: 'unknown' },
  windowTrigger: { supported: true, contract: 'official_supported', consumesQuota: false },
};

describe('capability and action schemas', () => {
  it('accepts supported and unsupported read capabilities', () => {
    expect(ReadCapabilitySchema.parse(capabilities.usageRead)).toEqual(capabilities.usageRead);
    expect(ReadCapabilitySchema.parse({ supported: false, contract: 'unknown' })).toEqual({
      supported: false,
      contract: 'unknown',
    });
  });

  it('makes trigger quota consumption explicit for true, false, and unknown', () => {
    for (const consumesQuota of [true, false, 'unknown'] as const) {
      expect(
        TriggerCapabilitySchema.parse({
          supported: true,
          contract: 'official_supported',
          consumesQuota,
        }).consumesQuota,
      ).toBe(consumesQuota);
    }
    expect(ProviderCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
  });

  it('rejects invalid contracts and malformed descriptors', () => {
    expect(() => ReadCapabilitySchema.parse({ supported: true, contract: 'inferred' })).toThrow();
    expect(() =>
      TriggerCapabilitySchema.parse({
        supported: true,
        contract: 'unknown',
        consumesQuota: 'sometimes',
      }),
    ).toThrow();
    expect(() =>
      ProviderCapabilitiesSchema.parse({ ...capabilities, extra: 'synthetic' }),
    ).toThrow();
  });

  it('validates the minimal provider action shapes without adding scheduler state', () => {
    expect(
      TriggerWindowRequestSchema.parse({
        intentId: 'intent-1',
        dedupeKey: 'fake:trigger_window:policy:target',
        reasonCode: 'TARGET_RESET_WINDOW_MATCH',
      }),
    ).toBeTruthy();
    expect(
      ProviderActionResultSchema.parse({
        status: 'uncertain',
        occurredAt: '2026-09-14T11:00:00.000Z',
      }),
    ).toMatchObject({ status: 'uncertain' });
    expect(() =>
      ProviderActionResultSchema.parse({ status: 'failed', occurredAt: 'not-a-date' }),
    ).toThrow();
  });
});
