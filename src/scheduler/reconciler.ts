import { randomUUID } from 'node:crypto';
import { parseProviderObservation } from '../domain/schemas.js';
import { resolveWindowTarget } from '../domain/window-target.js';
import type { ProviderObservation } from '../domain/types.js';
import type { ProviderAdapter } from '../providers/provider.js';
import { decideTargetReset, type SchedulerDecision } from './decision.js';
import { deriveCurrentWindow, deriveCurrentWindowForTarget } from './current-window.js';
import { planWindowAction, type PlannerDecision } from './planner.js';
import { activationPolicyFromRecord } from './policy.js';
import {
  activationPolicyId,
  activationPolicyScopes,
  windowKindBelongsToPolicyScope,
} from './policy-scope.js';
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

export type InspectionMetricResult =
  'success' | 'auth_required' | 'provider_unavailable' | 'invalid_response' | 'failed';

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
  onInspection?: (providerId: string, result: InspectionMetricResult) => void;
  onSchedulerDecision?: (providerId: string, decision: SchedulerDecision['kind']) => void;
}

export interface ReconcileDecisionResult {
  providerId: string;
  policyId: string;
  decision: SchedulerDecision | PlannerDecision;
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
          this.input.onInspection?.(provider.id, 'provider_unavailable');
          inspectionFailed = true;
        } else {
          const inspection = await this.inspect(adapter);
          if (inspection.ok) {
            state = this.persistObservation(provider, inspection.observation, nowMs, previousState);
            this.input.onInspection?.(provider.id, 'success');
            this.input.onObservation?.(inspection.observation);
          } else {
            this.recordFailure(provider, previousState, nowMs, inspection.code);
            this.input.onInspection?.(provider.id, inspectionMetricResult(inspection.code));
            inspectionFailed = true;
          }
        }
      }

      if (!adapter) continue;
      if (inspectionFailed || !state?.observation || state.health !== 'UP') continue;

      const policies = this.input.repositories.schedulePolicies.list(provider.id);
      const activationPolicyIds = new Set(
        activationPolicyScopes(provider.kind).map((scope) =>
          activationPolicyId(provider.id, scope),
        ),
      );
      const hasActivationPolicy = policies.some(
        (candidate) => candidate.scope !== 'legacy' && activationPolicyIds.has(candidate.id),
      );
      for (const policy of policies) {
        if (policy.scope === 'legacy') continue;
        if (
          provider.kind === 'antigravity' &&
          ((policy.scope !== 'gemini' && policy.scope !== 'claude_gpt') ||
            policy.id !== activationPolicyId(provider.id, policy.scope))
        ) {
          this.appendEventIfChanged({
            occurredAtMs: nowMs,
            providerId: provider.id,
            type: 'schedule_policy_invalid',
            severity: 'warn',
            reasonCode: 'POLICY_SCOPE_ID_MISMATCH',
            data: { policyId: policy.id, scope: policy.scope ?? 'default' },
          });
          continue;
        }
        if (
          hasActivationPolicy &&
          (policy.kind === 'target_reset' || policy.kind === 'work_window') &&
          !activationPolicyIds.has(policy.id)
        ) {
          continue;
        }
        if (policy.requiresReview) {
          this.appendEventIfChanged({
            occurredAtMs: nowMs,
            providerId: provider.id,
            type: 'schedule_policy_review_required',
            severity: 'warn',
            reasonCode: 'POLICY_REVIEW_REQUIRED',
            data: { policyId: policy.id, scope: policy.scope ?? 'default' },
          });
          continue;
        }
        if (!policy.enabled && policy.kind === 'target_reset') continue;
        if (policy.kind === 'target_reset') {
          const result = this.planLegacyTargetReset(provider, policy, state, adapter, now, nowMs);
          if (result) {
            decisions.push(result.result);
            if (result.intentId) createdIntentIds.push(result.intentId);
          }
          continue;
        }

        const activationPolicy = safeActivationPolicy(policy);
        if (!activationPolicy) {
          this.appendEventIfChanged({
            occurredAtMs: nowMs,
            providerId: provider.id,
            type: 'schedule_policy_invalid',
            severity: 'warn',
            reasonCode: 'INVALID_ACTIVATION_POLICY',
            data: { policyId: policy.id },
          });
          continue;
        }
        const config = asRecord(policy.config);
        const requestedWindowKind =
          typeof config.windowKind === 'string'
            ? config.windowKind
            : activationPolicyWindowKind(activationPolicy);
        if (
          provider.kind === 'antigravity' &&
          requestedWindowKind &&
          (policy.scope !== 'gemini' && policy.scope !== 'claude_gpt'
            ? true
            : !windowKindBelongsToPolicyScope(requestedWindowKind, policy.scope))
        ) {
          this.appendEventIfChanged({
            occurredAtMs: nowMs,
            providerId: provider.id,
            type: 'schedule_policy_invalid',
            severity: 'warn',
            reasonCode: 'POLICY_WINDOW_SCOPE_MISMATCH',
            data: { policyId: policy.id, scope: policy.scope ?? 'default' },
          });
          continue;
        }
        const targetResolution = resolveWindowTarget(
          requestedWindowKind,
          state.observation.windows,
        );
        const selectedWindowKind =
          targetResolution.status === 'exact' || targetResolution.status === 'legacy_resolved'
            ? targetResolution.windowKind
            : undefined;
        const currentWindowKind =
          selectedWindowKind ??
          (targetResolution.status === 'missing' ? requestedWindowKind : undefined);
        const resolvedPolicy = withResolvedWindowKind(activationPolicy, selectedWindowKind);
        const window = selectedWindowKind
          ? state.observation.windows.find(
              (candidate) => candidate.windowKind === selectedWindowKind,
            )
          : undefined;
        const decision = planWindowAction({
          now,
          providerId: provider.id,
          policy: resolvedPolicy,
          currentWindow: deriveCurrentWindowForTarget(
            provider.id,
            state.observation,
            state.health,
            currentWindowKind,
          ),
          ...(window ? { window } : {}),
          observation: {
            observedAt: state.observation.observedAt,
            staleAfterSeconds: state.observation.staleAfterSeconds,
          },
          capabilities: adapter.capabilities(),
          automationEnabled: provider.mode === 'automation',
          pendingIntents: this.input.repositories.actionIntents.listOpen(provider.id),
        });
        const result: ReconcileDecisionResult = {
          providerId: provider.id,
          policyId: policy.id,
          decision,
        };
        this.input.onSchedulerDecision?.(
          provider.id,
          decision.kind === 'START' ? 'create_intent' : 'noop',
        );

        if (decision.kind === 'START' && decision.dedupeKey) {
          const intentResult = this.createPlannerIntent(
            provider,
            policy,
            decision,
            nowMs,
            window?.windowKind,
          );
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
          this.appendEventIfChanged({
            occurredAtMs: nowMs,
            providerId: provider.id,
            type: decision.kind === 'SKIP' ? 'schedule_missed' : 'scheduler_noop',
            severity: decision.kind === 'SKIP' ? 'warn' : 'info',
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

  private planLegacyTargetReset(
    provider: ProviderRecord,
    policy: SchedulePolicyRecord,
    state: ProviderStateRecord,
    adapter: ProviderAdapter,
    now: Date,
    nowMs: number,
  ): { result: ReconcileDecisionResult; intentId?: string } | undefined {
    const targetResetAt = (this.input.resolveTargetResetAt ?? defaultResolveTargetResetAt)(
      policy,
      now,
    );
    if (!targetResetAt || !state.observation) return undefined;
    const config = asRecord(policy.config);
    const requestedWindowKind =
      typeof config.windowKind === 'string' ? config.windowKind : undefined;
    const target = resolveWindowTarget(requestedWindowKind, state.observation.windows);
    const selectedWindowKind =
      target.status === 'exact' || target.status === 'legacy_resolved'
        ? target.windowKind
        : undefined;
    const window = selectedWindowKind
      ? state.observation.windows.find((candidate) => candidate.windowKind === selectedWindowKind)
      : undefined;
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
    this.input.onSchedulerDecision?.(provider.id, decision.kind);

    if (decision.kind === 'create_intent') {
      const intentResult = this.createIntent(provider, policy, decision, nowMs);
      result.intent = intentResult.intent;
      if (intentResult.created) {
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
      return intentResult.created ? { result, intentId: intentResult.intent.id } : { result };
    }

    this.appendEventIfChanged({
      occurredAtMs: nowMs,
      providerId: provider.id,
      type: decision.reasonCode === 'TARGET_MISSED' ? 'schedule_missed' : 'scheduler_noop',
      severity: decision.reasonCode === 'TARGET_MISSED' ? 'warn' : 'info',
      reasonCode: decision.reasonCode,
      data: decision.explanation,
    });
    return { result };
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
    previousState?: ProviderStateRecord,
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
      const windowKinds = new Set([
        ...(previousState?.observation?.windows.map((window) => window.windowKind) ?? []),
        ...observation.windows.map((window) => window.windowKind),
      ]);
      for (const windowKind of windowKinds) {
        const previousWindow = deriveCurrentWindow(
          provider.id,
          previousState?.observation,
          previousState?.health,
          windowKind,
        );
        const currentWindow = deriveCurrentWindow(
          provider.id,
          observation,
          observation.health,
          windowKind,
        );
        if (previousWindow.status === 'ACTIVE' && currentWindow.status === 'INACTIVE') {
          this.input.repositories.events.append({
            occurredAtMs: nowMs,
            providerId: provider.id,
            type: 'unexpected_reset_detected',
            severity: 'warn',
            reasonCode: 'UNEXPECTED_WINDOW_RESET',
            data: { windowKind, retainedForScheduling: true },
          });
        } else if (previousWindow.status === 'INACTIVE' && currentWindow.status === 'ACTIVE') {
          this.input.repositories.events.append({
            occurredAtMs: nowMs,
            providerId: provider.id,
            type: 'external_window_started',
            severity: 'info',
            reasonCode: 'EXTERNAL_WINDOW_STARTED',
            data: { windowKind },
          });
        }
      }
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

  private createPlannerIntent(
    provider: ProviderRecord,
    policy: SchedulePolicyRecord,
    decision: PlannerDecision,
    nowMs: number,
    windowKind: string | undefined,
  ) {
    const scheduledForMs = decision.anchorAt ? Date.parse(decision.anchorAt) : nowMs;
    const explanation = {
      ...decision.explanation,
      policyUpdatedAtMs: policy.updatedAtMs,
      ...(windowKind ? { windowKind } : {}),
    };
    const intent: ActionIntentRecord = {
      id: (this.input.idFactory ?? randomUUID)(),
      providerId: provider.id,
      policyId: policy.id,
      actionType: 'trigger_window',
      dedupeKey: decision.dedupeKey ?? `${provider.id}:start_window:${policy.id}:${scheduledForMs}`,
      state: 'planned',
      scheduledForMs,
      notBeforeMs: decision.notBefore ? Date.parse(decision.notBefore) : null,
      expiresAtMs: decision.validUntil ? Date.parse(decision.validUntil) : null,
      attemptCount: 0,
      reasonCode: decision.reasonCode,
      explanation,
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

function safeActivationPolicy(policy: SchedulePolicyRecord) {
  try {
    return activationPolicyFromRecord(policy);
  } catch {
    return undefined;
  }
}

function activationPolicyWindowKind(
  policy: ReturnType<typeof activationPolicyFromRecord>,
): string | undefined {
  if (!policy || !('windowKind' in policy)) return undefined;
  return policy.windowKind;
}

function withResolvedWindowKind(
  policy: NonNullable<ReturnType<typeof activationPolicyFromRecord>>,
  windowKind: string | undefined,
): NonNullable<ReturnType<typeof activationPolicyFromRecord>> {
  if (!windowKind || !('windowKind' in policy)) return policy;
  return { ...policy, windowKind };
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

function inspectionMetricResult(code: InspectionFailureCode): InspectionMetricResult {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'auth_required';
    case 'PROVIDER_UNAVAILABLE':
      return 'provider_unavailable';
    case 'INVALID_PROVIDER_RESPONSE':
      return 'invalid_response';
    case 'INSPECTION_FAILED':
      return 'failed';
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
