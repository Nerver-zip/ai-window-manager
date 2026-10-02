import { randomUUID } from 'node:crypto';
import type { ReadPurpose } from '../providers/read-backoff-policy.js';
import { parseProviderObservation } from '../domain/schemas.js';
import type { ProviderCleanupArtifact } from '../domain/provider-cleanup.js';
import { resolveWindowTarget } from '../domain/window-target.js';
import { activationPolicyId, policyScopeForWindowKind } from './policy-scope.js';
import type {
  ProviderActionResult,
  ProviderActionStatus,
  ProviderObservation,
} from '../domain/types.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { ProviderInspectionCoordinator } from '../providers/inspection-coordinator.js';
import type { Clock } from './clock.js';
import type {
  ActionIntentRecord,
  ActionResolutionRequest,
  EventRecord,
  StorageRepositories,
} from '../storage/repositories.js';
import type { SqliteDatabase } from '../storage/database.js';
import { withTransaction } from '../storage/repositories.js';
import { trackWindowCycles } from './window-cycle.js';
import { actionDeadlineExpired as intentExpired } from '../domain/action-deadline.js';
import { DispatchAuthorizationError } from '../providers/dispatch-authorization.js';
import { assessActionResolution } from './action-resolution-policy.js';

export const ActionReasonCode = {
  IntentExpired: 'ACTION_INTENT_EXPIRED',
  NotBefore: 'ACTION_NOT_BEFORE',
  CapabilityUnavailable: 'ACTION_CAPABILITY_UNAVAILABLE',
  ProviderUnavailable: 'ACTION_PROVIDER_UNAVAILABLE',
  PreflightRejected: 'ACTION_PREFLIGHT_REJECTED',
  DispatchRejected: 'ACTION_DISPATCH_REJECTED',
  DispatchFailed: 'ACTION_DISPATCH_FAILED',
  DispatchUncertain: 'ACTION_DISPATCH_UNCERTAIN',
  ConfirmationFailed: 'ACTION_CONFIRMATION_FAILED',
  Confirmed: 'ACTION_CONFIRMED',
  RecoveryRequired: 'ACTION_RECOVERY_REQUIRED',
  AlreadySatisfied: 'ACTION_ALREADY_SATISFIED',
  PolicyChanged: 'ACTION_POLICY_CHANGED',
  TargetWindowMissing: 'ACTION_TARGET_WINDOW_MISSING',
  CycleChanged: 'ACTION_WINDOW_CYCLE_CHANGED',
  RuntimeChanging: 'ACTION_PROVIDER_RUNTIME_CHANGING',
} as const;

export type ActionReasonCode = (typeof ActionReasonCode)[keyof typeof ActionReasonCode];

export type ActionExecutorPhase =
  | 'after_claim'
  | 'before_dispatch'
  | 'after_dispatch_before_result'
  | 'after_succeeded_before_confirmation'
  | 'during_confirmation';

export interface ActionExecutorInput {
  clock: Clock;
  db: SqliteDatabase;
  repositories: StorageRepositories;
  adapters: ReadonlyMap<string, ProviderAdapter>;
  inspections?: ProviderInspectionCoordinator;
  confirmationBaseIntervalMs?: number;
  confirmationMaxBackoffMs?: number;
  /** Defers provider reads/actions while its executable is being replaced or rolled back. */
  isProviderRuntimeChanging?: (providerId: string) => boolean;
  retryDelayMs?: number;
  onPhase?: (phase: ActionExecutorPhase, intent: ActionIntentRecord) => void | Promise<void>;
  onTrigger?: (providerId: string, result: ProviderActionStatus) => void;
}

export interface ActionExecutorReport {
  skipped: boolean;
  recoveredIntentIds: string[];
  processedIntentIds: string[];
  confirmedIntentIds: string[];
  uncertainIntentIds: string[];
  skippedIntentIds: string[];
}

interface FreshInspection {
  observation?: ProviderObservation;
  failureCode?: 'AUTH_REQUIRED' | 'PROVIDER_UNAVAILABLE' | 'INSPECTION_FAILED';
}

