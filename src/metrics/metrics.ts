import client from 'prom-client';
import type { ProviderActionStatus, ProviderObservation } from '../domain/types.js';
import type { ActionIntentState } from '../storage/repositories.js';

client.collectDefaultMetrics({ prefix: 'ai_window_process_' });

const MAX_LABEL_LENGTH = 64;
const boundedIdentifier = /^[a-z0-9][a-z0-9_-]*$/;

export const providerUp = new client.Gauge({
  name: 'ai_window_provider_up',
  help: 'Whether the provider is currently considered up (1) or not (0).',
  labelNames: ['provider'] as const,
});

export const usageRatio = new client.Gauge({
  name: 'ai_window_usage_ratio',
  help: 'Normalized used quota ratio when known.',
  labelNames: ['provider', 'window'] as const,
});

export const remainingRatio = new client.Gauge({
  name: 'ai_window_remaining_ratio',
  help: 'Normalized remaining quota ratio when known.',
  labelNames: ['provider', 'window'] as const,
});

export const secondsUntilReset = new client.Gauge({
  name: 'ai_window_seconds_until_reset',
  help: 'Seconds until the observed window reset, when known.',
  labelNames: ['provider', 'window'] as const,
});

export const ageSeconds = new client.Gauge({
  name: 'ai_window_age_seconds',
  help: 'Age in seconds of the latest observed window sample.',
  labelNames: ['provider', 'window'] as const,
});

export const inspectionTotal = new client.Counter({
  name: 'ai_window_inspection_total',
  help: 'Provider inspection attempts by bounded result.',
  labelNames: ['provider', 'result'] as const,
});

export const triggerTotal = new client.Counter({
  name: 'ai_window_trigger_total',
  help: 'Provider trigger attempts by bounded result.',
  labelNames: ['provider', 'result'] as const,
});

export const schedulerDecisionsTotal = new client.Counter({
  name: 'ai_window_scheduler_decisions_total',
  help: 'Scheduler decisions by bounded decision kind.',
  labelNames: ['provider', 'decision'] as const,
});

export const actionIntents = new client.Gauge({
  name: 'ai_window_action_intents',
  help: 'Current durable action intents by lifecycle state.',
  labelNames: ['provider', 'state'] as const,
});

export const lastSuccessfulInspectionTimestampSeconds = new client.Gauge({
  name: 'ai_window_last_successful_inspection_timestamp_seconds',
  help: 'Unix timestamp of the last successful provider inspection.',
  labelNames: ['provider'] as const,
});

export const registry = client.register;

export const InspectionResult = {
  Success: 'success',
  AuthRequired: 'auth_required',
  ProviderUnavailable: 'provider_unavailable',
  InvalidResponse: 'invalid_response',
  Failed: 'failed',
} as const;

export type InspectionResult = (typeof InspectionResult)[keyof typeof InspectionResult];

export type TriggerResult = ProviderActionStatus;

export type SchedulerDecisionMetric = 'noop' | 'create_intent';

const triggerResults: readonly TriggerResult[] = ['succeeded', 'failed', 'uncertain', 'rejected'];

const inspectionResults: readonly InspectionResult[] = Object.values(InspectionResult);

const schedulerDecisions: readonly SchedulerDecisionMetric[] = ['noop', 'create_intent'];

const actionIntentStates: readonly ActionIntentState[] = [
  'planned',
  'executing',
  'succeeded',
  'confirmed',
  'uncertain',
  'skipped',
  'canceled',
  'failed_retryable',
  'failed_terminal',
];

export interface ObservationMetricOptions {
  nowMs?: number;
  successfulInspectionAtMs?: number;
}

export interface MetricsCallbacks {
  onObservation: typeof recordObservation;
  onProviderHealth: typeof recordProviderHealth;
  onInspection: typeof recordInspection;
  onTrigger: typeof recordTrigger;
  onSchedulerDecision: typeof recordSchedulerDecision;
  onActionIntentCounts: typeof setActionIntentCounts;
}

