import { describe, expect, it } from 'vitest';
import type {
  ActivationPolicy,
  CurrentWindowState,
  WindowSnapshot,
} from '../../src/domain/types.js';
import {
  planWindowAction,
  PlannerReasonCode,
  upcomingSchedule,
  type PlannerInput,
} from '../../src/scheduler/planner.js';

const now = new Date('2026-09-19T08:00:00.000Z');
const observedAt = '2026-09-19T07:59:50.000Z';
const inactive: CurrentWindowState = {
  providerId: 'fake',
  status: 'INACTIVE',
  windowKind: 'five_hour',
  observedAt,
  confidence: 'exact',
};
const active: CurrentWindowState = { ...inactive, status: 'ACTIVE' };
const capabilities = {
  windowTrigger: {
    supported: true,
    contract: 'official_supported' as const,
    consumesQuota: true as const,
  },
};

function window(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    providerId: 'fake',
    windowKind: 'five_hour',
    observedAt,
    phase: { value: 'INACTIVE', source: 'observed', confidence: 'exact', observedAt },
    durationSeconds: {
      value: 18_000,
      source: 'official_supported',
      confidence: 'exact',
      observedAt,
    },
    ...overrides,
  };
}

function policy(overrides: Partial<ActivationPolicy> = {}): ActivationPolicy {
  return {
    id: 'policy-1',
    providerId: 'fake',
    kind: 'fixed',
    enabled: true,
    timezone: 'UTC',
    windowKind: 'five_hour',
    anchorLocalTime: '08:00',
    toleranceSeconds: 30,
    updatedAtMs: 1,
    ...overrides,
  } as ActivationPolicy;
}

function input(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    now,
    providerId: 'fake',
    policy: policy(),
    currentWindow: inactive,
    window: window(),
    observation: { observedAt, staleAfterSeconds: 300 },
    capabilities,
    automationEnabled: true,
    ...overrides,
  };
}

function inputWithoutObservation(): PlannerInput {
  const value = input();
  delete value.observation;
  return value;
}

function windowWithoutDuration(): WindowSnapshot {
  const value = window();
  delete value.durationSeconds;
  return value;
}

