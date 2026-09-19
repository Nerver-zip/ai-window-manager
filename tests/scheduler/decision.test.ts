import { describe, expect, it } from 'vitest';
import type { WindowSnapshot } from '../../src/domain/types.js';
import { decideTargetReset } from '../../src/scheduler/decision.js';

function inactiveFiveHourWindow(confidence: 'exact' | 'low' = 'exact'): WindowSnapshot {
  return {
    providerId: 'codex',
    windowKind: 'five_hour',
    phase: 'INACTIVE',
    observedAt: '2026-09-14T10:59:00.000Z',
    durationSeconds: {
      value: 5 * 60 * 60,
      source: confidence === 'exact' ? 'official_supported' : 'estimated',
      confidence,
      observedAt: '2026-09-14T10:59:00.000Z',
    },
  };
}

describe('decideTargetReset', () => {
  it('creates an intent exactly when target trigger is due', () => {
    const decision = decideTargetReset({
      now: new Date('2026-09-14T11:00:00.000Z'),
      providerId: 'codex',
      policyId: 'daily-13',
      targetResetAt: new Date('2026-09-14T16:00:00.000Z'),
      window: inactiveFiveHourWindow(),
    });

    expect(decision.kind).toBe('create_intent');
    if (decision.kind === 'create_intent') {
      expect(decision.targetTriggerAt).toBe('2026-09-14T11:00:00.000Z');
      expect(decision.reasonCode).toBe('TARGET_RESET_WINDOW_MATCH');
    }
  });

  it('does nothing before target', () => {
    expect(
      decideTargetReset({
        now: new Date('2026-09-14T10:59:59.000Z'),
        providerId: 'codex',
        policyId: 'daily-13',
        targetResetAt: new Date('2026-09-14T16:00:00.000Z'),
        window: inactiveFiveHourWindow(),
      }),
    ).toEqual({ kind: 'noop', reasonCode: 'TARGET_NOT_DUE' });
  });

  it('refuses low-confidence duration for automatic action', () => {
    expect(
      decideTargetReset({
        now: new Date('2026-09-14T11:00:00.000Z'),
        providerId: 'codex',
        policyId: 'daily-13',
        targetResetAt: new Date('2026-09-14T16:00:00.000Z'),
        window: inactiveFiveHourWindow('low'),
      }),
    ).toEqual({ kind: 'noop', reasonCode: 'WINDOW_DURATION_CONFIDENCE_TOO_LOW' });
  });

  it('refuses a window when its duration is unknown', () => {
    const window = inactiveFiveHourWindow();
    delete window.durationSeconds;

    expect(
      decideTargetReset({
        now: new Date('2026-09-14T11:00:00.000Z'),
        providerId: 'codex',
        policyId: 'daily-13',
        targetResetAt: new Date('2026-09-14T16:00:00.000Z'),
        window,
      }),
    ).toEqual({ kind: 'noop', reasonCode: 'WINDOW_DURATION_UNKNOWN' });
  });

  it('refuses an active window and a missed target', () => {
    expect(
      decideTargetReset({
        now: new Date('2026-09-14T11:00:00.000Z'),
        providerId: 'codex',
        policyId: 'daily-13',
        targetResetAt: new Date('2026-09-14T16:00:00.000Z'),
        window: { ...inactiveFiveHourWindow(), phase: 'ACTIVE' },
      }),
    ).toEqual({ kind: 'noop', reasonCode: 'WINDOW_NOT_INACTIVE' });

    expect(
      decideTargetReset({
        now: new Date('2026-09-14T11:01:00.000Z'),
        providerId: 'codex',
        policyId: 'daily-13',
        targetResetAt: new Date('2026-09-14T16:00:00.000Z'),
        window: inactiveFiveHourWindow(),
      }),
    ).toEqual({ kind: 'noop', reasonCode: 'TARGET_MISSED' });
  });
});
