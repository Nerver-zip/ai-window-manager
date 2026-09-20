import { parseProviderObservation } from '../domain/schemas.js';
import type {
  ProviderActionResult,
  ProviderActionStatus,
  ProviderObservation,
} from '../domain/types.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { Clock } from './clock.js';
import type {
  ActionIntentRecord,
  EventRecord,
  StorageRepositories,
} from '../storage/repositories.js';
import type { SqliteDatabase } from '../storage/database.js';

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
]);

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

    for (const intent of this.input.repositories.actionIntents.listOpen()) {
      const current = this.input.repositories.actionIntents.get(intent.id);
      if (!current) continue;

      if (current.state === 'uncertain' || current.state === 'succeeded') {
        await this.confirmExisting(current, report);
        continue;
      }

      if (current.state !== 'planned' && current.state !== 'failed_retryable') continue;
      await this.executeCandidate(current, report);
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
    const nowMs = this.input.clock.now().getTime();
    if (intent.expiresAtMs !== null && nowMs >= intent.expiresAtMs) {
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

    const provider = this.input.repositories.providers.get(intent.providerId);
    const adapter = this.input.adapters.get(intent.providerId);
    if (!provider || !provider.enabled || provider.mode !== 'automation' || !adapter) {
      this.markSkipped(intent, nowMs, ActionReasonCode.ProviderUnavailable, report);
      return;
    }
    if (!triggerCapabilityAvailable(adapter) || typeof adapter.triggerWindow !== 'function') {
      this.markSkipped(intent, nowMs, ActionReasonCode.CapabilityUnavailable, report);
      return;
    }

    const preflight = await this.inspect(adapter);
    if (!preflight.observation) {
      this.markRetryable(intent, nowMs, preflight.failureCode ?? 'INSPECTION_FAILED', report);
      return;
    }
    if (!isEligibleForTrigger(preflight.observation, intent)) {
      this.markSkipped(intent, nowMs, ActionReasonCode.AlreadySatisfied, report);
      return;
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
      result = await adapter.triggerWindow(
        {},
        {
          intentId: claimed.id,
          dedupeKey: claimed.dedupeKey,
          reasonCode: claimed.reasonCode,
        },
      );
    } catch (error) {
      this.input.onTrigger?.(claimed.providerId, 'uncertain');
      this.handleDispatchException(claimed, error, report);
      return;
    }

    this.input.onTrigger?.(claimed.providerId, result.status);
    await this.phase('after_dispatch_before_result', claimed);
    if (result.status === 'succeeded') {
      if (!this.input.repositories.actionIntents.markSucceededIfExecuting(claimed.id, nowMs))
        return;
      this.appendEventOnce(this.actionEvent(claimed, 'action_succeeded', 'ACTION_SUCCEEDED'));
      const succeeded = this.input.repositories.actionIntents.get(claimed.id);
      if (!succeeded) return;
      if (result.confirmationHint === 'CODEX_TURN_COMPLETED') {
        if (
          this.input.repositories.actionIntents.markConfirmedIfSucceededOrUncertain(
            claimed.id,
            nowMs,
          )
        ) {
          report.confirmedIntentIds.push(claimed.id);
          this.appendEventOnce(
            this.actionEvent(claimed, 'action_confirmed', ActionReasonCode.Confirmed, {
              confirmationHint: result.confirmationHint,
            }),
          );
        }
        return;
      }
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

  private async confirmExisting(
    intent: ActionIntentRecord,
    report: ActionExecutorReport,
  ): Promise<void> {
    const adapter = this.input.adapters.get(intent.providerId);
    if (!adapter) return;
    await this.phase('during_confirmation', intent);
    const inspection = await this.inspect(adapter);
    if (inspection.observation && isSatisfied(inspection.observation, intent)) {
      const nowMs = this.input.clock.now().getTime();
      if (
        this.input.repositories.actionIntents.markConfirmedIfSucceededOrUncertain(intent.id, nowMs)
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
      const nowMs = this.input.clock.now().getTime();
      if (
        this.input.repositories.actionIntents.markUncertainIfSucceeded(
          intent.id,
          nowMs,
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

  private async inspect(adapter: ProviderAdapter): Promise<FreshInspection> {
    try {
      const observation = parseProviderObservation(await adapter.inspect({}));
      if (observation.providerId !== adapter.id || observation.health !== 'UP') {
        return {
          failureCode:
            observation.health === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'PROVIDER_UNAVAILABLE',
        };
      }
      return { observation };
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

function isSatisfied(observation: ProviderObservation, intent: ActionIntentRecord): boolean {
  return windowFor(observation, intent)?.phase.value === 'ACTIVE';
}

function windowFor(
  observation: ProviderObservation,
  intent: ActionIntentRecord,
): ProviderObservation['windows'][number] | undefined {
  const explanation = asRecord(intent.explanation);
  const windowKind =
    typeof explanation.windowKind === 'string' ? explanation.windowKind : undefined;
  return windowKind
    ? observation.windows.find((candidate) => candidate.windowKind === windowKind)
    : observation.windows[0];
}

function safeErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = 'code' in error ? error.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

function isDefinitelyPreDispatch(errorCode: string | undefined): boolean {
  return errorCode !== undefined && definitelyPreDispatchErrors.has(errorCode);
}

function triggerCapabilityAvailable(adapter: ProviderAdapter): boolean {
  try {
    return adapter.capabilities().windowTrigger.supported;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
