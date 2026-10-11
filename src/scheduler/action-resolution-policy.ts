import type { ProviderObservation } from '../domain/types.js';
import type { ActionIntentRecord } from '../storage/repositories.js';
import type { ClosedWindowCycle, ObservedWindowCycle } from '../storage/window-cycles.js';

export interface ActionResolutionInput {
  intent: ActionIntentRecord;
  observation: ProviderObservation;
  closure?: ClosedWindowCycle;
  currentCycle?: ObservedWindowCycle;
  previousCycle?: ObservedWindowCycle;
  outcomeRecordedAtMs?: number;
  nowMs: number;
  readStartedAtMs: number;
}
export interface RollingInactiveEvidence {
  outcomeRecordedAtMs: number;
  firstObservedAtMs: number;
  firstResetAtMs: number;
  lastObservedAtMs: number;
  lastResetAtMs: number;
  durationMs: number;
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
  rollingEvidence?: RollingInactiveEvidence;
} {
  const reject = (reasonCode: ResolutionReason) => ({ allowed: false, reasonCode });
  const {
    intent,
    observation,
    closure,
    currentCycle,
    previousCycle,
    outcomeRecordedAtMs,
    nowMs,
    readStartedAtMs,
  } = input;
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
  const closureValid = Boolean(
    closure &&
    closure.providerId === intent.providerId &&
    closure.windowKind === target &&
    closure.cycleAtMs === cycleAt &&
    [closure.cycleAtMs, closure.endedAtMs, closure.observedAtMs].every(Number.isSafeInteger) &&
    ['anchored_boundary', 'reported_inactive_transition'].includes(closure.evidenceKind) &&
    closure.endedAtMs > cycleAt &&
    closure.endedAtMs >= (intent.startedAtMs ?? intent.createdAtMs) &&
    closure.observedAtMs >= closure.endedAtMs,
  );
  if (closure && !closureValid) return reject('ACTION_RESOLUTION_EVIDENCE_MISSING');
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
  if (closureValid && closure) {
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
  if (!previousCycle || !currentCycle || !Number.isSafeInteger(outcomeRecordedAtMs))
    return reject('ACTION_RESOLUTION_EVIDENCE_MISSING');
  const firstAt = previousCycle.lastObservedAtMs;
  const firstReset = previousCycle.lastResetAtMs;
  const lastAt = Date.parse(window.observedAt);
  const lastReset = window.resetAt ? Date.parse(window.resetAt.value) : NaN;
  const durationMs = (window.durationSeconds?.value ?? NaN) * 1000;
  const actionable = (confidence: string) => confidence === 'exact' || confidence === 'high';
  if (
    previousCycle.providerId !== intent.providerId ||
    currentCycle.providerId !== intent.providerId ||
    previousCycle.windowKind !== target ||
    currentCycle.windowKind !== target ||
    previousCycle.cycleAtMs !== cycleAt ||
    currentCycle.cycleAtMs !== cycleAt ||
    (previousCycle.anchoredResetAtMs !== null &&
      previousCycle.anchoredResetAtMs > previousCycle.cycleAtMs) ||
    (currentCycle.anchoredResetAtMs !== null &&
      currentCycle.anchoredResetAtMs > currentCycle.cycleAtMs) ||
    previousCycle.anchoredResetAtMs !== currentCycle.anchoredResetAtMs ||
    previousCycle.phase !== 'INACTIVE' ||
    currentCycle.phase !== 'INACTIVE' ||
    !actionable(previousCycle.phaseConfidence) ||
    !actionable(currentCycle.phaseConfidence) ||
    window.phase.value !== 'INACTIVE' ||
    window.phase.source !== 'inferred' ||
    !actionable(window.phase.confidence) ||
    window.usageRatio?.value !== 0 ||
    !actionable(window.usageRatio.confidence) ||
    !window.resetAt ||
    !actionable(window.resetAt.confidence) ||
    !window.durationSeconds ||
    !actionable(window.durationSeconds.confidence) ||
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    !Number.isSafeInteger(firstReset) ||
    !Number.isSafeInteger(lastReset) ||
    outcomeRecordedAtMs! < (intent.startedAtMs ?? intent.createdAtMs) ||
    firstAt < outcomeRecordedAtMs! ||
    Date.parse(observation.observedAt) < lastAt ||
    lastAt - firstAt < 15_000 ||
    lastAt < outcomeRecordedAtMs! + durationMs ||
    Math.abs(firstReset! - firstAt - durationMs) > 5_000 ||
    Math.abs(lastReset - lastAt - durationMs) > 5_000 ||
    Math.abs(lastReset - firstReset! - (lastAt - firstAt)) > 5_000 ||
    currentCycle.lastObservedAtMs !== lastAt ||
    currentCycle.lastResetAtMs !== lastReset
  )
    return reject('ACTION_RESOLUTION_EVIDENCE_MISSING');
  return {
    allowed: true,
    reasonCode: 'ACTION_RESOLUTION_ELIGIBLE',
    rollingEvidence: {
      outcomeRecordedAtMs: outcomeRecordedAtMs!,
      firstObservedAtMs: firstAt,
      firstResetAtMs: firstReset!,
      lastObservedAtMs: lastAt,
      lastResetAtMs: lastReset,
      durationMs,
    },
  };
}
