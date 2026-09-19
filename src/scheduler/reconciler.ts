import { randomUUID } from 'node:crypto';
import { parseProviderObservation } from '../domain/schemas.js';
import type { ProviderObservation } from '../domain/types.js';
import type { ProviderAdapter } from '../providers/provider.js';
import { decideTargetReset, type SchedulerDecision } from './decision.js';
import type { Clock } from './clock.js';
import type { SqliteDatabase } from '../storage/database.js';
import {
  withTransaction,
  type ActionIntentRecord,
  type EventRecord,
  type ProviderRecord,
  type ProviderStateRecord,
  type SchedulePolicyRecord,
  type StorageRepositories,
} from '../storage/repositories.js';

export type InspectionFailureCode =
  'AUTH_REQUIRED' | 'PROVIDER_UNAVAILABLE' | 'INSPECTION_FAILED' | 'INVALID_PROVIDER_RESPONSE';

export interface TargetResetResolver {
  (policy: SchedulePolicyRecord, now: Date): Date | undefined;
}

export interface ReconcilerInput {
  clock: Clock;
  db: SqliteDatabase;
  repositories: StorageRepositories;
  adapters: ReadonlyMap<string, ProviderAdapter>;
  resolveTargetResetAt?: TargetResetResolver;
  idFactory?: () => string;
  onObservation?: (observation: ProviderObservation) => void;
  onInspectionFailure?: (providerId: string, health: ProviderStateRecord['health']) => void;
}

export interface ReconcileDecisionResult {
  providerId: string;
  policyId: string;
  decision: SchedulerDecision;
  intent?: ActionIntentRecord;
}

export interface ReconcileReport {
  startedAtMs: number;
  finishedAtMs: number;
  skipped: boolean;
  inspectedProviderIds: string[];
  decisions: ReconcileDecisionResult[];
  createdIntentIds: string[];
}

