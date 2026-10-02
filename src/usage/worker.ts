import type { AggregationBatchResult } from './service.js';

export interface UsageAggregationWorkerInput {
  processBatch: () => AggregationBatchResult;
  onError: (error: unknown) => void;
  fallbackIntervalMs?: number;
  errorRetryBaseMs?: number;
  errorRetryMaxMs?: number;
  yieldBetweenBatches?: () => Promise<void>;
  onRunStart?: () => void;
  onRunFinish?: (succeeded: boolean) => void;
}

const DEFAULT_FALLBACK_INTERVAL_MS = 60_000;
const DEFAULT_ERROR_RETRY_BASE_MS = 5_000;
const DEFAULT_ERROR_RETRY_MAX_MS = 60_000;

/** Coalesces committed-sample notifications and recovers missed work on startup. */
export class UsageAggregationWorker {
  private readonly fallbackIntervalMs: number;
  private readonly errorRetryBaseMs: number;
  private readonly errorRetryMaxMs: number;
  private readonly yieldBetweenBatches: () => Promise<void>;
  private started = false;
  private stopped = false;
  private requested = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private pumpScheduled = false;

  constructor(private readonly input: UsageAggregationWorkerInput) {
    this.fallbackIntervalMs = positiveInteger(
      input.fallbackIntervalMs ?? DEFAULT_FALLBACK_INTERVAL_MS,
      'fallbackIntervalMs',
    );
    this.errorRetryBaseMs = positiveInteger(
      input.errorRetryBaseMs ?? DEFAULT_ERROR_RETRY_BASE_MS,
      'errorRetryBaseMs',
    );
    this.errorRetryMaxMs = positiveInteger(
      input.errorRetryMaxMs ?? DEFAULT_ERROR_RETRY_MAX_MS,
      'errorRetryMaxMs',
    );
    if (this.errorRetryMaxMs < this.errorRetryBaseMs) {
      throw new RangeError('errorRetryMaxMs must be at least errorRetryBaseMs');
    }
    this.yieldBetweenBatches =
      input.yieldBetweenBatches ?? (() => new Promise((resolve) => setImmediate(resolve)));
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(this.fallbackIntervalMs);
    this.request();
  }

  request(): void {
    if (this.stopped) return;
    this.requested = true;
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running) this.pump();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.requested = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private pump(): void {
    if (this.running || this.pumpScheduled || this.stopped) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      if (this.running || this.stopped) return;
      const current = this.drain().finally(() => {
        if (this.running === current) this.running = undefined;
        if (this.requested && !this.stopped) this.pump();
      });
      this.running = current;
    });
  }

  private async drain(): Promise<void> {
    while (this.requested && !this.stopped) {
      this.requested = false;
      try {
        this.input.onRunStart?.();
        let batch = this.input.processBatch();
        while (batch.pending && !this.stopped) {
          await this.yieldBetweenBatches();
          if (this.stopped) {
            this.input.onRunFinish?.(true);
            return;
          }
          batch = this.input.processBatch();
        }
        this.input.onRunFinish?.(true);
      } catch (error) {
        this.input.onRunFinish?.(false);
        this.requested = false;
        this.failures += 1;
        this.input.onError(error);
        this.schedule(this.errorDelay());
        return;
      }
      if (this.requested) await this.yieldBetweenBatches();
    }
    if (!this.stopped) {
      this.failures = 0;
      this.schedule(this.fallbackIntervalMs);
    }
  }

  private errorDelay(): number {
    const exponent = Math.min(this.failures - 1, 30);
    return Math.min(this.errorRetryMaxMs, this.errorRetryBaseMs * 2 ** exponent);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.request();
    }, delayMs);
    this.timer.unref?.();
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
