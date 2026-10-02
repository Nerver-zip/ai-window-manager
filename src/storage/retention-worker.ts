import type { Clock } from '../scheduler/clock.js';
import type { RetentionMaintenanceResult } from './retention.js';

export interface RetentionWorkerInput {
  clock: Clock;
  processBatch: () => RetentionMaintenanceResult;
  onError: (error: unknown) => void;
  /** Existing operator override controls the idle sweep, not backlog continuation. */
  idleIntervalMs: number;
  batchSize?: number;
  maxBatchesPerPass?: number;
  budgetMs?: number;
  continuationIntervalMs?: number;
  yieldBetweenBatches?: () => Promise<void>;
  /** Snapshot publication after a pass; callers must not perform it on scrapes. */
  onProgress?: (progress: RetentionProgress) => void;
  onPassStart?: () => void;
}

export interface RetentionProgress {
  startedAtMs: number | null;
  finishedAtMs: number | null;
  durationMs: number;
  batches: number;
  totalDeleted: number;
  pending: boolean;
  running: boolean;
  consecutiveFailures: number;
}

/** Small transactions, bounded passes and yielding continuation until backlog drains. */
export class RetentionWorker {
  private readonly batchSize: number;
  private readonly maxBatches: number;
  private readonly budgetMs: number;
  private readonly continuationMs: number;
  private readonly yieldBetweenBatches: () => Promise<void>;
  private started = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private progress: RetentionProgress = {
    startedAtMs: null,
    finishedAtMs: null,
    durationMs: 0,
    batches: 0,
    totalDeleted: 0,
    pending: false,
    running: false,
    consecutiveFailures: 0,
  };

  constructor(private readonly input: RetentionWorkerInput) {
    positive(input.idleIntervalMs);
    this.batchSize = positive(input.batchSize ?? 500);
    this.maxBatches = positive(input.maxBatchesPerPass ?? 32);
    this.budgetMs = positive(input.budgetMs ?? 25);
    this.continuationMs = positive(input.continuationIntervalMs ?? 1_000);
    this.yieldBetweenBatches =
      input.yieldBetweenBatches ?? (() => new Promise((resolve) => setImmediate(resolve)));
  }

  snapshot(): RetentionProgress {
    return { ...this.progress };
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.runPass();
  }

  runPass(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Deferring the first batch makes overlapping calls coalesce before work starts.
    const current = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        if (this.inFlight === current) this.inFlight = undefined;
      });
    this.inFlight = current;
    return current;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private async drain(): Promise<void> {
    if (this.stopped) return;
    const startedMono = this.input.clock.monotonicMs();
    this.progress = {
      ...this.progress,
      startedAtMs: this.input.clock.now().getTime(),
      running: true,
      batches: 0,
      totalDeleted: 0,
      pending: false,
    };
    let delayMs = this.input.idleIntervalMs;
    try {
      this.input.onPassStart?.();
      while (!this.stopped) {
        const result = this.input.processBatch();
        this.progress.batches += 1;
        this.progress.totalDeleted += result.totalDeleted;
        this.progress.pending = [
          result.windowSamplesDeleted,
          result.usageIntervalsDeleted,
          result.terminalActionIntentsDeleted,
          ...Object.values(result.eventsDeleted),
        ].some((count) => count >= this.batchSize);
        if (!this.progress.pending) break;
        delayMs = this.continuationMs;
        if (
          this.progress.batches >= this.maxBatches ||
          this.input.clock.monotonicMs() - startedMono >= this.budgetMs
        )
          break;
        await this.yieldBetweenBatches();
      }
      this.progress.consecutiveFailures = 0;
      if (!this.progress.pending) delayMs = this.input.idleIntervalMs;
    } catch (error) {
      this.progress.consecutiveFailures += 1;
      delayMs = Math.min(
        60_000,
        this.continuationMs * 2 ** Math.min(this.progress.consecutiveFailures - 1, 16),
      );
      this.input.onError(error);
    } finally {
      this.progress.running = false;
      this.progress.finishedAtMs = this.input.clock.now().getTime();
      this.progress.durationMs = Math.max(0, this.input.clock.monotonicMs() - startedMono);
      if (this.started && !this.stopped) this.schedule(delayMs);
      try {
        this.input.onProgress?.(this.snapshot());
      } catch (error) {
        this.input.onError(error);
      }
    }
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runPass();
    }, delayMs);
    this.timer.unref?.();
  }
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError('retention worker limits must be positive safe integers');
  return value;
}