const defaultResolveTargetResetAt: TargetResetResolver = (policy) => {
  const config = asRecord(policy.config);
  const targetResetAt = config.targetResetAt;
  if (typeof targetResetAt !== 'string') return undefined;
  const parsed = new Date(targetResetAt);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export class Reconciler {
  private running = false;

  constructor(private readonly input: ReconcilerInput) {}

  async reconcile(): Promise<ReconcileReport> {
    const startedAtMs = this.input.clock.now().getTime();
    if (this.running) {
      return {
        startedAtMs,
        finishedAtMs: this.input.clock.now().getTime(),
        skipped: true,
        inspectedProviderIds: [],
        decisions: [],
        createdIntentIds: [],
      };
    }

    this.running = true;
    try {
      return await this.run(startedAtMs);
    } finally {
      this.running = false;
    }
  }

  private async run(startedAtMs: number): Promise<ReconcileReport> {
    const now = this.input.clock.now();
    const nowMs = now.getTime();
    const inspectedProviderIds: string[] = [];
    const decisions: ReconcileDecisionResult[] = [];
    const createdIntentIds: string[] = [];

    for (const provider of this.input.repositories.providers.list()) {
      if (!provider.enabled) continue;

      const adapter = this.input.adapters.get(provider.id);
      const previousState = this.input.repositories.providerState.get(provider.id);
      let state = previousState;
      let inspectionFailed = false;

      if (this.isDue(provider, previousState, nowMs)) {
        inspectedProviderIds.push(provider.id);
        if (!adapter) {
          this.recordFailure(provider, previousState, nowMs, 'PROVIDER_UNAVAILABLE');
          inspectionFailed = true;
        } else {
          const inspection = await this.inspect(adapter);
          if (inspection.ok) {
            state = this.persistObservation(provider, inspection.observation, nowMs);
            this.input.onObservation?.(inspection.observation);
          } else {
            this.recordFailure(provider, previousState, nowMs, inspection.code);
            inspectionFailed = true;
          }
        }
      }

      if (!adapter) continue;
      if (inspectionFailed || !state?.observation || state.health !== 'UP') continue;

      for (const policy of this.input.repositories.schedulePolicies.list(provider.id)) {
        if (!policy.enabled || policy.kind !== 'target_reset') continue;

        const targetResetAt = (this.input.resolveTargetResetAt ?? defaultResolveTargetResetAt)(
          policy,
          now,
        );
        if (!targetResetAt) continue;

        const config = asRecord(policy.config);
        const window = selectWindow(state.observation, config.windowKind);
        const toleranceSeconds = positiveInteger(config.toleranceSeconds) ?? 30;
        const decision = decideTargetReset({
          now,
          providerId: provider.id,
          policyId: policy.id,
          targetResetAt,
          ...(window ? { window } : {}),
          observation: {
            observedAt: state.observation.observedAt,
            staleAfterSeconds: state.observation.staleAfterSeconds,
          },
          capabilities: adapter.capabilities(),
          automationEnabled: provider.mode === 'automation',
          toleranceSeconds,
        });
        const result: ReconcileDecisionResult = {
          providerId: provider.id,
          policyId: policy.id,
          decision,
        };

        if (decision.kind === 'create_intent') {
          const intentResult = this.createIntent(provider, policy, decision, nowMs);
          result.intent = intentResult.intent;
          if (intentResult.created) {
            createdIntentIds.push(intentResult.intent.id);
            this.appendEventIfChanged({
              occurredAtMs: nowMs,
              providerId: provider.id,
              type: 'action_intent_planned',
              severity: 'info',
              reasonCode: decision.reasonCode,
              data: {
                intentId: intentResult.intent.id,
                dedupeKey: intentResult.intent.dedupeKey,
                explanation: decision.explanation,
              },
            });
          }
        } else {
          const type =
            decision.reasonCode === 'TARGET_MISSED' ? 'schedule_missed' : 'scheduler_noop';
          this.appendEventIfChanged({
            occurredAtMs: nowMs,
            providerId: provider.id,
            type,
            severity: decision.reasonCode === 'TARGET_MISSED' ? 'warn' : 'info',
            reasonCode: decision.reasonCode,
            data: decision.explanation,
          });
        }

        decisions.push(result);
      }
    }

    return {
      startedAtMs,
      finishedAtMs: this.input.clock.now().getTime(),
      skipped: false,
      inspectedProviderIds,
      decisions,
      createdIntentIds,
    };
  }

  private isDue(
    provider: ProviderRecord,
    state: ProviderStateRecord | undefined,
    nowMs: number,
  ): boolean {
    if (!state) return true;
    return nowMs - state.updatedAtMs >= provider.pollIntervalSeconds * 1000;
  }

  private async inspect(
    adapter: ProviderAdapter,
  ): Promise<
    { ok: true; observation: ProviderObservation } | { ok: false; code: InspectionFailureCode }
  > {
    try {
      const observation = parseProviderObservation(await adapter.inspect({}));
      if (observation.providerId !== adapter.id) {
        return { ok: false, code: 'INVALID_PROVIDER_RESPONSE' };
      }
      if (observation.health !== 'UP') {
        return { ok: false, code: healthToFailureCode(observation.health) };
      }
      return { ok: true, observation };
    } catch (error) {
      return { ok: false, code: classifyInspectionError(error) };
    }
  }

  private persistObservation(
    provider: ProviderRecord,
    observation: ProviderObservation,
    nowMs: number,
  ): ProviderStateRecord {
    const state: ProviderStateRecord = {
      providerId: provider.id,
      health: observation.health,
      observedAtMs: Date.parse(observation.observedAt),
      staleAfterMs: observation.staleAfterSeconds * 1000,
      observation,
      lastSuccessAtMs: nowMs,
      lastErrorCode: null,
      updatedAtMs: nowMs,
    };

    withTransaction(this.input.db, () => {
      this.input.repositories.providerState.upsert(state);
      for (const window of observation.windows) {
        this.input.repositories.windowSamples.insert(window);
      }
      this.input.repositories.events.append({
        occurredAtMs: nowMs,
        providerId: provider.id,
        type: 'provider_inspected',
        severity: 'info',
        reasonCode: null,
        data: {
          health: observation.health,
          windowKinds: observation.windows.map((window) => window.windowKind),
        },
      });
    });

    return state;
  }

  private recordFailure(
    provider: ProviderRecord,
    previousState: ProviderStateRecord | undefined,
    nowMs: number,
    code: InspectionFailureCode,
  ): void {
    const health = failureCodeToHealth(code);
    const state: ProviderStateRecord = {
      providerId: provider.id,
      health,
      observedAtMs: previousState?.observedAtMs ?? null,
      staleAfterMs: previousState?.staleAfterMs ?? null,
      observation: previousState?.observation ?? null,
      lastSuccessAtMs: previousState?.lastSuccessAtMs ?? null,
      lastErrorCode: code,
      updatedAtMs: nowMs,
    };
    this.input.repositories.providerState.upsert(state);
    this.input.onInspectionFailure?.(provider.id, health);

    const type = code === 'AUTH_REQUIRED' ? 'provider_auth_required' : 'provider_inspection_failed';
    this.appendEventIfChanged({
      occurredAtMs: nowMs,
      providerId: provider.id,
      type,
      severity: 'warn',
      reasonCode: code,
      data: { failureCode: code, retainedLastKnownGood: Boolean(previousState?.observation) },
    });
  }

  private createIntent(
    provider: ProviderRecord,
    policy: SchedulePolicyRecord,
    decision: Extract<SchedulerDecision, { kind: 'create_intent' }>,
    nowMs: number,
  ) {
    const scheduledForMs = Date.parse(decision.targetTriggerAt);
    const intent: ActionIntentRecord = {
      id: (this.input.idFactory ?? randomUUID)(),
      providerId: provider.id,
      policyId: policy.id,
      actionType: 'trigger_window',
      dedupeKey: decision.dedupeKey,
      state: 'planned',
      scheduledForMs,
      notBeforeMs: null,
      expiresAtMs: scheduledForMs + decision.explanation.toleranceSeconds * 1000,
      attemptCount: 0,
      reasonCode: decision.reasonCode,
      explanation: decision.explanation,
      lastErrorCode: null,
      createdAtMs: nowMs,
      startedAtMs: null,
      finishedAtMs: null,
      updatedAtMs: nowMs,
    };
    return this.input.repositories.actionIntents.createIfAbsent(intent);
  }

  private appendEventIfChanged(event: EventRecord): void {
    const recent = this.input.repositories.events.list(event.providerId ?? undefined, {
      limit: 50,
    });
    const eventPolicyId = policyIdFromEventData(event.data);
    const previous = recent.find(
      (candidate) =>
        candidate.type === event.type &&
        candidate.reasonCode === event.reasonCode &&
        policyIdFromEventData(candidate.data) === eventPolicyId,
    );
    if (previous && JSON.stringify(previous.data) === JSON.stringify(event.data)) {
      return;
    }
    this.input.repositories.events.append(event);
  }
}

function policyIdFromEventData(value: unknown): string | null {
  const data = asRecord(value);
  const explanation = asRecord(data.explanation);
  const policyId = explanation.policyId ?? data.policyId;
  return typeof policyId === 'string' ? policyId : null;
}

function selectWindow(
  observation: ProviderObservation,
  windowKind: unknown,
): ProviderObservation['windows'][number] | undefined {
  if (typeof windowKind === 'string') {
    return observation.windows.find((window) => window.windowKind === windowKind);
  }
  return observation.windows[0];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function healthToFailureCode(health: ProviderObservation['health']): InspectionFailureCode {
  switch (health) {
    case 'AUTH_REQUIRED':
      return 'AUTH_REQUIRED';
    case 'UNAVAILABLE':
      return 'PROVIDER_UNAVAILABLE';
    case 'DEGRADED':
      return 'INVALID_PROVIDER_RESPONSE';
    case 'ERROR':
      return 'INSPECTION_FAILED';
    case 'UP':
      return 'INSPECTION_FAILED';
  }
}

function failureCodeToHealth(code: InspectionFailureCode): ProviderStateRecord['health'] {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'AUTH_REQUIRED';
    case 'PROVIDER_UNAVAILABLE':
      return 'UNAVAILABLE';
    case 'INVALID_PROVIDER_RESPONSE':
      return 'DEGRADED';
    case 'INSPECTION_FAILED':
      return 'ERROR';
  }
}

function classifyInspectionError(error: unknown): InspectionFailureCode {
  if (typeof error === 'object' && error !== null) {
    const code = 'code' in error ? error.code : undefined;
    if (code === 'AUTH_REQUIRED') return 'AUTH_REQUIRED';
    if (code === 'PROVIDER_UNAVAILABLE' || code === 'ETIMEDOUT' || code === 'EOF') {
      return 'PROVIDER_UNAVAILABLE';
    }
    if (code === 'INVALID_PROVIDER_RESPONSE') return 'INVALID_PROVIDER_RESPONSE';
  }
  return 'INSPECTION_FAILED';
}
