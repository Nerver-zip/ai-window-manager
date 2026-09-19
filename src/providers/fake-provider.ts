import type { Clock } from '../scheduler/clock.js';
import type { ProviderAdapter, ProviderContext } from './provider.js';
import type {
  ProviderActionResult,
  ProviderActionStatus,
  ProviderCapabilities,
  ProviderHealth,
  ProviderObservation,
  TriggerWindowRequest,
  WindowPhase,
} from '../domain/types.js';
import { parseProviderObservation, ProviderActionResultSchema } from '../domain/schemas.js';

export interface FakeTriggerResult {
  status: ProviderActionStatus;
  confirmationHint?: string;
  errorCode?: string;
}

export type FakeInspectionFailure =
  | Exclude<ProviderHealth, 'UP'>
  | {
      health: Exclude<ProviderHealth, 'UP'>;
      summary?: string;
    };

export interface FakeProviderOptions {
  id?: string;
  windowDurationSeconds?: number;
  initialPhase?: WindowPhase;
  usageRatio?: number;
  initialHealth?: ProviderHealth;
  inspectionFailure?: FakeInspectionFailure;
  triggerResult?: FakeTriggerResult | ProviderActionStatus;
  triggerResults?: readonly (FakeTriggerResult | ProviderActionStatus)[];
}

export class FakeProvider implements ProviderAdapter {
  readonly id: string;
  private phase: WindowPhase;
  private readonly durationSeconds: number;
  private usageRatio: number;
  private startedAt: Date | undefined;
  private healthState: ProviderHealth;
  private inspectionFailure: FakeInspectionFailure | undefined;
  private triggerResult: FakeTriggerResult | ProviderActionStatus | undefined;
  private readonly triggerResults: Array<FakeTriggerResult | ProviderActionStatus>;

  constructor(
    private readonly clock: Clock,
    options: FakeProviderOptions = {},
  ) {
    this.id = options.id ?? 'fake';
    this.phase = options.initialPhase ?? 'INACTIVE';
    this.durationSeconds = options.windowDurationSeconds ?? 30;
    if (!Number.isInteger(this.durationSeconds) || this.durationSeconds <= 0) {
      throw new Error('FakeProvider windowDurationSeconds must be a positive integer');
    }
    this.usageRatio = 0;
    this.setUsageRatio(options.usageRatio ?? 0);
    this.healthState = options.initialHealth ?? 'UP';
    this.inspectionFailure = options.inspectionFailure;
    this.triggerResult = options.triggerResult;
    this.triggerResults = [...(options.triggerResults ?? [])];
    if (this.phase === 'ACTIVE') this.startedAt = this.clock.now();
  }

  capabilities(): ProviderCapabilities {
    return {
      usageRead: { supported: true, contract: 'official_supported' },
      resetRead: { supported: true, contract: 'official_supported' },
      windowTrigger: { supported: true, contract: 'official_supported', consumesQuota: false },
    };
  }

  health(ctx: ProviderContext): Promise<ProviderHealth> {
    void ctx;
    return Promise.resolve(this.currentHealth());
  }

  inspect(ctx: ProviderContext): Promise<ProviderObservation> {
    void ctx;
    const now = this.clock.now();
    const failure = this.inspectionFailure;
    const health = this.currentHealth();
    if (failure || health !== 'UP') {
      const failureHealth = failure ? this.failureHealth(failure) : health;
      return Promise.resolve(
        parseProviderObservation({
          providerId: this.id,
          health: failureHealth,
          observedAt: now.toISOString(),
          staleAfterSeconds: 10,
          windows: [],
          ...(this.failureSummary(failure) ? { summary: this.failureSummary(failure) } : {}),
        }),
      );
    }

    this.refreshPhase(now);
    const observedAt = now.toISOString();
    const resetAt = this.startedAt
      ? new Date(this.startedAt.getTime() + this.durationSeconds * 1000)
      : undefined;

    return Promise.resolve(
      parseProviderObservation({
        providerId: this.id,
        health: 'UP',
        observedAt,
        staleAfterSeconds: 10,
        windows: [
          {
            providerId: this.id,
            windowKind: 'five_hour',
            phase: {
              value: this.phase,
              source: 'observed',
              confidence: 'exact',
              observedAt,
            },
            observedAt,
            durationSeconds: {
              value: this.durationSeconds,
              source: 'official_supported',
              confidence: 'exact',
              observedAt,
            },
            ...(this.startedAt
              ? {
                  startedAt: {
                    value: this.startedAt.toISOString(),
                    source: 'observed' as const,
                    confidence: 'exact' as const,
                    observedAt,
                  },
                }
              : {}),
            ...(resetAt
              ? {
                  resetAt: {
                    value: resetAt.toISOString(),
                    source: 'inferred' as const,
                    confidence: 'high' as const,
                    observedAt,
                  },
                }
              : {}),
            usageRatio: {
              value: this.usageRatio,
              source: 'observed',
              confidence: 'exact',
              observedAt,
            },
            remainingRatio: {
              value: Math.max(0, 1 - this.usageRatio),
              source: 'inferred',
              confidence: 'exact',
              observedAt,
            },
          },
        ],
      }),
    );
  }

