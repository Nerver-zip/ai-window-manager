import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_PROVIDER_UPDATE_INTERVAL_MS,
  AUTOMATIC_PROVIDER_UPDATE_RETRY_MS,
  isAutomaticProviderUpdateDue,
} from '../../src/provider-clients/automatic-update.js';

const NOW = 1_800_000_000_000;

describe('automatic provider update cadence', () => {
  it('checks daily after a successful check', () => {
    expect(
      isAutomaticProviderUpdateDue({
        enabled: true,
        running: false,
        busy: false,
        nowMs: NOW,
        lastAttemptAtMs: NOW - AUTOMATIC_PROVIDER_UPDATE_INTERVAL_MS,
        lastSuccessfulCheckAtMs: NOW - AUTOMATIC_PROVIDER_UPDATE_INTERVAL_MS + 1,
      }),
    ).toBe(false);
    expect(
      isAutomaticProviderUpdateDue({
        enabled: true,
        running: false,
        busy: false,
        nowMs: NOW,
        lastAttemptAtMs: NOW - AUTOMATIC_PROVIDER_UPDATE_INTERVAL_MS,
        lastSuccessfulCheckAtMs: NOW - AUTOMATIC_PROVIDER_UPDATE_INTERVAL_MS,
      }),
    ).toBe(true);
  });

  it('retries failures after a short cooldown rather than waiting for the daily interval', () => {
    expect(
      isAutomaticProviderUpdateDue({
        enabled: true,
        running: false,
        busy: false,
        nowMs: NOW,
        lastAttemptAtMs: NOW - AUTOMATIC_PROVIDER_UPDATE_RETRY_MS + 1,
        lastSuccessfulCheckAtMs: NOW - AUTOMATIC_PROVIDER_UPDATE_INTERVAL_MS * 2,
      }),
    ).toBe(false);
    expect(
      isAutomaticProviderUpdateDue({
        enabled: true,
        running: false,
        busy: false,
        nowMs: NOW,
        lastAttemptAtMs: NOW - AUTOMATIC_PROVIDER_UPDATE_RETRY_MS,
        lastSuccessfulCheckAtMs: NOW - AUTOMATIC_PROVIDER_UPDATE_INTERVAL_MS * 2,
      }),
    ).toBe(true);
  });

  it.each([
    { enabled: false, running: false, busy: false },
    { enabled: true, running: true, busy: false },
    { enabled: true, running: false, busy: true },
  ])('does not schedule when disabled, running, or provider-busy: %j', (state) => {
    expect(
      isAutomaticProviderUpdateDue({
        ...state,
        nowMs: NOW,
        lastAttemptAtMs: null,
        lastSuccessfulCheckAtMs: null,
      }),
    ).toBe(false);
  });

  it('ignores malformed persisted timestamps and fails closed on an invalid clock', () => {
    expect(
      isAutomaticProviderUpdateDue({
        enabled: true,
        running: false,
        busy: false,
        nowMs: NOW,
        lastAttemptAtMs: 'not-a-timestamp',
        lastSuccessfulCheckAtMs: Number.POSITIVE_INFINITY,
      }),
    ).toBe(true);
    expect(
      isAutomaticProviderUpdateDue({
        enabled: true,
        running: false,
        busy: false,
        nowMs: Number.NaN,
        lastAttemptAtMs: null,
        lastSuccessfulCheckAtMs: null,
      }),
    ).toBe(false);
  });
});