const definitelyPreDispatchErrors = new Set([
  'AUTH_REQUIRED',
  'CAPABILITY_UNAVAILABLE',
  'PROCESS_START_FAILED',
  'PROVIDER_NOT_AVAILABLE',
  'PROVIDER_UNAVAILABLE',
  'CLEANUP_REGISTRATION_FAILED',
]);
const DEFAULT_CONFIRMATION_BASE_INTERVAL_MS = 30_000;
const DEFAULT_CONFIRMATION_MAX_BACKOFF_MS = 300_000;

export class ActionExecutor {
  private running = false;

  constructor(private readonly input: ActionExecutorInput) {}

  async executeDue(): Promise<ActionExecutorReport> {
    if (this.running) {
      return emptyReport(true);
    }
    this.running = true;
    try {
      return await this.run();
    } finally {
      this.running = false;
    }
  }

  private async run(): Promise<ActionExecutorReport> {
    const nowMs = this.input.clock.now().getTime();
    const report = emptyReport(false);
    this.recoverExecuting(nowMs, report);
    const handledProviderIds = new Set<string>();

    for (const intent of this.input.repositories.actionIntents.listOpen()) {
      const current = this.input.repositories.actionIntents.get(intent.id);
      if (!current) continue;
      if (handledProviderIds.has(current.providerId)) continue;

      if (current.state === 'uncertain' || current.state === 'succeeded') {
        // Existing outcomes must be resolved before a sibling family may run.
        // Even if confirmation succeeds now, the sibling is reconsidered next tick.
        handledProviderIds.add(current.providerId);
        const resolution = this.input.repositories.actionIntents.resolutionRequest(current.id);
        if (resolution?.state === 'pending') {
          await this.resolveUnknown(current, resolution);
          continue;
        }
        if (current.confirmationNotBeforeMs !== null && nowMs < current.confirmationNotBeforeMs) {
          continue;
        }
        await this.confirmExisting(current, report);
        continue;
      }

      if (current.state !== 'planned' && current.state !== 'failed_retryable') continue;
      const previousAttemptCount = current.attemptCount;
      await this.executeCandidate(current, report);
      const updated = this.input.repositories.actionIntents.get(current.id);
      // Skipped/expired intents did not cross the action boundary and should
      // not starve a later valid intent. Once claimed, however, serialize this
      // provider for the rest of the tick regardless of the immediate outcome.
      if (updated && updated.attemptCount > previousAttemptCount) {
        handledProviderIds.add(current.providerId);
      }
    }

    return report;
  }

  private recoverExecuting(nowMs: number, report: ActionExecutorReport): void {
    for (const intent of this.input.repositories.actionIntents.listOpen()) {
      if (intent.state !== 'executing') continue;
      if (!this.input.repositories.actionIntents.recoverExecuting(intent.id, nowMs)) continue;
      report.recoveredIntentIds.push(intent.id);
      this.appendEventOnce({
        occurredAtMs: nowMs,
        providerId: intent.providerId,
        type: 'action_recovery_started',
        severity: 'warn',
        reasonCode: ActionReasonCode.RecoveryRequired,
        data: safeIntentData(intent),
      });
    }
  }

