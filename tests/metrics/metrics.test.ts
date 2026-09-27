import { beforeEach, describe, expect, it } from 'vitest';
import type { ProviderObservation, WindowSnapshot } from '../../src/domain/types.js';
import {
  InspectionResult,
  clearActionIntentMetrics,
  clearProviderObservationMetrics,
  recordInspection,
  recordObservation,
  recordProviderHealth,
  recordSchedulerDecision,
  recordTrigger,
  refreshObservationMetrics,
  registry,
  resetMetricState,
  setActionIntentCount,
  setActionIntentCounts,
} from '../../src/metrics/metrics.js';

const observedAt = '2026-09-19T12:00:00.000Z';

beforeEach(() => {
  resetMetricState();
});

describe('prometheus metrics', () => {
  it('records provider and window gauges with deterministic time values', async () => {
    const observation = makeObservation([
      makeWindow('five_hour', {
        resetAt: fact('2026-09-19T14:00:00.000Z'),
        usageRatio: fact(0.4),
        remainingRatio: fact(0.6),
      }),
    ]);
    const nowMs = Date.parse('2026-09-19T13:00:00.000Z');

    recordObservation(observation, {
      nowMs,
      successfulInspectionAtMs: Date.parse(observedAt),
    });

    expect(await valuesFor('ai_window_provider_up')).toEqual([
      { labels: { provider: 'fake' }, value: 1 },
    ]);
    expect(await valuesFor('ai_window_usage_ratio')).toEqual([
      { labels: { provider: 'fake', window: 'five_hour' }, value: 0.4 },
    ]);
    expect(await valuesFor('ai_window_remaining_ratio')).toEqual([
      { labels: { provider: 'fake', window: 'five_hour' }, value: 0.6 },
    ]);
    expect(await valuesFor('ai_window_seconds_until_reset')).toEqual([
      { labels: { provider: 'fake', window: 'five_hour' }, value: 3600 },
    ]);
    expect(await valuesFor('ai_window_age_seconds')).toEqual([
      { labels: { provider: 'fake', window: 'five_hour' }, value: 3600 },
    ]);
    expect(await valuesFor('ai_window_last_successful_inspection_timestamp_seconds')).toEqual([
      { labels: { provider: 'fake' }, value: Date.parse(observedAt) / 1000 },
    ]);
  });

  it('uses the runtime clock fallback when observation metric timestamps are omitted', () => {
    expect(() => recordObservation(makeObservation([]), {})).not.toThrow();
  });

  it('refreshes age and reset gauges without fabricating a new inspection', async () => {
    const observation = makeObservation([
      makeWindow('five_hour', { resetAt: fact('2026-09-19T14:00:00.000Z') }),
    ]);
    recordObservation(observation, Date.parse('2026-09-19T13:00:00.000Z'));

    refreshObservationMetrics(Date.parse('2026-09-19T13:00:30.000Z'));

    expect(await valuesFor('ai_window_age_seconds')).toEqual([
      { labels: { provider: 'fake', window: 'five_hour' }, value: 3630 },
    ]);
    expect(await valuesFor('ai_window_seconds_until_reset')).toEqual([
      { labels: { provider: 'fake', window: 'five_hour' }, value: 3570 },
    ]);
    expect(await valuesFor('ai_window_last_successful_inspection_timestamp_seconds')).toEqual([
      { labels: { provider: 'fake' }, value: Date.parse('2026-09-19T13:00:00.000Z') / 1000 },
    ]);
  });

  it('removes optional and disappeared window series explicitly', async () => {
    recordObservation(
      makeObservation([
        makeWindow('five_hour', {
          resetAt: fact('2026-09-19T14:00:00.000Z'),
          usageRatio: fact(0.4),
          remainingRatio: fact(0.6),
        }),
        makeWindow('weekly', { usageRatio: fact(0.2) }),
      ]),
      Date.parse('2026-09-19T13:00:00.000Z'),
    );

    recordObservation(
      makeObservation([makeWindow('five_hour', { remainingRatio: fact(0.9) })]),
      Date.parse('2026-09-19T13:01:00.000Z'),
    );

    expect(await valuesFor('ai_window_usage_ratio')).toEqual([]);
    expect(await valuesFor('ai_window_remaining_ratio')).toEqual([
      { labels: { provider: 'fake', window: 'five_hour' }, value: 0.9 },
    ]);
    expect(await valuesFor('ai_window_seconds_until_reset')).toEqual([]);
    expect(await valuesFor('ai_window_age_seconds')).toEqual([
      { labels: { provider: 'fake', window: 'five_hour' }, value: 3660 },
    ]);
  });

  it('records bounded inspection, trigger and scheduler counters', async () => {
    recordInspection('fake', InspectionResult.Success);
    recordInspection('fake', InspectionResult.Success);
    recordInspection('fake', InspectionResult.AuthRequired);
    recordTrigger('fake', 'succeeded');
    recordTrigger('fake', 'uncertain');
    recordSchedulerDecision('fake', 'noop');
    recordSchedulerDecision('fake', 'create_intent');

    expect(await valuesFor('ai_window_inspection_total')).toEqual([
      { labels: { provider: 'fake', result: 'success' }, value: 2 },
      { labels: { provider: 'fake', result: 'auth_required' }, value: 1 },
    ]);
    expect(await valuesFor('ai_window_trigger_total')).toEqual([
      { labels: { provider: 'fake', result: 'succeeded' }, value: 1 },
      { labels: { provider: 'fake', result: 'uncertain' }, value: 1 },
    ]);
    expect(await valuesFor('ai_window_scheduler_decisions_total')).toEqual([
      { labels: { provider: 'fake', decision: 'noop' }, value: 1 },
      { labels: { provider: 'fake', decision: 'create_intent' }, value: 1 },
    ]);
  });

  it('maintains current intent counts and removes omitted lifecycle states', async () => {
    setActionIntentCount('fake', 'planned', 2);
    setActionIntentCounts('fake', { planned: 2, executing: 1 });
    setActionIntentCounts('fake', { confirmed: 1, failed_terminal: 0 });

    expect(await valuesFor('ai_window_action_intents')).toEqual([
      { labels: { provider: 'fake', state: 'confirmed' }, value: 1 },
      { labels: { provider: 'fake', state: 'failed_terminal' }, value: 0 },
    ]);
  });

  it('clears removed providers and empty intent-count snapshots without retaining stale series', async () => {
    recordObservation(
      makeObservation([makeWindow('five_hour', { usageRatio: fact(0.3) })]),
      Date.parse('2026-09-19T13:00:00.000Z'),
    );
    setActionIntentCounts('fake', { planned: 1, executing: 1 });

    clearProviderObservationMetrics('fake');
    clearProviderObservationMetrics('not-yet-observed');
    clearActionIntentMetrics('fake');
    clearActionIntentMetrics('not-yet-observed');
    setActionIntentCounts('fake', {});
    refreshObservationMetrics(Date.parse('2026-09-19T14:00:00.000Z'));

    expect(await valuesFor('ai_window_usage_ratio')).toEqual([]);
    expect(await valuesFor('ai_window_age_seconds')).toEqual([]);
    expect(await valuesFor('ai_window_action_intents')).toEqual([]);
  });

  it('skips undefined intent-count fields and rejects non-finite observation values', () => {
    const sparseCounts = {
      planned: undefined,
    } as unknown as Parameters<typeof setActionIntentCounts>[1];
    expect(() => setActionIntentCounts('fake', sparseCounts)).not.toThrow();

    expect(() => recordObservation(makeObservation([]), { nowMs: Number.NaN })).toThrow(
      'nowMs must be finite',
    );
    expect(() =>
      recordObservation(makeObservation([]), { nowMs: 1, successfulInspectionAtMs: Infinity }),
    ).toThrow('successfulInspectionAtMs must be finite');
    expect(() =>
      recordObservation(makeObservation([makeWindow('five_hour')]), {
        nowMs: Date.parse('2026-09-19T13:00:00.000Z'),
      }),
    ).not.toThrow();
    expect(() =>
      recordObservation(
        {
          ...makeObservation([makeWindow('five_hour')]),
          windows: [{ ...makeWindow('five_hour'), observedAt: 'not-an-instant' }],
        },
        Date.parse('2026-09-19T13:00:00.000Z'),
      ),
    ).toThrow('window observedAt must be a valid instant');
  });

  it('marks non-UP health as down without deleting the last observed window gauges', async () => {
    recordObservation(
      makeObservation([makeWindow('five_hour', { usageRatio: fact(0.4) })]),
      Date.parse('2026-09-19T13:00:00.000Z'),
    );
    recordProviderHealth('fake', 'UNAVAILABLE');

    expect(await valuesFor('ai_window_provider_up')).toEqual([
      { labels: { provider: 'fake' }, value: 0 },
    ]);
    expect(await valuesFor('ai_window_usage_ratio')).toEqual([
      { labels: { provider: 'fake', window: 'five_hour' }, value: 0.4 },
    ]);
  });

  it('rejects unbounded labels and invalid action-intent counts', () => {
    expect(() => recordInspection('raw/error', InspectionResult.Failed)).toThrow(
      'provider label must be a bounded machine identifier',
    );
    expect(() => recordTrigger('fake', 'raw-error' as never)).toThrow(
      'trigger result label is not supported',
    );
    expect(() => setActionIntentCount('fake', 'planned', -1)).toThrow(
      'action intent count must be a finite non-negative number',
    );
    expect(() => setActionIntentCounts('fake', { planned: -1 })).toThrow(
      'action intent count must be a finite non-negative number',
    );
    expect(() => setActionIntentCount('fake', 'planned', Number.POSITIVE_INFINITY)).toThrow(
      'action intent count must be a finite non-negative number',
    );
  });
});

async function valuesFor(
  name: string,
): Promise<Array<{ labels: Record<string, string | number | undefined>; value: number }>> {
  const metric = (await registry.getMetricsAsJSON()).find((candidate) => candidate.name === name);
  return metric?.values.map((entry) => ({ labels: { ...entry.labels }, value: entry.value })) ?? [];
}

function makeObservation(windows: WindowSnapshot[]): ProviderObservation {
  return {
    providerId: 'fake',
    health: 'UP',
    observedAt,
    windows,
    staleAfterSeconds: 300,
  };
}

function makeWindow(
  windowKind: string,
  fields: Partial<Pick<WindowSnapshot, 'resetAt' | 'usageRatio' | 'remainingRatio'>> = {},
): WindowSnapshot {
  return {
    providerId: 'fake',
    windowKind,
    observedAt,
    phase: fact('INACTIVE'),
    ...fields,
  };
}

function fact<T>(value: T) {
  return {
    value,
    source: 'official_supported' as const,
    confidence: 'exact' as const,
    observedAt,
  };
}