const latestObservations = new Map<string, ProviderObservation>();
const knownWindowKinds = new Map<string, Set<string>>();
const knownActionIntentStates = new Map<string, Set<ActionIntentState>>();

export function recordObservation(
  observation: ProviderObservation,
  input: number | ObservationMetricOptions = Date.now(),
): void {
  const options =
    typeof input === 'number' ? { nowMs: input, successfulInspectionAtMs: input } : input;
  const nowMs = finiteTimestamp(options.nowMs ?? Date.now(), 'nowMs');
  const successfulInspectionAtMs = finiteTimestamp(
    options.successfulInspectionAtMs ?? nowMs,
    'successfulInspectionAtMs',
  );
  const provider = providerLabel(observation.providerId);

  recordProviderHealth(provider, observation.health);
  updateWindowMetrics(provider, observation, nowMs);
  latestObservations.set(provider, observation);
  lastSuccessfulInspectionTimestampSeconds.set({ provider }, successfulInspectionAtMs / 1000);
}

export function recordProviderHealth(
  providerId: string,
  health: ProviderObservation['health'],
): void {
  const provider = providerLabel(providerId);
  providerUp.set({ provider }, health === 'UP' ? 1 : 0);
}

export function recordInspection(providerId: string, result: InspectionResult): void {
  inspectionTotal.inc({
    provider: providerLabel(providerId),
    result: boundedEnum(result, inspectionResults, 'inspection result'),
  });
}

export function recordTrigger(providerId: string, result: TriggerResult): void {
  triggerTotal.inc({
    provider: providerLabel(providerId),
    result: boundedEnum(result, triggerResults, 'trigger result'),
  });
}

export function recordSchedulerDecision(
  providerId: string,
  decision: SchedulerDecisionMetric,
): void {
  schedulerDecisionsTotal.inc({
    provider: providerLabel(providerId),
    decision: boundedEnum(decision, schedulerDecisions, 'scheduler decision'),
  });
}

export function setActionIntentCount(
  providerId: string,
  state: ActionIntentState,
  count: number,
): void {
  const provider = providerLabel(providerId);
  const boundedState = boundedEnum(state, actionIntentStates, 'action intent state');
  if (!Number.isFinite(count) || count < 0) {
    throw new RangeError('action intent count must be a finite non-negative number');
  }
  actionIntents.set({ provider, state: boundedState }, count);
  const states = knownActionIntentStates.get(provider) ?? new Set<ActionIntentState>();
  states.add(boundedState);
  knownActionIntentStates.set(provider, states);
}

export function setActionIntentCounts(
  providerId: string,
  counts: Partial<Record<ActionIntentState, number>>,
): void {
  const provider = providerLabel(providerId);
  const nextStates = new Set<ActionIntentState>();

  for (const [state, count] of Object.entries(counts)) {
    const boundedState = boundedEnum(state, actionIntentStates, 'action intent state');
    if (count === undefined) continue;
    if (!Number.isFinite(count) || count < 0) {
      throw new RangeError('action intent count must be a finite non-negative number');
    }
    actionIntents.set({ provider, state: boundedState }, count);
    nextStates.add(boundedState);
  }

  const previousStates = knownActionIntentStates.get(provider) ?? new Set<ActionIntentState>();
  for (const state of previousStates) {
    if (!nextStates.has(state)) {
      actionIntents.remove({ provider, state });
    }
  }
  if (nextStates.size === 0) {
    knownActionIntentStates.delete(provider);
  } else {
    knownActionIntentStates.set(provider, nextStates);
  }
}

export function refreshObservationMetrics(nowMs = Date.now()): void {
  const now = finiteTimestamp(nowMs, 'nowMs');
  for (const [provider, observation] of latestObservations) {
    updateWindowMetrics(provider, observation, now);
  }
}

