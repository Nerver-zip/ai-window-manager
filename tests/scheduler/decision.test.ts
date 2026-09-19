import { describe, expect, it } from 'vitest';
import type { ProviderCapabilities, WindowSnapshot } from '../../src/domain/types.js';
import {
  decideTargetReset,
  SchedulerReasonCode,
  type TargetResetInput,
} from '../../src/scheduler/decision.js';

const capabilities: ProviderCapabilities = {
  usageRead: { supported: true, contract: 'official_supported' },
  resetRead: { supported: true, contract: 'official_supported' },
  windowTrigger: { supported: true, contract: 'official_supported', consumesQuota: true },
};

function inactiveFiveHourWindow(
  durationConfidence: 'exact' | 'low' = 'exact',
  phaseConfidence: 'exact' | 'low' = 'exact',
  phase: WindowSnapshot['phase']['value'] = 'INACTIVE',
): WindowSnapshot {
  return {
    providerId: 'fake',
    windowKind: 'five_hour',
    observedAt: '2026-09-14T08:00:00.000Z',
    phase: {
      value: phase,
      source: phaseConfidence === 'exact' ? 'observed' : 'estimated',
      confidence: phaseConfidence,
      observedAt: '2026-09-14T08:00:00.000Z',
    },
    durationSeconds: {
      value: 5 * 60 * 60,
      source: durationConfidence === 'exact' ? 'official_supported' : 'estimated',
      confidence: durationConfidence,
      observedAt: '2026-09-14T08:00:00.000Z',
    },
  };
}

function input(overrides: Partial<TargetResetInput> = {}): TargetResetInput {
  return {
    now: new Date('2026-09-14T08:00:00.000Z'),
    providerId: 'fake',
    policyId: 'daily-13',
    targetResetAt: new Date('2026-09-14T13:00:00.000Z'),
    window: inactiveFiveHourWindow(),
    observation: { observedAt: '2026-09-14T08:00:00.000Z', staleAfterSeconds: 60 },
    capabilities,
    automationEnabled: true,
    ...overrides,
  };
}

describe('decideTargetReset', () => {
  it.each([
    ['before target', '2026-09-14T07:59:00.000Z', 'TARGET_NOT_DUE'],
    ['after tolerance', '2026-09-14T08:00:31.000Z', 'TARGET_MISSED'],
  ])('returns the stable boundary reason for %s', (_label, now, reasonCode) => {
    const decision = decideTargetReset(input({ now: new Date(now) }));

    expect(decision.kind).toBe('noop');
    expect(decision.reasonCode).toBe(reasonCode);
    expect(decision.explanation).toEqual(expect.objectContaining({ decision: 'noop', reasonCode }));
  });

  it('creates exactly one explainable intent at the target trigger', () => {
    const decision = decideTargetReset(input());

    expect(decision).toEqual(
      expect.objectContaining({
        kind: 'create_intent',
        reasonCode: SchedulerReasonCode.TargetResetWindowMatch,
        targetTriggerAt: '2026-09-14T08:00:00.000Z',
        targetResetAt: '2026-09-14T13:00:00.000Z',
        dedupeKey: 'fake:trigger_window:daily-13:2026-09-14T08:00:00.000Z',
      }),
    );
    expect(decision.explanation).toEqual(
      expect.objectContaining({
        decision: 'create_intent',
        providerId: 'fake',
        policyId: 'daily-13',
        windowDurationSeconds: 18_000,
        durationConfidence: 'exact',
        phase: 'INACTIVE',
        phaseConfidence: 'exact',
        observationAgeSeconds: 0,
      }),
    );
  });

  it('allows a small tolerance after the target trigger', () => {
    const decision = decideTargetReset(input({ now: new Date('2026-09-14T08:00:30.000Z') }));

    expect(decision.kind).toBe('create_intent');
  });

  it.each([
    ['unknown duration', { window: withoutDuration() }, 'WINDOW_DURATION_UNKNOWN'],
    [
      'low-confidence duration',
      { window: inactiveFiveHourWindow('low') },
      'WINDOW_DURATION_CONFIDENCE_TOO_LOW',
    ],
    [
      'low-confidence phase',
      { window: inactiveFiveHourWindow('exact', 'low') },
      'WINDOW_PHASE_CONFIDENCE_TOO_LOW',
    ],
    [
      'active window',
      { window: inactiveFiveHourWindow('exact', 'exact', 'ACTIVE') },
      'WINDOW_NOT_INACTIVE',
    ],
    [
      'exhausted window',
      { window: inactiveFiveHourWindow('exact', 'exact', 'EXHAUSTED') },
      'WINDOW_NOT_INACTIVE',
    ],
  ])('rejects %s', (_label, override, reasonCode) => {
    const decision = decideTargetReset(input(override));

    expect(decision).toEqual(expect.objectContaining({ kind: 'noop', reasonCode }));
  });

  it('rejects missing and stale observations explicitly', () => {
    const missingObservationInput = input();
    delete missingObservationInput.observation;
    expect(decideTargetReset(missingObservationInput)).toEqual(
      expect.objectContaining({ kind: 'noop', reasonCode: 'OBSERVATION_MISSING' }),
    );

    const stale = decideTargetReset(
      input({
        now: new Date('2026-09-14T08:02:01.000Z'),
        observation: { observedAt: '2026-09-14T08:00:00.000Z', staleAfterSeconds: 60 },
      }),
    );
    expect(stale).toEqual(
      expect.objectContaining({ kind: 'noop', reasonCode: 'OBSERVATION_STALE' }),
    );
    expect(stale.explanation.observationAgeSeconds).toBe(121);
  });

  it('rejects an unavailable trigger capability and disabled automation', () => {
    const unsupported = decideTargetReset(
      input({
        capabilities: {
          windowTrigger: { supported: false, contract: 'unknown', consumesQuota: 'unknown' },
        },
      }),
    );
    expect(unsupported).toEqual(
      expect.objectContaining({ kind: 'noop', reasonCode: 'TRIGGER_CAPABILITY_UNAVAILABLE' }),
    );

    const disabled = decideTargetReset(input({ automationEnabled: false }));
    expect(disabled).toEqual(
      expect.objectContaining({ kind: 'noop', reasonCode: 'AUTOMATION_DISABLED' }),
    );
  });
});

function withoutDuration(): Omit<WindowSnapshot, 'durationSeconds'> {
  const window = inactiveFiveHourWindow();
  delete window.durationSeconds;
  return window;
}