  triggerWindow(
    ctx: ProviderContext,
    request: TriggerWindowRequest,
  ): Promise<ProviderActionResult> {
    void ctx;
    void request;
    const occurredAt = this.clock.now().toISOString();
    if (this.currentHealth() !== 'UP') {
      return Promise.resolve(
        this.actionResult(
          {
            status: 'rejected',
            errorCode: 'PROVIDER_NOT_AVAILABLE',
          },
          occurredAt,
        ),
      );
    }

    const configuredResult = this.triggerResults.shift() ?? this.triggerResult;
    if (configuredResult) {
      const result = this.actionResult(configuredResult, occurredAt);
      if (result.status !== 'succeeded') return Promise.resolve(result);
      this.activate(this.clock.now());
      return Promise.resolve(result);
    }

    if (this.phase !== 'INACTIVE') {
      return Promise.resolve(
        this.actionResult(
          {
            status: 'rejected',
            errorCode: 'WINDOW_ALREADY_ACTIVE',
          },
          occurredAt,
        ),
      );
    }

    this.activate(this.clock.now());
    return Promise.resolve(this.actionResult({ status: 'succeeded' }, occurredAt));
  }

  setPhase(phase: WindowPhase): void {
    this.phase = phase;
    this.startedAt = phase === 'ACTIVE' ? this.clock.now() : undefined;
  }

  setUsageRatio(usageRatio: number): void {
    if (!Number.isFinite(usageRatio) || usageRatio < 0 || usageRatio > 1) {
      throw new Error('FakeProvider usageRatio must be between 0 and 1');
    }
    this.usageRatio = usageRatio;
  }

  setHealth(health: ProviderHealth): void {
    this.healthState = health;
  }

  setInspectionFailure(failure?: FakeInspectionFailure): void {
    this.inspectionFailure = failure;
  }

  setTriggerResult(result?: FakeTriggerResult | ProviderActionStatus): void {
    this.triggerResult = result;
  }

  private refreshPhase(now: Date): void {
    if (!this.startedAt) return;
    if (now.getTime() >= this.startedAt.getTime() + this.durationSeconds * 1000) {
      this.phase = 'INACTIVE';
      this.startedAt = undefined;
      this.usageRatio = 0;
    }
  }

  private activate(now: Date): void {
    this.phase = 'ACTIVE';
    this.startedAt = now;
    this.usageRatio = Math.max(this.usageRatio, 0.01);
  }

  private currentHealth(): ProviderHealth {
    if (!this.inspectionFailure) return this.healthState;
    return this.failureHealth(this.inspectionFailure);
  }

  private failureHealth(failure: FakeInspectionFailure): Exclude<ProviderHealth, 'UP'> {
    return typeof failure === 'string' ? failure : failure.health;
  }

  private failureSummary(failure?: FakeInspectionFailure): string | undefined {
    if (!failure || typeof failure === 'string') return undefined;
    return failure.summary;
  }

  private actionResult(
    result: FakeTriggerResult | ProviderActionStatus,
    occurredAtOverride?: string,
  ): ProviderActionResult {
    const normalized = typeof result === 'string' ? { status: result } : result;
    const action = {
      ...normalized,
      occurredAt: occurredAtOverride ?? this.clock.now().toISOString(),
    };
    return ProviderActionResultSchema.parse(action) as ProviderActionResult;
  }
}