  private async executeCandidate(
    intent: ActionIntentRecord,
    report: ActionExecutorReport,
  ): Promise<void> {
    if (this.input.isProviderRuntimeChanging?.(intent.providerId)) return;
    let nowMs = this.input.clock.now().getTime();
    if (intent.expiresAtMs !== null && intentExpired(intent, nowMs)) {
      if (
        this.input.repositories.actionIntents.markSkippedIfPlannedOrRetryable(
          intent.id,
          nowMs,
          ActionReasonCode.IntentExpired,
        )
      ) {
        report.skippedIntentIds.push(intent.id);
        this.appendEventOnce(
          this.actionEvent(intent, 'action_skipped', ActionReasonCode.IntentExpired),
        );
      }
      return;
    }
    if (intent.notBeforeMs !== null && nowMs < intent.notBeforeMs) return;
    const targetWindowKind = windowKindFor(intent);
    if (!targetWindowKind) {
      this.markSkipped(intent, nowMs, ActionReasonCode.TargetWindowMissing, report);
      return;
    }

    const provider = this.input.repositories.providers.get(intent.providerId);
    const adapter = this.input.adapters.get(intent.providerId);
    if (!policyStillCurrent(this.input.repositories, intent)) {
      this.markSkipped(intent, nowMs, ActionReasonCode.PolicyChanged, report);
      return;
    }
    if (!provider || !provider.enabled || provider.mode !== 'automation' || !adapter) {
      this.markSkipped(intent, nowMs, ActionReasonCode.ProviderUnavailable, report);
      return;
    }
    if (
      !triggerCapabilityAvailable(adapter, targetWindowKind) ||
      typeof adapter.triggerWindow !== 'function'
    ) {
      this.markSkipped(intent, nowMs, ActionReasonCode.CapabilityUnavailable, report);
      return;
    }

    if (this.input.inspections?.isDeferred(intent.providerId, 'preflight')) return;
    const preflight = await this.inspect(adapter, true);
    nowMs = this.input.clock.now().getTime();
    const rejection = this.dispatchRejection(intent, adapter);
    if (rejection) {
      this.markSkipped(intent, nowMs, rejection, report);
      return;
    }
    if (!preflight.observation) {
      this.markRetryable(intent, nowMs, preflight.failureCode ?? 'INSPECTION_FAILED', report);
      return;
    }
    const dispatchObservation = preflight.observation;
    if (!policyStillCurrent(this.input.repositories, intent, preflight.observation)) {
      this.markSkipped(intent, nowMs, ActionReasonCode.PolicyChanged, report);
      return;
    }
    if (!this.cycleStillCurrent(intent)) {
      this.markSkipped(intent, nowMs, ActionReasonCode.CycleChanged, report);
      return;
    }
    if (!isEligibleForTrigger(preflight.observation, intent)) {
      if (
        typeof asRecord(intent.explanation).observedCycleAt === 'string' &&
        windowFor(preflight.observation, intent)?.phase.value === 'UNKNOWN'
      ) {
        this.markRetryable(intent, nowMs, ActionReasonCode.PreflightRejected, report);
        return;
      }
      this.markSkipped(intent, nowMs, ActionReasonCode.AlreadySatisfied, report);
      return;
    }

    if (asRecord(intent.explanation).observedCycleAt === undefined) {
      const cycle = this.input.repositories.windowCycles.get(intent.providerId, targetWindowKind);
      if (!cycle) {
        this.markSkipped(intent, nowMs, ActionReasonCode.CycleChanged, report);
        return;
      }
      const bound = this.input.repositories.actionIntents.bindObservedCycle(
        intent,
        targetWindowKind,
        cycle.cycleAtMs,
        nowMs,
      );
      if (!bound) return;
      intent = bound;
    }

    const claimed =
      intent.state === 'planned'
        ? this.input.repositories.actionIntents.claimPlanned(intent.id, nowMs)
        : this.input.repositories.actionIntents.claimRetryable(intent.id, nowMs);
    if (!claimed) return;

    report.processedIntentIds.push(intent.id);
    this.appendEventOnce(this.actionEvent(claimed, 'action_intent_claimed', 'ACTION_CLAIMED'));
    await this.phase('after_claim', claimed);
    await this.phase('before_dispatch', claimed);
    this.appendEventOnce(
      this.actionEvent(claimed, 'action_dispatch_started', 'ACTION_DISPATCH_STARTED'),
    );
    let result: ProviderActionResult;
    try {
      this.assertDispatchAllowed(claimed, adapter, dispatchObservation);
      result = await adapter.triggerWindow(
        {
          assertDispatchAllowed: () =>
            this.assertDispatchAllowed(claimed, adapter, dispatchObservation),
          registerCleanupArtifact: (artifact: ProviderCleanupArtifact) =>
            Promise.resolve().then(() => {
              const registeredAtMs = this.input.clock.now().getTime();
              if (!Number.isSafeInteger(registeredAtMs)) {
                throw new Error('cleanup registration clock is invalid');
              }
              this.input.repositories.providerCleanupJobs.createIfAbsent({
                id: randomUUID(),
                providerId: claimed.providerId,
                artifactKind: artifact.kind,
                externalId: artifact.externalId,
                state: 'pending',
                attemptCount: 0,
                notBeforeMs: registeredAtMs,
                lastErrorCode: null,
                createdAtMs: registeredAtMs,
                updatedAtMs: registeredAtMs,
              });
            }),
        },
        {
          intentId: claimed.id,
          dedupeKey: claimed.dedupeKey,
          reasonCode: claimed.reasonCode,
          ...(targetWindowKind ? { windowKind: targetWindowKind } : {}),
        },
      );
    } catch (error) {
      if (error instanceof DispatchAuthorizationError) {
        const rejectedAtMs = this.input.clock.now().getTime();
        if (
          this.input.repositories.actionIntents.markSkippedBeforeDispatch(
            claimed.id,
            rejectedAtMs,
            error.reasonCode,
          )
        ) {
          report.skippedIntentIds.push(claimed.id);
          this.appendEventOnce(this.actionEvent(claimed, 'action_skipped', error.reasonCode));
        }
        return;
      }
      this.input.inspections?.markActionCompleted(claimed.providerId);
      this.input.onTrigger?.(claimed.providerId, 'uncertain');
      this.handleDispatchException(claimed, error, report);
      return;
    }

    this.input.inspections?.markActionCompleted(claimed.providerId);
    this.input.onTrigger?.(claimed.providerId, result.status);
    await this.phase('after_dispatch_before_result', claimed);
    nowMs = this.input.clock.now().getTime();
    if (result.status === 'succeeded') {
      if (!this.input.repositories.actionIntents.markSucceededIfExecuting(claimed.id, nowMs))
        return;
      this.appendEventOnce(this.actionEvent(claimed, 'action_succeeded', 'ACTION_SUCCEEDED'));
      const succeeded = this.input.repositories.actionIntents.get(claimed.id);
      if (!succeeded) return;
      await this.phase('after_succeeded_before_confirmation', succeeded);
      await this.confirmExisting(succeeded, report);
      return;
    }

    if (result.status === 'rejected') {
      if (
        this.input.repositories.actionIntents.markTerminalIfExecuting(
          claimed.id,
          nowMs,
          result.errorCode ?? ActionReasonCode.DispatchRejected,
        )
      ) {
        this.appendEventOnce(
          this.actionEvent(claimed, 'action_failed_terminal', ActionReasonCode.DispatchRejected, {
            errorCode: result.errorCode,
          }),
        );
      }
      return;
    }

    if (result.status === 'failed' && isDefinitelyPreDispatch(result.errorCode)) {
      this.markRetryable(
        claimed,
        nowMs,
        result.errorCode ?? ActionReasonCode.DispatchFailed,
        report,
      );
      return;
    }

    if (
      this.input.repositories.actionIntents.markUncertainIfExecuting(
        claimed.id,
        nowMs,
        result.errorCode ?? ActionReasonCode.DispatchUncertain,
      )
    ) {
      report.uncertainIntentIds.push(claimed.id);
      this.appendEventOnce(
        this.actionEvent(claimed, 'action_uncertain', ActionReasonCode.DispatchUncertain, {
          errorCode: result.errorCode,
        }),
      );
    }
  }

