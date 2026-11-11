import type { WindowSnapshot } from '../domain/types.js';
import type { StorageRepositories, ActionIntentRecord } from '../storage/repositories.js';
import { buildAvailabilityGeneration, consumedAllowanceWindowKinds } from './allowance.js';
import { legacyAutoDedupeKey } from './planner.js';

export function currentAvailabilityGeneration(
  repositories: StorageRepositories,
  providerId: string,
  windowKind: string | undefined,
  windows: readonly WindowSnapshot[],
): string | undefined {
  const cycles = new Map(
    repositories.windowCycles.list(providerId).map((cycle) => [cycle.windowKind, cycle] as const),
  );
  return buildAvailabilityGeneration({ providerId, windowKind, windows, cycles });
}

/**
 * Old releases keyed auto starts only by the target cycle. Keep those rows
 * authoritative until a durable, independent allowance transition proves a
 * later opportunity. New rows carry their full generation in their key.
 */
export function legacyAutoOpportunityBlocks(input: {
  repositories: StorageRepositories;
  providerId: string;
  policyId: string;
  windowKind: string;
  cycleAtMs: number;
  windows: readonly WindowSnapshot[];
}): boolean {
  const cycleAt = new Date(input.cycleAtMs).toISOString();
  const previous = input.repositories.actionIntents.getByDedupeKey(
    legacyAutoDedupeKey(input.providerId, input.policyId, input.windowKind, cycleAt),
  );
  if (!previous) return false;
  const explanation = asRecord(previous.explanation);
  if (
    explanation.windowKind !== input.windowKind ||
    explanation.observedCycleAt !== cycleAt ||
    previous.providerId !== input.providerId ||
    previous.policyId !== input.policyId
  )
    return true;

  let baselineAtMs: number | undefined;
  if (previous.state === 'skipped') {
    if (
      previous.lastErrorCode !== 'ACTION_ALLOWANCE_EXHAUSTED' ||
      previous.attemptCount !== 0 ||
      input.repositories.actionIntents.wasDispatchStarted(previous.id, previous.providerId)
    )
      return true;
    baselineAtMs = previous.updatedAtMs;
  } else if (previous.state === 'resolved_unknown') {
    if (!input.repositories.actionIntents.hasResolutionEvidence(previous.id)) return true;
    baselineAtMs = input.repositories.actionIntents.outcomeRecordedAt(
      previous.id,
      previous.providerId,
    );
  } else {
    return true;
  }
  if (!Number.isSafeInteger(baselineAtMs)) return true;

  return !hasVerifiedIndependentCycleSince(input, baselineAtMs!);
}

/**
 * A newly reported allowance member must not manufacture a new auto key for
 * the same target cycle. Only a durable, high-confidence cycle advance from a
 * member in the prior generation proves an independent opportunity.
 */
export function availabilityGenerationBlocks(input: {
  repositories: StorageRepositories;
  providerId: string;
  policyId: string;
  windowKind: string;
  cycleAtMs: number;
  generation: string;
  windows: readonly WindowSnapshot[];
  nowMs?: number;
}): boolean {
  const cycleAt = new Date(input.cycleAtMs).toISOString();
  const previous = input.repositories.actionIntents.latestForTargetCycle(
    input.providerId,
    input.policyId,
    input.windowKind,
    cycleAt,
  );
  if (!previous) return false;

  const explanation = asRecord(previous.explanation);
  if (!Object.hasOwn(explanation, 'eligibilityGeneration')) return false;
  const previousGeneration = parseGeneration(explanation.eligibilityGeneration);
  const currentGeneration = parseGeneration(input.generation);
  if (!previousGeneration || !currentGeneration) return true;
  if (
    previous.state === 'resolved_unknown' &&
    !input.repositories.actionIntents.hasResolutionEvidence(previous.id)
  )
    return true;
  if (
    ['planned', 'executing', 'succeeded', 'uncertain', 'failed_retryable'].includes(previous.state)
  )
    return true;
  if (wasAttemptDispatched(previous, input.repositories) && targetLifecycleHasFutureAnchor(input))
    return true;
  if (sameGeneration(previousGeneration, currentGeneration)) return false;

  return !hasVerifiedGenerationAdvance(input, previousGeneration);
}

function wasAttemptDispatched(
  intent: ActionIntentRecord,
  repositories: StorageRepositories,
): boolean {
  return (
    intent.attemptCount > 0 ||
    intent.state === 'confirmed' ||
    repositories.actionIntents.wasDispatchStarted(intent.id, intent.providerId)
  );
}

