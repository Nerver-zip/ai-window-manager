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

  it.each(['succeeded', 'failed', 'uncertain', 'rejected'] as const)(
    'returns configured trigger result: %s',
    async (status) => {
      const clock = new FakeClock('2026-09-14T11:00:00Z');
      const triggerResult = {
        status,
        ...(status === 'uncertain' ? { confirmationHint: 'confirmation required' } : {}),
        ...(status === 'failed' || status === 'rejected' ? { errorCode: `FAKE_${status}` } : {}),
      } as const;
      const provider = new FakeProvider(clock, { triggerResult });

      const result = await provider.triggerWindow(
        {},
        { intentId: 'intent', dedupeKey: 'dedupe', reasonCode: 'test' },
      );

      expect(result.status).toBe(status);
      expect(result.occurredAt).toBe('2026-09-14T11:00:00.000Z');
      expect((await provider.inspect({})).windows[0]?.phase.value).toBe(
        status === 'succeeded' ? 'ACTIVE' : 'INACTIVE',
      );
    },
  );

  it('consumes queued trigger results deterministically', async () => {
    const provider = new FakeProvider(new FakeClock('2026-09-14T11:00:00Z'), {
      triggerResults: ['failed', 'succeeded'],
    });

    await expect(
      provider.triggerWindow({}, { intentId: 'i1', dedupeKey: 'd1', reasonCode: 'test' }),
    ).resolves.toMatchObject({ status: 'failed' });
    await expect(
      provider.triggerWindow({}, { intentId: 'i2', dedupeKey: 'd2', reasonCode: 'test' }),
    ).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('uses the injected clock for an initially active window and configurable results', async () => {
    const clock = new FakeClock('2026-09-14T11:00:00Z');
    const provider = new FakeProvider(clock, {
      initialPhase: 'ACTIVE',
      windowDurationSeconds: 10,
    });

    expect((await provider.inspect({})).windows[0]?.resetAt?.value).toBe(
      '2026-09-14T11:00:10.000Z',
    );
    provider.setPhase('INACTIVE');
    provider.setTriggerResult('succeeded');
    await provider.triggerWindow({}, { intentId: 'i1', dedupeKey: 'd1', reasonCode: 'test' });
    clock.advanceMs(10_000);
    expect((await provider.inspect({})).windows[0]?.phase.value).toBe('INACTIVE');
  });

  it.each([
    ['DEGRADED', 'simulated degradation'],
    ['AUTH_REQUIRED', undefined],
    ['UNAVAILABLE', undefined],
    ['ERROR', undefined],
  ] as const)('simulates an inspection state: %s', async (health, summary) => {
    const provider = new FakeProvider(new FakeClock('2026-09-14T11:00:00Z'), {
      inspectionFailure: summary ? { health, summary } : health,
    });

    expect(await provider.health({})).toBe(health);
    await expect(provider.inspect({})).resolves.toMatchObject({
      providerId: 'fake',
      health,
      windows: [],
      ...(summary ? { summary } : {}),
    });
  });

  it('allows changing the current scenario without using real time', async () => {
    const clock = new FakeClock('2026-09-14T11:00:00Z');
    const provider = new FakeProvider(clock);

    provider.setUsageRatio(0.75);
    provider.setPhase('ACTIVE');
    expect((await provider.inspect({})).windows[0]).toMatchObject({
      phase: { value: 'ACTIVE' },
      usageRatio: { value: 0.75 },
      startedAt: { value: '2026-09-14T11:00:00.000Z' },
    });

    provider.setHealth('AUTH_REQUIRED');
    expect(await provider.health({})).toBe('AUTH_REQUIRED');
    provider.setHealth('UP');
    provider.setInspectionFailure('UNAVAILABLE');
    expect(await provider.health({})).toBe('UNAVAILABLE');
    provider.setInspectionFailure();
    expect(await provider.health({})).toBe('UP');
  });

  it('rejects a trigger while the simulated provider is unavailable', async () => {
    const provider = new FakeProvider(new FakeClock('2026-09-14T11:00:00Z'), {
      initialHealth: 'AUTH_REQUIRED',
    });

    await expect(
      provider.triggerWindow({}, { intentId: 'i1', dedupeKey: 'd1', reasonCode: 'test' }),
    ).resolves.toMatchObject({ status: 'rejected', errorCode: 'PROVIDER_NOT_AVAILABLE' });
  });

  it('validates mutable usage scenarios at the provider boundary', () => {
    const provider = new FakeProvider(new FakeClock('2026-09-14T11:00:00Z'));

    expect(() => provider.setUsageRatio(-0.1)).toThrow('between 0 and 1');
    expect(() => provider.setUsageRatio(1.1)).toThrow('between 0 and 1');
    expect(
      () =>
        new FakeProvider(new FakeClock('2026-09-14T11:00:00Z'), {
          windowDurationSeconds: 0,
        }),
    ).toThrow('positive integer');
  });
});