  private dispatchRejection(
    intent: ActionIntentRecord,
    adapter: ProviderAdapter,
  ): ActionReasonCode | undefined {
    const nowMs = this.input.clock.now().getTime();
    if (intentExpired(intent, nowMs)) return ActionReasonCode.IntentExpired;
    try {
      if (this.input.isProviderRuntimeChanging?.(intent.providerId) !== false) {
        return ActionReasonCode.RuntimeChanging;
      }
    } catch {
      return ActionReasonCode.RuntimeChanging;
    }
    const provider = this.input.repositories.providers.get(intent.providerId);
    if (
      !provider?.enabled ||
      provider.mode !== 'automation' ||
      this.input.adapters.get(intent.providerId) !== adapter
    ) {
      return ActionReasonCode.ProviderUnavailable;
    }
    if (!policyStillCurrent(this.input.repositories, intent)) return ActionReasonCode.PolicyChanged;
    if (!this.cycleStillCurrent(intent)) return ActionReasonCode.CycleChanged;
    const target = windowKindFor(intent);
    if (
      !target ||
      !triggerCapabilityAvailable(adapter, target) ||
      typeof adapter.triggerWindow !== 'function'
    ) {
      return ActionReasonCode.CapabilityUnavailable;
    }
    return undefined;
  }

