import type { Clock } from '../scheduler/clock.js';
import type { ProviderAdapter, ProviderContext } from './provider.js';
import type {
  ProviderActionResult,
  ProviderCapabilities,
  ProviderObservation,
  TriggerWindowRequest,
  WindowPhase,
} from '../domain/types.js';

export interface FakeProviderOptions {
  id?: string;
  windowDurationSeconds?: number;
  initialPhase?: WindowPhase;
  usageRatio?: number;
}

export class FakeProvider implements ProviderAdapter {
  readonly id: string;
  private phase: WindowPhase;
  private readonly durationSeconds: number;
  private usageRatio: number;
  private startedAt: Date | undefined;

  constructor(
    private readonly clock: Clock,
    options: FakeProviderOptions = {},
  ) {
    this.id = options.id ?? 'fake';
    this.phase = options.initialPhase ?? 'INACTIVE';
    this.durationSeconds = options.windowDurationSeconds ?? 30;
    this.usageRatio = options.usageRatio ?? 0;
  }

  capabilities(): ProviderCapabilities {
    return {
      usageRead: { supported: true, contract: 'official_supported' },
      resetRead: { supported: true, contract: 'official_supported' },
      windowTrigger: { supported: true, contract: 'official_supported', consumesQuota: false },
    };
  }

  health(ctx: ProviderContext): Promise<'UP'> {
    void ctx;
    return Promise.resolve('UP');
  }

  inspect(ctx: ProviderContext): Promise<ProviderObservation> {
    void ctx;
    const now = this.clock.now();
    this.refreshPhase(now);
    const observedAt = now.toISOString();
    const resetAt = this.startedAt
      ? new Date(this.startedAt.getTime() + this.durationSeconds * 1000)
      : undefined;

    return Promise.resolve({
      providerId: this.id,
      health: 'UP',
      observedAt,
      staleAfterSeconds: 10,
      windows: [
        {
          providerId: this.id,
          windowKind: 'five_hour',
          phase: this.phase,
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
    });
  }

  triggerWindow(
    ctx: ProviderContext,
    request: TriggerWindowRequest,
  ): Promise<ProviderActionResult> {
    void ctx;
    void request;
    if (this.phase !== 'INACTIVE') {
      return Promise.resolve({
        status: 'rejected',
        occurredAt: this.clock.now().toISOString(),
        errorCode: 'WINDOW_ALREADY_ACTIVE',
      });
    }

    this.phase = 'ACTIVE';
    this.startedAt = this.clock.now();
    this.usageRatio = 0.01;
    return Promise.resolve({ status: 'succeeded', occurredAt: this.startedAt.toISOString() });
  }

  private refreshPhase(now: Date): void {
    if (!this.startedAt) return;
    if (now.getTime() >= this.startedAt.getTime() + this.durationSeconds * 1000) {
      this.phase = 'INACTIVE';
      this.startedAt = undefined;
      this.usageRatio = 0;
    }
  }
}
