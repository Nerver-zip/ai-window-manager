import type { ProviderObservation } from '../domain/types.js';
import type { ActionIntentRecord } from '../storage/repositories.js';
import type { ClosedWindowCycle, ObservedWindowCycle } from '../storage/window-cycles.js';

export interface ActionResolutionInput {
  intent: ActionIntentRecord;
  observation: ProviderObservation;
  closure?: ClosedWindowCycle;
  currentCycle?: ObservedWindowCycle;
  nowMs: number;
  readStartedAtMs: number;
}
export type ResolutionReason =
  | 'ACTION_RESOLUTION_NOT_UNCERTAIN'
  | 'ACTION_RESOLUTION_CYCLE_UNIDENTIFIED'
  | 'ACTION_RESOLUTION_EVIDENCE_MISSING'
  | 'ACTION_RESOLUTION_OBSERVATION_UNAVAILABLE'
  | 'ACTION_RESOLUTION_CYCLE_NOT_CLOSED'
  | 'ACTION_RESOLUTION_ELIGIBLE';

/** Pure gate: neither local expiry nor a single projected reset proves closure. */
export function assessActionResolution(input: ActionResolutionInput): {
  allowed: boolean;
  reasonCode: ResolutionReason;
} {
  const reject = (reasonCode: ResolutionReason) => ({ allowed: false, reasonCode });
  const { intent, observation, closure, currentCycle, nowMs, readStartedAtMs } = input;
  if (intent.state !== 'uncertain') return reject('ACTION_RESOLUTION_NOT_UNCERTAIN');
  const explanation =
    typeof intent.explanation === 'object' && intent.explanation !== null
      ? (intent.explanation as Record<string, unknown>)
      : {};
  const cycleAt =
    typeof explanation.observedCycleAt === 'string' ? Date.parse(explanation.observedCycleAt) : NaN;
  const target = explanation.windowKind;
  if (!Number.isSafeInteger(cycleAt) || typeof target !== 'string' || !target)
    return reject('ACTION_RESOLUTION_CYCLE_UNIDENTIFIED');
  if (
    !closure ||
    closure.providerId !== intent.providerId ||
    closure.windowKind !== target ||
    closure.cycleAtMs !== cycleAt ||
    ![closure.cycleAtMs, closure.endedAtMs, closure.observedAtMs].every(Number.isSafeInteger) ||
    !['anchored_boundary', 'reported_inactive_transition'].includes(closure.evidenceKind) ||
    closure.endedAtMs <= cycleAt ||
    closure.endedAtMs < (intent.startedAtMs ?? intent.createdAtMs) ||
    closure.observedAtMs < closure.endedAtMs
  )
    return reject('ACTION_RESOLUTION_EVIDENCE_MISSING');
  const window = observation.windows.find((candidate) => candidate.windowKind === target);
  const fresh = (at: string) => {
    const instant = Date.parse(at);
    return (
      Number.isSafeInteger(instant) &&
      instant >= readStartedAtMs &&
      instant <= nowMs &&
      nowMs - instant <= observation.staleAfterSeconds * 1000
    );
  };
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(readStartedAtMs) ||
    readStartedAtMs > nowMs ||
    observation.providerId !== intent.providerId ||
    observation.health !== 'UP' ||
    !fresh(observation.observedAt) ||
    !window ||
    window.providerId !== intent.providerId ||
    !fresh(window.observedAt) ||
    !fresh(window.phase.observedAt)
  )
    return reject('ACTION_RESOLUTION_OBSERVATION_UNAVAILABLE');
  if (
    !currentCycle ||
    currentCycle.providerId !== intent.providerId ||
    currentCycle.windowKind !== target ||
    currentCycle.cycleAtMs < closure.endedAtMs ||
    currentCycle.lastObservedAtMs !== Date.parse(window.observedAt) ||
    closure.observedAtMs > currentCycle.lastObservedAtMs ||
    !['ACTIVE', 'INACTIVE', 'EXHAUSTED'].includes(window.phase.value) ||
    !['exact', 'high'].includes(window.phase.confidence)
  )
    return reject('ACTION_RESOLUTION_CYCLE_NOT_CLOSED');
  return { allowed: true, reasonCode: 'ACTION_RESOLUTION_ELIGIBLE' };
}
