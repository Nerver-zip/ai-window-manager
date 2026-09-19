import type {
  Confidence,
  ProviderCapabilities,
  WindowPhase,
  WindowSnapshot,
} from '../domain/types.js';

export const SchedulerReasonCode = {
  TargetResetWindowMatch: 'TARGET_RESET_WINDOW_MATCH',
  TargetNotDue: 'TARGET_NOT_DUE',
  TargetMissed: 'TARGET_MISSED',
  WindowDurationUnknown: 'WINDOW_DURATION_UNKNOWN',
  WindowDurationConfidenceTooLow: 'WINDOW_DURATION_CONFIDENCE_TOO_LOW',
  WindowPhaseConfidenceTooLow: 'WINDOW_PHASE_CONFIDENCE_TOO_LOW',
  WindowNotInactive: 'WINDOW_NOT_INACTIVE',
  ObservationStale: 'OBSERVATION_STALE',
  ObservationMissing: 'OBSERVATION_MISSING',
  TriggerCapabilityUnavailable: 'TRIGGER_CAPABILITY_UNAVAILABLE',
  AutomationDisabled: 'AUTOMATION_DISABLED',
} as const;

export type SchedulerReasonCode = (typeof SchedulerReasonCode)[keyof typeof SchedulerReasonCode];

export type SchedulerDecisionKind = 'noop' | 'create_intent';

export interface SchedulerExplanation {
  decision: SchedulerDecisionKind;
  reasonCode: SchedulerReasonCode;
  providerId: string;
  policyId: string;
  targetResetAt: string;
  targetTriggerAt?: string;
  windowKind?: string;
  windowDurationSeconds?: number;
  durationConfidence?: Confidence;
  phase?: WindowPhase;
  phaseConfidence?: Confidence;
  observationAgeSeconds?: number;
  toleranceSeconds: number;
}

export type SchedulerDecision =
  | {
      kind: 'noop';
      reasonCode: SchedulerReasonCode;
      explanation: SchedulerExplanation;
    }
  | {
      kind: 'create_intent';
      reasonCode: typeof SchedulerReasonCode.TargetResetWindowMatch;
      targetTriggerAt: string;
      targetResetAt: string;
      dedupeKey: string;
      explanation: SchedulerExplanation;
    };

const actionableConfidence = new Set<Confidence>(['exact', 'high']);

export interface ObservationFreshness {
  observedAt: string;
  staleAfterSeconds: number;
}

export interface TargetResetInput {
  now: Date;
  providerId: string;
  policyId: string;
  targetResetAt: Date;
  window?: WindowSnapshot;
  observation?: ObservationFreshness;
  capabilities: Pick<ProviderCapabilities, 'windowTrigger'>;
  automationEnabled: boolean;
  toleranceSeconds?: number;
}

export function decideTargetReset(input: TargetResetInput): SchedulerDecision {
  const toleranceSeconds = input.toleranceSeconds ?? 30;
  const targetResetAt = input.targetResetAt.toISOString();
  const base = {
    providerId: input.providerId,
    policyId: input.policyId,
    targetResetAt,
    toleranceSeconds,
  };

  if (!input.observation || !input.window) {
    return noop({
      ...base,
      reasonCode: SchedulerReasonCode.ObservationMissing,
    });
  }

  const observationAgeSeconds = observationAgeSecondsAt(input.now, input.observation.observedAt);
  const window = input.window;
  const observed = {
    ...base,
    observationAgeSeconds,
    phase: window.phase.value,
    phaseConfidence: window.phase.confidence,
    windowKind: window.windowKind,
    ...(window.durationSeconds
      ? {
          windowDurationSeconds: window.durationSeconds.value,
          durationConfidence: window.durationSeconds.confidence,
        }
      : {}),
  };

  if (observationAgeSeconds > input.observation.staleAfterSeconds) {
    return noop({ ...observed, reasonCode: SchedulerReasonCode.ObservationStale });
  }

  const duration = window.durationSeconds;
  if (!duration) {
    return noop({
      ...observed,
      reasonCode: SchedulerReasonCode.WindowDurationUnknown,
    });
  }
  if (!actionableConfidence.has(duration.confidence)) {
    return noop({
      ...observed,
      reasonCode: SchedulerReasonCode.WindowDurationConfidenceTooLow,
    });
  }

  if (!actionableConfidence.has(window.phase.confidence)) {
    return noop({
      ...observed,
      reasonCode: SchedulerReasonCode.WindowPhaseConfidenceTooLow,
    });
  }

  if (window.phase.value !== 'INACTIVE') {
    return noop({
      ...observed,
      reasonCode: SchedulerReasonCode.WindowNotInactive,
    });
  }

  if (!input.capabilities.windowTrigger.supported) {
    return noop({
      ...observed,
      reasonCode: SchedulerReasonCode.TriggerCapabilityUnavailable,
    });
  }

  if (!input.automationEnabled) {
    return noop({
      ...observed,
      reasonCode: SchedulerReasonCode.AutomationDisabled,
    });
  }

  const targetTriggerMs = input.targetResetAt.getTime() - duration.value * 1000;
  const toleranceMs = toleranceSeconds * 1000;
  const deltaMs = input.now.getTime() - targetTriggerMs;
  const targetTriggerAt = new Date(targetTriggerMs).toISOString();

  if (deltaMs < 0) {
    return noop({
      ...observed,
      reasonCode: SchedulerReasonCode.TargetNotDue,
      targetTriggerAt,
    });
  }
  if (deltaMs > toleranceMs) {
    return noop({
      ...observed,
      reasonCode: SchedulerReasonCode.TargetMissed,
      targetTriggerAt,
    });
  }

  const dedupeKey = [input.providerId, 'trigger_window', input.policyId, targetTriggerAt].join(':');
  const explanation: SchedulerExplanation = {
    ...observed,
    decision: 'create_intent',
    reasonCode: SchedulerReasonCode.TargetResetWindowMatch,
    targetTriggerAt,
  };

  return {
    kind: 'create_intent',
    reasonCode: SchedulerReasonCode.TargetResetWindowMatch,
    targetTriggerAt,
    targetResetAt,
    dedupeKey,
    explanation,
  };
}

function noop(
  values: Omit<SchedulerExplanation, 'decision'> & {
    reasonCode: SchedulerReasonCode;
  },
): SchedulerDecision {
  const explanation: SchedulerExplanation = {
    ...values,
    decision: 'noop',
  };
  return {
    kind: 'noop',
    reasonCode: values.reasonCode,
    explanation,
  };
}

function observationAgeSecondsAt(now: Date, observedAt: string): number {
  const ageMs = now.getTime() - Date.parse(observedAt);
  return Math.max(0, Math.floor(ageMs / 1000));
}