  private assertDispatchAllowed(
    intent: ActionIntentRecord,
    adapter: ProviderAdapter,
    observation: ProviderObservation,
  ): void {
    const reason = this.dispatchRejection(intent, adapter);
    if (reason) throw new DispatchAuthorizationError(reason);
    const ageMs = this.input.clock.now().getTime() - Date.parse(observation.observedAt);
    if (ageMs < 0 || ageMs > observation.staleAfterSeconds * 1000) {
      throw new DispatchAuthorizationError(ActionReasonCode.PreflightRejected);
    }
    if (this.input.repositories.actionIntents.get(intent.id)?.state !== 'executing') {
      throw new DispatchAuthorizationError(ActionReasonCode.DispatchRejected);
    }
  }

  private handleDispatchException(
    intent: ActionIntentRecord,
    error: unknown,
    report: ActionExecutorReport,
  ): void {
    const errorCode = safeErrorCode(error);
    const nowMs = this.input.clock.now().getTime();
    if (isDefinitelyPreDispatch(errorCode)) {
      this.markRetryable(intent, nowMs, errorCode ?? ActionReasonCode.DispatchFailed, report);
      return;
    }
    if (
      this.input.repositories.actionIntents.markUncertainIfExecuting(
        intent.id,
        nowMs,
        errorCode ?? ActionReasonCode.DispatchUncertain,
      )
    ) {
      report.uncertainIntentIds.push(intent.id);
      this.appendEventOnce(
        this.actionEvent(intent, 'action_uncertain', ActionReasonCode.DispatchUncertain),
      );
    }
  }

  private async resolveUnknown(
    intent: ActionIntentRecord,
    request: ActionResolutionRequest,
  ): Promise<void> {
    const finish = (reasonCode: string) =>
      withTransaction(this.input.db, () => {
        const changed = this.input.repositories.actionIntents.completeResolutionRequest(
          request,
          this.input.clock.now().getTime(),
          reasonCode,
        );
        if (changed)
          this.input.repositories.events.append(
            this.actionEvent(intent, 'action_resolution_reviewed', reasonCode),
          );
        return changed;
      });
    const adapter = this.input.adapters.get(intent.providerId);
    const readAllowed = () => {
      try {
        return (
          adapter !== undefined &&
          this.input.adapters.get(intent.providerId) === adapter &&
          this.input.repositories.providers.get(intent.providerId)?.enabled === true &&
          this.input.isProviderRuntimeChanging?.(intent.providerId) === false
        );
      } catch {
        return false;
      }
    };
    if (!adapter || !readAllowed()) {
      finish('ACTION_RESOLUTION_READ_BLOCKED');
      return;
    }
    if (this.input.inspections?.isDeferred(intent.providerId, 'resolution')) return;
    const readStartedAtMs = this.input.clock.now().getTime();
    const inspection = await this.inspect(adapter, true, 'resolution');
    if (!readAllowed()) {
      finish('ACTION_RESOLUTION_READ_BLOCKED');
      return;
    }
    if (!inspection.observation) {
      finish('ACTION_RESOLUTION_OBSERVATION_UNAVAILABLE');
      return;
    }
    const nowMs = this.input.clock.now().getTime();
    const explanation = asRecord(intent.explanation);
    const target = windowKindFor(intent);
    const cycleAt =
      typeof explanation.observedCycleAt === 'string'
        ? Date.parse(explanation.observedCycleAt)
        : NaN;
    const window = inspection.observation.windows.find(
      (candidate) => candidate.windowKind === target,
    );
    const newlyObserved =
      Date.parse(inspection.observation.observedAt) >= readStartedAtMs &&
      window !== undefined &&
      Date.parse(window.observedAt) >= readStartedAtMs &&
      Date.parse(window.phase.observedAt) >= readStartedAtMs &&
      Date.parse(window.observedAt) <= nowMs &&
      Date.parse(window.phase.observedAt) <= nowMs;
    // Fresh evidence of the same active cycle still follows normal confirmation.
    if (
      Number.isSafeInteger(cycleAt) &&
      newlyObserved &&
      this.cycleStillCurrent(intent) &&
      isSatisfied(inspection.observation, intent)
    ) {
      withTransaction(this.input.db, () => {
        if (
          this.input.repositories.actionIntents.markConfirmedIfSucceededOrUncertain(
            intent.id,
            nowMs,
          )
        ) {
          this.appendEventOnce(
            this.actionEvent(intent, 'action_recovery_confirmed', ActionReasonCode.Confirmed),
          );
        }
        finish(ActionReasonCode.Confirmed);
      });
      return;
    }
    const closure =
      target && Number.isSafeInteger(cycleAt)
        ? this.input.repositories.windowCycles.getClosure(intent.providerId, target, cycleAt)
        : undefined;
    const currentCycle = target
      ? this.input.repositories.windowCycles.get(intent.providerId, target)
      : undefined;
    const decision = assessActionResolution({
      intent,
      observation: inspection.observation,
      nowMs,
      readStartedAtMs,
      ...(closure ? { closure } : {}),
      ...(currentCycle ? { currentCycle } : {}),
    });
    withTransaction(this.input.db, () => {
      const resolved =
        decision.allowed &&
        this.input.repositories.actionIntents.resolveUnknownIfUncertain(
          intent,
          nowMs,
          Date.parse(inspection.observation!.observedAt),
        );
      finish(
        resolved
          ? 'ACTION_OUTCOME_UNKNOWN'
          : decision.allowed
            ? 'ACTION_RESOLUTION_CONFLICT'
            : decision.reasonCode,
      );
    });
  }

