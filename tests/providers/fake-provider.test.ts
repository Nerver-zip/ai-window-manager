import { describe, expect, it } from 'vitest';
import { parseProviderObservation } from '../../src/domain/schemas.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import { FakeClock } from '../../src/scheduler/clock.js';

describe('FakeProvider', () => {
  it('starts and resets a short fake window deterministically', async () => {
    const clock = new FakeClock('2026-09-14T11:00:00Z');
    const provider = new FakeProvider(clock, { windowDurationSeconds: 30 });

    expect((await provider.inspect({})).windows[0]?.phase.value).toBe('INACTIVE');
    expect(
      (
        await provider.triggerWindow(
          {},
          {
            intentId: 'i1',
            dedupeKey: 'd1',
            reasonCode: 'test',
          },
        )
      ).status,
    ).toBe('succeeded');
    const activeObservation = await provider.inspect({});
    expect(activeObservation.windows[0]?.phase.value).toBe('ACTIVE');
    expect(activeObservation.windows[0]?.phase).toMatchObject({
      source: 'observed',
      confidence: 'exact',
    });
    expect(activeObservation.windows[0]?.durationSeconds).toMatchObject({
      source: 'official_supported',
      confidence: 'exact',
    });
    expect(activeObservation.windows[0]?.resetAt).toBeDefined();
    expect(activeObservation.windows[0]?.resetAt).toMatchObject({
      source: 'inferred',
      confidence: 'high',
    });
    expect(activeObservation.windows[0]?.usageRatio).toMatchObject({
      source: 'observed',
      confidence: 'exact',
    });
    expect(activeObservation.windows[0]?.remainingRatio).toMatchObject({
      source: 'inferred',
      confidence: 'exact',
    });
    expect(parseProviderObservation(activeObservation)).toEqual(activeObservation);

    clock.advanceMs(30_000);
    expect((await provider.inspect({})).windows[0]?.phase.value).toBe('INACTIVE');
  });

  it('exposes capabilities, health, custom state, and rejects duplicate activation', async () => {
    const clock = new FakeClock('2026-09-14T11:00:00Z');
    const provider = new FakeProvider(clock, {
      id: 'fake-custom',
      windowDurationSeconds: 10,
      initialPhase: 'ACTIVE',
      usageRatio: 0.4,
    });

    expect(await provider.health({})).toBe('UP');
    expect(provider.capabilities().windowTrigger).toEqual({
      supported: true,
      contract: 'official_supported',
      consumesQuota: false,
    });
    expect((await provider.inspect({})).windows[0]).toMatchObject({
      phase: { value: 'ACTIVE' },
      usageRatio: { value: 0.4 },
      remainingRatio: { value: 0.6 },
    });
    expect(
      await provider.triggerWindow({}, { intentId: 'i2', dedupeKey: 'd2', reasonCode: 'test' }),
    ).toMatchObject({ status: 'rejected', errorCode: 'WINDOW_ALREADY_ACTIVE' });
  });
});