function targetLifecycleHasFutureAnchor(input: {
  repositories: StorageRepositories;
  providerId: string;
  windowKind: string;
  cycleAtMs: number;
  windows: readonly WindowSnapshot[];
  nowMs?: number;
}): boolean {
  const cycle = input.repositories.windowCycles.get(input.providerId, input.windowKind);
  if (!cycle) return false;
  if (cycle.cycleAtMs !== input.cycleAtMs) return false;
  if (cycle.anchoredResetAtMs === null || !Number.isSafeInteger(cycle.anchoredResetAtMs))
    return false;
  if (cycle.anchoredResetAtMs <= cycle.cycleAtMs) return false;
  const observationInstants = input.windows
    .map((window) => Date.parse(window.observedAt))
    .filter(Number.isSafeInteger);
  const nowMs = Number.isSafeInteger(input.nowMs)
    ? (input.nowMs as number)
    : Number.isSafeInteger(cycle.lastObservedAtMs)
      ? cycle.lastObservedAtMs
      : observationInstants.length > 0
        ? Math.max(...observationInstants)
        : NaN;
  if (!Number.isSafeInteger(nowMs)) return false;
  return cycle.anchoredResetAtMs > nowMs;
}

interface GenerationIdentity {
  windowKind: string;
  cycleAtMs: number;
}

function parseGeneration(value: unknown): GenerationIdentity[] | undefined {
  if (typeof value !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const identities: GenerationIdentity[] = [];
  for (const entry of parsed as unknown[]) {
    const record = asRecord(entry);
    const windowKind = record.windowKind;
    const cycleAtMs = record.cycleAtMs;
    if (typeof windowKind !== 'string' || !Number.isSafeInteger(cycleAtMs)) return undefined;
    identities.push({ windowKind, cycleAtMs: cycleAtMs as number });
  }
  if (new Set(identities.map((identity) => identity.windowKind)).size !== identities.length)
    return undefined;
  return identities;
}

function sameGeneration(left: readonly GenerationIdentity[], right: readonly GenerationIdentity[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasVerifiedGenerationAdvance(
  input: {
    repositories: StorageRepositories;
    providerId: string;
    windows: readonly WindowSnapshot[];
  },
  previousGeneration: readonly GenerationIdentity[],
): boolean {
  const windows = new Map(input.windows.map((window) => [window.windowKind, window]));
  for (const previous of previousGeneration) {
    const window = windows.get(previous.windowKind);
    const cycle = input.repositories.windowCycles.get(input.providerId, previous.windowKind);
    const observedAtMs = window ? Date.parse(window.observedAt) : NaN;
    if (
      !window ||
      !cycle ||
      cycle.cycleAtMs <= previous.cycleAtMs ||
      cycle.lastObservedAtMs !== observedAtMs ||
      !['exact', 'high'].includes(cycle.phaseConfidence) ||
      !['ACTIVE', 'INACTIVE', 'EXHAUSTED'].includes(cycle.phase)
    )
      continue;
    const priorSample = input.repositories.windowSamples.latestAtOrBefore(
      input.providerId,
      previous.windowKind,
      cycle.cycleAtMs - 1,
    );
    const priorObservedAtMs = priorSample ? Date.parse(priorSample.observedAt) : NaN;
    if (
      priorSample &&
      priorObservedAtMs >= previous.cycleAtMs &&
      ['exact', 'high'].includes(priorSample.phase.confidence) &&
      ['ACTIVE', 'EXHAUSTED', 'RESET_DUE'].includes(priorSample.phase.value)
    )
      return true;
  }
  return false;
}

function hasVerifiedIndependentCycleSince(
  input: {
    repositories: StorageRepositories;
    providerId: string;
    windowKind: string;
    cycleAtMs: number;
    windows: readonly WindowSnapshot[];
  },
  baselineAtMs: number,
): boolean {
  const currentWindows = new Map(input.windows.map((window) => [window.windowKind, window]));
  for (const windowKind of consumedAllowanceWindowKinds(
    input.providerId,
    input.windowKind,
    input.windows,
  )) {
    if (windowKind === input.windowKind) continue;
    const currentWindow = currentWindows.get(windowKind);
    const currentCycle = input.repositories.windowCycles.get(input.providerId, windowKind);
    const previousSample = input.repositories.windowSamples.latestAtOrBefore(
      input.providerId,
      windowKind,
      baselineAtMs,
    );
    const currentObservedAtMs = currentWindow ? Date.parse(currentWindow.observedAt) : NaN;
    if (
      !currentWindow ||
      !currentCycle ||
      !previousSample ||
      !Number.isSafeInteger(currentObservedAtMs) ||
      currentCycle.lastObservedAtMs !== currentObservedAtMs ||
      currentCycle.cycleAtMs <= baselineAtMs ||
      !['exact', 'high'].includes(currentCycle.phaseConfidence) ||
      !['ACTIVE', 'INACTIVE', 'EXHAUSTED'].includes(currentCycle.phase) ||
      !['exact', 'high'].includes(previousSample.phase.confidence) ||
      !['ACTIVE', 'EXHAUSTED', 'RESET_DUE'].includes(previousSample.phase.value)
    )
      continue;
    return true;
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