  private async confirmExisting(
    intent: ActionIntentRecord,
    report: ActionExecutorReport,
  ): Promise<void> {
    const adapter = this.input.adapters.get(intent.providerId);
    if (!adapter) return;
    if (this.input.inspections?.isDeferred(intent.providerId, 'confirmation')) return;
    await this.phase('during_confirmation', intent);
    const nowMs = this.input.clock.now().getTime();
    const current = this.input.repositories.actionIntents.get(intent.id);
    if (!current || (current.state !== 'succeeded' && current.state !== 'uncertain')) return;
    const delayMs = this.confirmationDelay(current);
    const claimed = this.input.repositories.actionIntents.claimConfirmationAttempt(
      intent.id,
      nowMs,
      nowMs + delayMs,
    );
    if (!claimed) return;

    const inspection = await this.inspect(adapter, true, 'confirmation');
    if (
      inspection.observation &&
      this.cycleStillCurrent(intent) &&
      isSatisfied(inspection.observation, intent)
    ) {
      const confirmedAtMs = this.input.clock.now().getTime();
      if (
        this.input.repositories.actionIntents.markConfirmedIfSucceededOrUncertain(
          intent.id,
          confirmedAtMs,
        )
      ) {
        report.confirmedIntentIds.push(intent.id);
        this.appendEventOnce(
          this.actionEvent(
            intent,
            intent.state === 'uncertain' ? 'action_recovery_confirmed' : 'action_confirmed',
            ActionReasonCode.Confirmed,
          ),
        );
      }
      return;
    }

    if (intent.state === 'succeeded') {
      const uncertainAtMs = this.input.clock.now().getTime();
      if (
        this.input.repositories.actionIntents.markUncertainIfSucceeded(
          intent.id,
          uncertainAtMs,
          inspection.failureCode ?? ActionReasonCode.ConfirmationFailed,
        )
      ) {
        report.uncertainIntentIds.push(intent.id);
        this.appendEventOnce(
          this.actionEvent(intent, 'action_uncertain', ActionReasonCode.ConfirmationFailed),
        );
      }
    }
  }

  private confirmationDelay(intent: ActionIntentRecord): number {
    const baseIntervalMs =
      this.input.confirmationBaseIntervalMs ?? DEFAULT_CONFIRMATION_BASE_INTERVAL_MS;
    const maxBackoffMs = this.input.confirmationMaxBackoffMs ?? DEFAULT_CONFIRMATION_MAX_BACKOFF_MS;
    if (
      !Number.isSafeInteger(baseIntervalMs) ||
      baseIntervalMs < 1 ||
      !Number.isSafeInteger(maxBackoffMs) ||
      maxBackoffMs < 1
    ) {
      throw new RangeError('confirmation backoff configuration is invalid');
    }
    const attempt = intent.confirmationAttemptCount + 1;
    const exponent = Math.min(attempt - 1, 30);
    return Math.min(maxBackoffMs, Math.min(baseIntervalMs, maxBackoffMs) * 2 ** exponent);
  }