export function clearProviderObservationMetrics(providerId: string): void {
  const provider = providerLabel(providerId);
  const windows = knownWindowKinds.get(provider) ?? new Set<string>();
  for (const window of windows) removeWindowMetrics(provider, window);
  knownWindowKinds.delete(provider);
  latestObservations.delete(provider);
}

export function clearActionIntentMetrics(providerId: string): void {
  const provider = providerLabel(providerId);
  const states = knownActionIntentStates.get(provider) ?? new Set<ActionIntentState>();
  for (const state of states) actionIntents.remove({ provider, state });
  knownActionIntentStates.delete(provider);
}

export function resetMetricState(): void {
  providerUp.reset();
  usageRatio.reset();
  remainingRatio.reset();
  secondsUntilReset.reset();
  ageSeconds.reset();
  inspectionTotal.reset();
  triggerTotal.reset();
  schedulerDecisionsTotal.reset();
  actionIntents.reset();
  lastSuccessfulInspectionTimestampSeconds.reset();
  latestObservations.clear();
  knownWindowKinds.clear();
  knownActionIntentStates.clear();
}

export const metricsCallbacks: MetricsCallbacks = {
  onObservation: recordObservation,
  onProviderHealth: recordProviderHealth,
  onInspection: recordInspection,
  onTrigger: recordTrigger,
  onSchedulerDecision: recordSchedulerDecision,
  onActionIntentCounts: setActionIntentCounts,
};

function updateWindowMetrics(
  provider: string,
  observation: ProviderObservation,
  nowMs: number,
): void {
  const currentWindows = new Set(observation.windows.map((window) => window.windowKind));
  const previousWindows = knownWindowKinds.get(provider) ?? new Set<string>();

  for (const window of previousWindows) {
    if (!currentWindows.has(window)) removeWindowMetrics(provider, window);
  }

  for (const window of observation.windows) {
    const windowLabel = windowLabelValue(window.windowKind);
    const labels = { provider, window: windowLabel };
    if (window.usageRatio) usageRatio.set(labels, window.usageRatio.value);
    else usageRatio.remove(labels);
    if (window.remainingRatio) remainingRatio.set(labels, window.remainingRatio.value);
    else remainingRatio.remove(labels);

    const observedAtMs = finiteDate(window.observedAt, 'window observedAt');
    ageSeconds.set(labels, Math.max(0, (nowMs - observedAtMs) / 1000));

    if (window.resetAt) {
      const resetAtMs = finiteDate(window.resetAt.value, 'window resetAt');
      secondsUntilReset.set(labels, Math.max(0, (resetAtMs - nowMs) / 1000));
    } else {
      secondsUntilReset.remove(labels);
    }
  }

  knownWindowKinds.set(provider, currentWindows);
}

function removeWindowMetrics(provider: string, window: string): void {
  const labels = { provider, window };
  usageRatio.remove(labels);
  remainingRatio.remove(labels);
  secondsUntilReset.remove(labels);
  ageSeconds.remove(labels);
}

function providerLabel(value: string): string {
  return boundedIdentifierLabel(value, 'provider');
}

function windowLabelValue(value: string): string {
  return boundedIdentifierLabel(value, 'window');
}

function boundedIdentifierLabel(value: string, labelName: string): string {
  if (value.length === 0 || value.length > MAX_LABEL_LENGTH || !boundedIdentifier.test(value)) {
    throw new RangeError(`${labelName} label must be a bounded machine identifier`);
  }
  return value;
}

function boundedEnum<T extends string>(value: string, allowed: readonly T[], labelName: string): T {
  if (!allowed.includes(value as T)) {
    throw new RangeError(`${labelName} label is not supported`);
  }
  return value as T;
}

function finiteTimestamp(value: number, field: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${field} must be finite`);
  return value;
}

function finiteDate(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new RangeError(`${field} must be a valid instant`);
  return timestamp;
}