describe('planWindowAction', () => {
  it.each([
    [
      'disabled policy',
      input({ policy: policy({ enabled: false }) }),
      PlannerReasonCode.PolicyDisabled,
    ],
    [
      'manual policy',
      input({ policy: policy({ kind: 'manual' }) }),
      PlannerReasonCode.ManualPolicy,
    ],
    [
      'automation disabled',
      input({ automationEnabled: false }),
      PlannerReasonCode.AutomationDisabled,
    ],
    [
      'unsupported trigger',
      input({
        capabilities: { windowTrigger: { ...capabilities.windowTrigger, supported: false } },
      }),
      PlannerReasonCode.TriggerCapabilityUnavailable,
    ],
    ['missing observation', inputWithoutObservation(), PlannerReasonCode.ObservationMissing],
    [
      'stale observation',
      input({ observation: { observedAt: '2026-09-19T00:00:00.000Z', staleAfterSeconds: 60 } }),
      PlannerReasonCode.ObservationStale,
    ],
    [
      'unknown monitoring',
      input({ currentWindow: { ...inactive, status: 'UNKNOWN' } }),
      PlannerReasonCode.MonitoringUnavailable,
    ],
    [
      'unavailable monitoring',
      input({ currentWindow: { ...inactive, status: 'UNAVAILABLE' } }),
      PlannerReasonCode.MonitoringUnavailable,
    ],
  ])('%s', (_label, value, reason) => {
    expect(planWindowAction(value).reasonCode).toBe(reason);
  });

  it('plans auto windows, waits while active and deduplicates pending work', () => {
    expect(
      planWindowAction(input({ policy: policy({ kind: 'auto' }), currentWindow: inactive })),
    ).toMatchObject({ kind: 'START', reasonCode: PlannerReasonCode.AutoWindowAvailable });
    expect(
      planWindowAction(input({ policy: policy({ kind: 'auto' }), currentWindow: active })),
    ).toMatchObject({ kind: 'WAIT', reasonCode: PlannerReasonCode.CurrentWindowActive });
    const planned = planWindowAction(input());
    expect(planned.dedupeKey).toBeDefined();
    expect(
      planWindowAction(
        input({
          pendingIntents: [
            { dedupeKey: planned.dedupeKey ?? '', actionType: 'trigger_window', state: 'planned' },
          ],
        }),
      ),
    ).toMatchObject({ kind: 'WAIT', reasonCode: PlannerReasonCode.ActionAlreadyPending });
    expect(
      planWindowAction(
        input({
          pendingIntents: [
            {
              dedupeKey: planned.dedupeKey ?? '',
              actionType: 'trigger_window',
              state: 'succeeded',
            },
          ],
        }),
      ),
    ).toMatchObject({ kind: 'START' });
  });

  it('requires known actionable duration and phase confidence', () => {
    expect(planWindowAction(input({ window: windowWithoutDuration() }))).toMatchObject({
      kind: 'WAIT',
      reasonCode: PlannerReasonCode.WindowDurationUnknown,
    });
    expect(
      planWindowAction(
        input({
          window: window({
            durationSeconds: {
              value: 18_000,
              source: 'estimated',
              confidence: 'medium',
              observedAt,
            },
          }),
        }),
      ),
    ).toMatchObject({ kind: 'WAIT', reasonCode: PlannerReasonCode.WindowDurationConfidenceTooLow });
    expect(
      planWindowAction(
        input({
          currentWindow: {
            ...inactive,
            status: 'UNKNOWN',
            confidence: 'medium',
            reason: 'WINDOW_STATE_UNCERTAIN',
          },
        }),
      ),
    ).toMatchObject({ kind: 'WAIT', reasonCode: PlannerReasonCode.WindowPhaseConfidenceTooLow });
  });

  it.each([
    ['before anchor', new Date('2026-09-19T07:59:00.000Z'), 'WAIT', PlannerReasonCode.AnchorNotDue],
    ['at anchor', now, 'START', PlannerReasonCode.ScheduledAnchor],
    [
      'inside tolerance',
      new Date('2026-09-19T08:00:20.000Z'),
      'START',
      PlannerReasonCode.ScheduledAnchor,
    ],
    [
      'at the exclusive deadline',
      new Date('2026-09-19T08:00:30.000Z'),
      'SKIP',
      PlannerReasonCode.AnchorExpired,
    ],
    [
      'after tolerance',
      new Date('2026-09-19T08:00:31.000Z'),
      'SKIP',
      PlannerReasonCode.AnchorExpired,
    ],
  ] as const)('fixed policy %s', (_label, instant, kind, reasonCode) => {
    const decision = planWindowAction(input({ now: instant }));
    expect(decision).toMatchObject({ kind, reasonCode });
    expect(decision.explanation).toMatchObject({
      providerId: 'fake',
      policyId: 'policy-1',
      windowKind: 'five_hour',
      phase: 'INACTIVE',
      phaseConfidence: 'exact',
      windowDurationSeconds: 18_000,
      durationConfidence: 'exact',
    });
    expect(Number.isInteger(decision.explanation.observationAgeSeconds)).toBe(true);
  });

  it('skips a fixed anchor when the window is already active', () => {
    expect(planWindowAction(input({ currentWindow: active }))).toMatchObject({
      kind: 'SKIP',
      reasonCode: PlannerReasonCode.AnchorSkippedActive,
    });
  });

  it('supports a zero-tolerance policy at the exact anchor only', () => {
    const exact = policy({ toleranceSeconds: 0 });
    expect(planWindowAction(input({ policy: exact }))).toMatchObject({
      kind: 'START',
      reasonCode: PlannerReasonCode.ScheduledAnchor,
    });
    expect(
      planWindowAction(input({ policy: exact, now: new Date('2026-09-19T08:00:01.000Z') })),
    ).toMatchObject({ kind: 'SKIP', reasonCode: PlannerReasonCode.AnchorExpired });
  });

  it('handles custom times before, within and after a tolerance', () => {
    const custom = policy({
      kind: 'custom_schedule',
      times: ['08:00', '18:00'],
      toleranceSeconds: 30,
    });
    expect(
      planWindowAction(input({ policy: custom, now: new Date('2026-09-19T07:59:00.000Z') })),
    ).toMatchObject({ kind: 'WAIT', reasonCode: PlannerReasonCode.AnchorNotDue });
    expect(
      planWindowAction(input({ policy: custom, now: new Date('2026-09-19T08:00:15.000Z') })),
    ).toMatchObject({ kind: 'START' });
    expect(
      planWindowAction(input({ policy: custom, now: new Date('2026-09-19T08:01:00.000Z') })),
    ).toMatchObject({ kind: 'SKIP', reasonCode: PlannerReasonCode.AnchorExpired });
    expect(
      planWindowAction(input({ policy: policy({ kind: 'custom_schedule', times: [] }) })),
    ).toMatchObject({ kind: 'WAIT', reasonCode: PlannerReasonCode.AnchorNotDue });
  });

  it('handles active-hour starts and minimum remaining coverage', () => {
    const activeHours = policy({
      kind: 'active_hours',
      periods: [{ start: '08:00', end: '12:00' }],
    });
    expect(
      planWindowAction(input({ policy: activeHours, now: new Date('2026-09-19T07:00:00.000Z') })),
    ).toMatchObject({ kind: 'WAIT', reasonCode: PlannerReasonCode.AnchorNotDue });
    expect(
      planWindowAction(input({ policy: activeHours, now: new Date('2026-09-19T08:00:00.000Z') })),
    ).toMatchObject({ kind: 'START', reasonCode: PlannerReasonCode.ActiveHoursCoverage });
    expect(
      planWindowAction(
        input({
          policy: activeHours,
          now: new Date('2026-09-19T11:30:00.000Z'),
          observation: { observedAt: '2026-09-19T11:29:50.000Z', staleAfterSeconds: 300 },
        }),
      ),
    ).toMatchObject({ kind: 'SKIP', reasonCode: PlannerReasonCode.ActiveHoursTooShort });
    expect(
      planWindowAction(
        input({
          policy: activeHours,
          currentWindow: active,
          now: new Date('2026-09-19T09:00:00.000Z'),
          observation: { observedAt: '2026-09-19T08:59:50.000Z', staleAfterSeconds: 300 },
        }),
      ),
    ).toMatchObject({ kind: 'WAIT', reasonCode: PlannerReasonCode.CurrentWindowActive });
    expect(
      planWindowAction(
        input({
          policy: activeHours,
          window: window({
            durationSeconds: {
              value: 18_000,
              source: 'estimated',
              confidence: 'medium',
              observedAt,
            },
          }),
        }),
      ),
    ).toMatchObject({ kind: 'WAIT', reasonCode: PlannerReasonCode.WindowDurationConfidenceTooLow });
    const overnight = policy({
      kind: 'active_hours',
      periods: [{ start: '22:00', end: '02:00' }],
    });
    expect(
      planWindowAction(
        input({
          policy: overnight,
          now: new Date('2026-09-19T22:00:00.000Z'),
          observation: { observedAt: '2026-09-19T21:59:50.000Z', staleAfterSeconds: 300 },
        }),
      ),
    ).toMatchObject({ kind: 'START', reasonCode: PlannerReasonCode.ActiveHoursCoverage });
  });
});

describe('upcomingSchedule', () => {
  it('does not preview manual or auto policies', () => {
    expect(upcomingSchedule(policy({ kind: 'manual' }), now, 18_000)).toEqual([]);
    expect(upcomingSchedule(policy({ kind: 'auto' }), now, 18_000)).toEqual([]);
  });

  it('previews fixed, custom and active-hour starts', () => {
    expect(upcomingSchedule(policy(), now, 18_000, 2)).toHaveLength(2);
    expect(upcomingSchedule(policy(), new Date('2026-09-19T08:00:01.000Z'), 18_000, 1)[0]?.at).toBe(
      '2026-09-19T13:00:00.000Z',
    );
    expect(
      upcomingSchedule(
        policy({ kind: 'custom_schedule', times: ['08:00', '18:00'] }),
        now,
        undefined,
        2,
      ),
    ).toHaveLength(2);
    expect(
      upcomingSchedule(
        policy({ kind: 'active_hours', periods: [{ start: '08:00', end: '12:00' }] }),
        now,
        undefined,
        2,
      ),
    ).toHaveLength(2);
    expect(upcomingSchedule(policy(), now, undefined)).toEqual([]);
  });
});
