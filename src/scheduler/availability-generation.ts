import type { WindowSnapshot } from '../domain/types.js';
import type { StorageRepositories } from '../storage/repositories.js';
import { buildAvailabilityGeneration, consumedAllowanceWindowKinds } from './allowance.js';
import { legacyAutoDedupeKey } from './planner.js';

export function currentAvailabilityGeneration(
  repositories: StorageRepositories,
  providerId: string,
  windowKind: string | undefined,
  windows: readonly WindowSnapshot[],
): string | undefined {
  const cycles = new Map<string, { cycleAtMs: number; lastObservedAtMs: number }>();
  for (const kind of consumedAllowanceWindowKinds(providerId, windowKind, windows)) {
    const cycle = repositories.windowCycles.get(providerId, kind);
    if (cycle) cycles.set(kind, cycle);
  }
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