  private async inspect(
    adapter: ProviderAdapter,
    fresh = false,
    purpose: ReadPurpose = 'preflight',
  ): Promise<FreshInspection> {
    try {
      const rawObservation = this.input.inspections
        ? await (fresh
            ? this.input.inspections.inspectFresh(adapter, {}, purpose)
            : this.input.inspections.inspect(adapter, {}, purpose))
        : await adapter.inspect({});
      const observation = parseProviderObservation(rawObservation);
      if (
        observation.providerId !== adapter.id ||
        observation.health !== 'UP' ||
        Date.parse(observation.observedAt) > this.input.clock.now().getTime() ||
        this.input.clock.now().getTime() - Date.parse(observation.observedAt) >
          observation.staleAfterSeconds * 1000
      ) {
        return {
          failureCode:
            observation.health === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'PROVIDER_UNAVAILABLE',
        };
      }
      const tracked = withTransaction(this.input.db, () =>
        trackWindowCycles(observation, this.input.repositories),
      );
      return { observation: tracked };
    } catch (error) {
      const code = safeErrorCode(error);
      return {
        failureCode:
          code === 'AUTH_REQUIRED'
            ? 'AUTH_REQUIRED'
            : code === 'PROVIDER_UNAVAILABLE' || code === 'ETIMEDOUT' || code === 'EOF'
              ? 'PROVIDER_UNAVAILABLE'
              : 'INSPECTION_FAILED',
      };
    }
  }

  private cycleStillCurrent(intent: ActionIntentRecord): boolean {
    const expected = asRecord(intent.explanation).observedCycleAt;
    if (expected === undefined)
      return intent.state === 'planned' || intent.state === 'failed_retryable';
    if (typeof expected !== 'string' || !Number.isSafeInteger(Date.parse(expected))) return false;
    const target = windowKindFor(intent)!;
    const cycle = this.input.repositories.windowCycles.get(intent.providerId, target);
    return cycle !== undefined && cycle.cycleAtMs === Date.parse(expected);
  }

  private markRetryable(
    intent: ActionIntentRecord,
    nowMs: number,
    errorCode: string,
    report: ActionExecutorReport,
  ): void {
    const retryAtMs = nowMs + (this.input.retryDelayMs ?? 5_000);
    const transitioned =
      intent.state === 'executing'
        ? this.input.repositories.actionIntents.markRetryableIfExecuting(
            intent.id,
            nowMs,
            retryAtMs,
            errorCode,
          )
        : this.input.repositories.actionIntents.markRetryableIfPlannedOrRetryable(
            intent.id,
            nowMs,
            retryAtMs,
            errorCode,
          );
    if (transitioned) {
      this.appendEventOnce(
        this.actionEvent(intent, 'action_failed_retryable', ActionReasonCode.ProviderUnavailable, {
          errorCode,
        }),
      );
    }
    void report;
  }

  private markSkipped(
    intent: ActionIntentRecord,
    nowMs: number,
    reasonCode: ActionReasonCode,
    report: ActionExecutorReport,
  ): void {
    if (
      this.input.repositories.actionIntents.markSkippedIfPlannedOrRetryable(
        intent.id,
        nowMs,
        reasonCode,
      )
    ) {
      report.skippedIntentIds.push(intent.id);
      this.appendEventOnce(this.actionEvent(intent, 'action_skipped', reasonCode));
    }
  }

  private actionEvent(
    intent: ActionIntentRecord,
    type: string,
    reasonCode: string,
    extra: Record<string, unknown> = {},
  ): EventRecord {
    return {
      occurredAtMs: this.input.clock.now().getTime(),
      providerId: intent.providerId,
      type,
      severity: type.includes('uncertain') || type.includes('recovery') ? 'warn' : 'info',
      reasonCode,
      data: { ...safeIntentData(intent), ...extra },
    };
  }

  private appendEventOnce(event: EventRecord): void {
    const recent = this.input.repositories.events.list(event.providerId ?? undefined, {
      limit: 200,
    });
    const intentId = asRecord(event.data).intentId;
    if (
      recent.some(
        (candidate) =>
          candidate.type === event.type &&
          candidate.reasonCode === event.reasonCode &&
          asRecord(candidate.data).intentId === intentId,
      )
    ) {
      return;
    }
    this.input.repositories.events.append(event);
  }

