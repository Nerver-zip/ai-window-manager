import type { ProviderCleanupArtifact } from '../domain/provider-cleanup.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { Clock } from './clock.js';
import type { StorageRepositories } from '../storage/repositories.js';

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 60 * 60 * 1_000;

export interface ProviderCleanupWorkerInput {
  clock: Pick<Clock, 'now'>;
  repositories: StorageRepositories;
  adapters: ReadonlyMap<string, ProviderAdapter>;
  batchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface ProviderCleanupReport {
  skipped: boolean;
  recovered: number;
  attempted: number;
  deleted: number;
  retryable: number;
}

/** Retries idempotent provider-side deletion without changing ActionIntent state. */
export class ProviderCleanupWorker {
  private running = false;
  private recovered = false;
  private readonly batchSize: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(private readonly input: ProviderCleanupWorkerInput) {
    this.batchSize = boundedInteger(input.batchSize ?? DEFAULT_BATCH_SIZE, 1, 100, 'batchSize');
    this.retryBaseMs = boundedInteger(
      input.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      1,
      86_400_000,
      'retryBaseMs',
    );
    this.retryMaxMs = boundedInteger(
      input.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
      this.retryBaseMs,
      86_400_000,
      'retryMaxMs',
    );
  }

  async runDue(): Promise<ProviderCleanupReport> {
    if (this.running) return emptyReport(true);
    this.running = true;
    try {
      const nowMs = validNowMs(this.input.clock);
      const recovered = this.recovered
        ? 0
        : this.input.repositories.providerCleanupJobs.recoverExecuting(nowMs);
      this.recovered = true;
      const report = { ...emptyReport(false), recovered };

      for (const candidate of this.input.repositories.providerCleanupJobs.listDue(
        nowMs,
        this.batchSize,
      )) {
        const job = this.input.repositories.providerCleanupJobs.claim(candidate.id, nowMs);
        if (!job) continue;
        report.attempted += 1;

        const adapter = this.input.adapters.get(job.providerId);
        if (!adapter?.cleanupArtifact) {
          this.retry(job.id, job.attemptCount, nowMs, 'CLEANUP_UNAVAILABLE');
          report.retryable += 1;
          continue;
        }

        try {
          const artifact: ProviderCleanupArtifact = {
            kind: job.artifactKind,
            externalId: job.externalId,
          };
          await adapter.cleanupArtifact({}, artifact);
          if (this.input.repositories.providerCleanupJobs.delete(job.id)) report.deleted += 1;
        } catch (error) {
          this.retry(job.id, job.attemptCount, nowMs, cleanupErrorCode(error));
          report.retryable += 1;
        }
      }

      return report;
    } finally {
      this.running = false;
    }
  }

  private retry(id: string, attemptCount: number, nowMs: number, errorCode: string): void {
    const exponent = Math.min(16, Math.max(0, attemptCount - 1));
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
    this.input.repositories.providerCleanupJobs.markRetryable(id, nowMs, nowMs + delay, errorCode);
  }
}

function validNowMs(clock: Pick<Clock, 'now'>): number {
  const value = clock.now().getTime();
  if (!Number.isSafeInteger(value))
    throw new RangeError('cleanup clock must return a valid instant');
  return value;
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} is outside the supported range`);
  }
  return value;
}

function cleanupErrorCode(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,48}$/.test(code)) {
    return `CLEANUP_${code}`;
  }
  return 'CLEANUP_FAILED';
}

function emptyReport(skipped: boolean): ProviderCleanupReport {
  return { skipped, recovered: 0, attempted: 0, deleted: 0, retryable: 0 };
}
