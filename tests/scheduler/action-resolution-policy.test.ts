import { describe, expect, it } from 'vitest';
import {
  assessActionResolution,
  type ActionResolutionInput,
} from '../../src/scheduler/action-resolution-policy.js';

const now = Date.parse('2026-10-02T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
function input(): ActionResolutionInput {
  return {
    nowMs: now,
    readStartedAtMs: now,
    intent: {
      id: 'synthetic-intent',
      providerId: 'codex',
      policyId: null,
      actionType: 'trigger_window',
      dedupeKey: 'synthetic-cycle-key',
      state: 'uncertain',
      scheduledForMs: now - 20000,
      notBeforeMs: null,
      expiresAtMs: now - 19000,
      attemptCount: 1,
      confirmationAttemptCount: 1,
      confirmationNotBeforeMs: null,
      reasonCode: 'ACTION_DISPATCH_UNCERTAIN',
      explanation: { windowKind: 'primary', observedCycleAt: iso(now - 20000) },
      lastErrorCode: 'EOF',
      createdAtMs: now - 20000,
      startedAtMs: now - 19000,
      finishedAtMs: null,
      updatedAtMs: now - 19000,
    },
    observation: {
      providerId: 'codex',
      health: 'UP',
      observedAt: iso(now),
      staleAfterSeconds: 60,
      windows: [
        {
          providerId: 'codex',
          windowKind: 'primary',
          observedAt: iso(now),
          phase: { value: 'ACTIVE', source: 'observed', confidence: 'high', observedAt: iso(now) },
        },
      ],
    },
    closure: {
      providerId: 'codex',
      windowKind: 'primary',
      cycleAtMs: now - 20000,
      endedAtMs: now - 10000,
      observedAtMs: now - 9000,
      evidenceKind: 'anchored_boundary',
    },
    currentCycle: {
      providerId: 'codex',
      windowKind: 'primary',
      cycleAtMs: now - 10000,
      anchoredResetAtMs: null,
      lastObservedAtMs: now,
      lastResetAtMs: null,
      phase: 'ACTIVE',
      phaseConfidence: 'high',
    },
  };
}
describe('unknown outcome resolution policy', () => {
  it('accepts only a freshly verified later cycle backed by durable closure evidence', () => {
    expect(assessActionResolution(input())).toEqual({
      allowed: true,
      reasonCode: 'ACTION_RESOLUTION_ELIGIBLE',
    });
  });
  it.each(['executing', 'confirmed', 'resolved_unknown'] as const)(
    'refuses %s regardless of expiry',
    (state) => {
      const value = input();
      value.intent.state = state;
      expect(assessActionResolution(value).allowed).toBe(false);
    },
  );
  it.each([
    'legacy',
    'missing closure',
    'wrong cycle',
    'same cycle',
    'stale',
    'unavailable',
    'unknown phase',
    'low confidence',
    'out of order',
    'wrong target',
    'invalid timestamp',
    'late dispatch',
    'cached before request',
  ])('refuses insufficient evidence: %s', (variant) => {
    const value = input();
    switch (variant) {
      case 'legacy':
        value.intent.explanation = {};
        break;
      case 'missing closure':
        delete value.closure;
        break;
      case 'wrong cycle':
        value.closure!.cycleAtMs -= 1;
        break;
      case 'same cycle':
        value.currentCycle!.cycleAtMs = now - 20000;
        break;
      case 'stale':
        value.nowMs += 61000;
        break;
      case 'unavailable':
        value.observation.health = 'AUTH_REQUIRED';
        break;
      case 'unknown phase':
        value.observation.windows[0]!.phase.value = 'UNKNOWN';
        break;
      case 'low confidence':
        value.observation.windows[0]!.phase.confidence = 'low';
        break;
      case 'out of order':
        value.currentCycle!.lastObservedAtMs -= 1;
        break;
      case 'wrong target':
        value.closure!.windowKind = 'weekly';
        break;
      case 'invalid timestamp':
        value.closure!.endedAtMs = NaN;
        break;
      case 'late dispatch':
        value.intent.startedAtMs = now;
        break;
      case 'cached before request':
        value.readStartedAtMs += 1;
        value.nowMs += 1;
        break;
    }
    expect(assessActionResolution(value).allowed).toBe(false);
  });
});