  private async phase(phase: ActionExecutorPhase, intent: ActionIntentRecord): Promise<void> {
    await this.input.onPhase?.(phase, intent);
  }
}

function emptyReport(skipped: boolean): ActionExecutorReport {
  return {
    skipped,
    recoveredIntentIds: [],
    processedIntentIds: [],
    confirmedIntentIds: [],
    uncertainIntentIds: [],
    skippedIntentIds: [],
  };
}

function safeIntentData(intent: ActionIntentRecord): Record<string, unknown> {
  return {
    intentId: intent.id,
    providerId: intent.providerId,
    policyId: intent.policyId,
    actionType: intent.actionType,
    state: intent.state,
    dedupeKey: intent.dedupeKey,
  };
}

function isEligibleForTrigger(
  observation: ProviderObservation,
  intent: ActionIntentRecord,
): boolean {
  const window = windowFor(observation, intent);
  if (intent.reasonCode === 'MANUAL_TRIGGER_REQUESTED') {
    return window !== undefined && !['ACTIVE', 'EXHAUSTED'].includes(window.phase.value);
  }
  return (
    window !== undefined &&
    ['exact', 'high'].includes(window.phase.confidence) &&
    window.phase.value === 'INACTIVE'
  );
}

function policyStillCurrent(
  repositories: StorageRepositories,
  intent: ActionIntentRecord,
  freshObservation?: ProviderObservation,
): boolean {
  if (!intent.policyId) return true;
  const policy = repositories.schedulePolicies.get(intent.policyId);
  if (!policy || !policy.enabled) return false;
  const expected = asRecord(intent.explanation).policyUpdatedAtMs;
  if (typeof expected === 'number' && expected !== policy.updatedAtMs) return false;
  const expectedWindowKind = windowKindFor(intent);
  if (intent.providerId === 'antigravity') {
    const scope = expectedWindowKind ? policyScopeForWindowKind(expectedWindowKind) : undefined;
    if (
      !scope ||
      policy.scope !== scope ||
      intent.policyId !== activationPolicyId(intent.providerId, scope)
    ) {
      return false;
    }
  }
  if (expectedWindowKind) {
    const configuredWindowKind = asRecord(policy.config).windowKind;
    if (configuredWindowKind === expectedWindowKind) return true;
    if (typeof configuredWindowKind !== 'string') return false;
    const observation =
      freshObservation ?? repositories.providerState.get(intent.providerId)?.observation;
    const resolution = resolveWindowTarget(configuredWindowKind, observation?.windows ?? []);
    return (
      (resolution.status === 'exact' || resolution.status === 'legacy_resolved') &&
      resolution.windowKind === expectedWindowKind
    );
  }
  return true;
}

function isSatisfied(observation: ProviderObservation, intent: ActionIntentRecord): boolean {
  const phase = windowFor(observation, intent)?.phase;
  return phase?.value === 'ACTIVE' && (phase.confidence === 'exact' || phase.confidence === 'high');
}

function windowFor(
  observation: ProviderObservation,
  intent: ActionIntentRecord,
): ProviderObservation['windows'][number] | undefined {
  const windowKind = windowKindFor(intent);
  return windowKind
    ? observation.windows.find((candidate) => candidate.windowKind === windowKind)
    : undefined;
}

function windowKindFor(intent: ActionIntentRecord): string | undefined {
  const windowKind = asRecord(intent.explanation).windowKind;
  return typeof windowKind === 'string' && windowKind.length > 0 ? windowKind : undefined;
}

function safeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = 'code' in error ? error.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function isDefinitelyPreDispatch(errorCode: string | undefined): boolean {
  return errorCode !== undefined && definitelyPreDispatchErrors.has(errorCode);
}

function triggerCapabilityAvailable(adapter: ProviderAdapter, windowKind: string): boolean {
  try {
    const capability = adapter.capabilities().windowTrigger;
    return (
      capability.supported &&
      (!capability.supportedWindowKinds || capability.supportedWindowKinds.includes(windowKind))
    );
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
