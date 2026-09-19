import type { Confidence, WindowSnapshot } from '../domain/types.js';

export type SchedulerDecision =
  | { kind: 'noop'; reasonCode: string }
  | {
      kind: 'create_intent';
      reasonCode: string;
      targetTriggerAt: string;
      targetResetAt: string;
      dedupeKey: string;
    };

const actionableConfidence = new Set<Confidence>(['exact', 'high']);

export interface TargetResetInput {
  now: Date;
  providerId: string;
  policyId: string;
  targetResetAt: Date;
  window: WindowSnapshot;
  toleranceSeconds?: number;
}

export function decideTargetReset(input: TargetResetInput): SchedulerDecision {
  const duration = input.window.durationSeconds;
  if (!duration) return { kind: 'noop', reasonCode: 'WINDOW_DURATION_UNKNOWN' };
  if (!actionableConfidence.has(duration.confidence)) {
    return { kind: 'noop', reasonCode: 'WINDOW_DURATION_CONFIDENCE_TOO_LOW' };
  }

  if (!actionableConfidence.has(input.window.phase.confidence)) {
    return { kind: 'noop', reasonCode: 'WINDOW_PHASE_CONFIDENCE_TOO_LOW' };
  }

  if (input.window.phase.value !== 'INACTIVE') {
    return { kind: 'noop', reasonCode: 'WINDOW_NOT_INACTIVE' };
  }

  const targetTriggerMs = input.targetResetAt.getTime() - duration.value * 1000;
  const toleranceMs = (input.toleranceSeconds ?? 30) * 1000;
  const deltaMs = input.now.getTime() - targetTriggerMs;

  if (deltaMs < 0) return { kind: 'noop', reasonCode: 'TARGET_NOT_DUE' };
  if (deltaMs > toleranceMs) return { kind: 'noop', reasonCode: 'TARGET_MISSED' };

  const targetTriggerAt = new Date(targetTriggerMs).toISOString();
  const targetResetAt = input.targetResetAt.toISOString();
  const dedupeKey = [input.providerId, 'trigger_window', input.policyId, targetTriggerAt].join(':');

  return {
    kind: 'create_intent',
    reasonCode: 'TARGET_RESET_WINDOW_MATCH',
    targetTriggerAt,
    targetResetAt,
    dedupeKey,
  };
}
