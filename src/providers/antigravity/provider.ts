import {
  ProviderIdSchema,
  StaleAfterSecondsSchema,
  parseProviderObservation,
} from '../../domain/schemas.js';
import type {
  Confidence,
  EvidenceSource,
  Fact,
  ProviderCapabilities,
  ProviderHealth,
  ProviderObservation,
  WindowPhase,
  WindowSnapshot,
} from '../../domain/types.js';
import type { ProviderAdapter, ProviderContext } from '../provider.js';
import {
  AntigravityOutputError,
  containsAuthenticationMarker,
  parseAntigravityUsageEnvelope,
  type AntigravityUsageBucket,
  type AntigravityUsageGroup,
} from './protocol.js';
import {
  AntigravityTransportError,
  runAntigravityUsageCommand,
  type AntigravityProcessFactory,
} from './transport.js';

const DEFAULT_STALE_AFTER_SECONDS = 300;
const DEFAULT_PRINT_TIMEOUT_SECONDS = 30;
const DEFAULT_TIMEOUT_MS = 35_000;
const MAX_PRINT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_MS = 305_000;
const MAX_RESET_DISTANCE_MS = 366 * 24 * 60 * 60 * 1000;

export interface AntigravityProviderOptions {
  executable: string;
  id?: string;
  staleAfterSeconds?: number;
  printTimeoutSeconds?: number;
  timeoutMs?: number;
  cwd?: string;
  now?: () => Date;
  spawnProcess?: AntigravityProcessFactory;
}

function fact<T>(
  value: T,
  source: EvidenceSource,
  confidence: Confidence,
  observedAt: string,
): Fact<T> {
  return { value, source, confidence, observedAt };
}

function groupKey(groupName: string, index: number): string {
  const normalized = groupName.toLowerCase();
  if (normalized.includes('gemini')) return 'gemini';
  if (normalized.includes('claude') || normalized.includes('gpt')) return 'claude_gpt';
  return `group_${index + 1}`;
}

function windowKey(
  groupName: string,
  index: number,
  window: AntigravityUsageBucket['window'],
): string {
  const durationKey = window === '5h' ? 'five_hour' : 'weekly';
  return `antigravity_${groupKey(groupName, index)}_${durationKey}`;
}

function reasonableResetAt(
  value: string | null | undefined,
  observedAt: string,
): string | undefined {
  if (!value) return undefined;
  const resetMs = Date.parse(value);
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(resetMs) || !Number.isFinite(observedMs)) return undefined;
  if (resetMs < observedMs - 24 * 60 * 60 * 1000 || resetMs > observedMs + MAX_RESET_DISTANCE_MS) {
    return undefined;
  }
  return new Date(resetMs).toISOString();
}

function normalizeBucket(
  providerId: string,
  group: AntigravityUsageGroup,
  groupIndex: number,
  bucket: AntigravityUsageBucket,
  observedAt: string,
): WindowSnapshot {
  const resetAt = reasonableResetAt(bucket.reset_time, observedAt);
  const phase = fact<WindowPhase>('UNKNOWN', 'unknown', 'unknown', observedAt);
  return {
    providerId,
    windowKind: windowKey(group.name, groupIndex, bucket.window),
    observedAt,
    phase,
    usageRatio: fact(1 - bucket.remaining_fraction, 'inferred', 'exact', observedAt),
    remainingRatio: fact(bucket.remaining_fraction, 'observed', 'exact', observedAt),
    ...(resetAt ? { resetAt: fact(resetAt, 'observed', 'exact', observedAt) } : {}),
  };
}

function healthFor(error: unknown): ProviderHealth {
  if (error instanceof AntigravityTransportError && error.code === 'AUTH_REQUIRED') {
    return 'AUTH_REQUIRED';
  }
  if (error instanceof AntigravityTransportError) return 'UNAVAILABLE';
  return 'UNAVAILABLE';
}

function summaryFor(error: unknown): string {
  if (error instanceof AntigravityTransportError) return `AGY_${error.code}`;
  if (error instanceof AntigravityOutputError) return 'AGY_PROVIDER_OUTPUT_INVALID';
  return 'AGY_PROVIDER_OUTPUT_INVALID';
}

function isEnvelopeAuthRequired(error: unknown): boolean {
  return error instanceof Error && containsAuthenticationMarker(error.message);
}

export class AntigravityProvider implements ProviderAdapter {
  readonly id: string;
  private readonly executable: string;
  private readonly staleAfterSeconds: number;
  private readonly printTimeoutSeconds: number;
  private readonly timeoutMs: number;
  private readonly cwd: string | undefined;
  private readonly now: () => Date;
  private readonly spawnProcess: AntigravityProcessFactory | undefined;
  private currentHealth: ProviderHealth = 'UNAVAILABLE';

  constructor(options: AntigravityProviderOptions) {
    if (options.executable.trim().length === 0) {
      throw new Error('AntigravityProvider executable is required');
    }
    this.id = ProviderIdSchema.parse(options.id ?? 'antigravity');
    this.executable = options.executable;
    this.staleAfterSeconds = StaleAfterSecondsSchema.parse(
      options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS,
    );
    this.printTimeoutSeconds = options.printTimeoutSeconds ?? DEFAULT_PRINT_TIMEOUT_SECONDS;
    if (
      !Number.isInteger(this.printTimeoutSeconds) ||
      this.printTimeoutSeconds <= 0 ||
      this.printTimeoutSeconds > MAX_PRINT_TIMEOUT_SECONDS
    ) {
      throw new Error(
        `AntigravityProvider printTimeoutSeconds must be between 1 and ${MAX_PRINT_TIMEOUT_SECONDS}`,
      );
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new Error(`AntigravityProvider timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
    }
    this.cwd = options.cwd;
    this.now = options.now ?? (() => new Date());
    this.spawnProcess = options.spawnProcess;
  }

  capabilities(): ProviderCapabilities {
    return {
      usageRead: {
        supported: true,
        contract: 'observed_undocumented',
        notes: 'official agy /usage headless JSON output; nested quota fields may drift',
      },
      resetRead: {
        supported: true,
        contract: 'observed_undocumented',
        notes: 'resetAt is preserved only when returned as a valid UTC timestamp',
      },
      windowTrigger: {
        supported: false,
        contract: 'unknown',
        consumesQuota: 'unknown',
        notes: 'Antigravity adapter is read-only and never sends a prompt',
      },
    };
  }

  health(ctx: ProviderContext): Promise<ProviderHealth> {
    void ctx;
    return Promise.resolve(this.currentHealth);
  }

  async inspect(ctx: ProviderContext): Promise<ProviderObservation> {
    let observedAt = new Date().toISOString();
    try {
      const now = this.now();
      if (!Number.isFinite(now.getTime())) throw new AntigravityOutputError();
      observedAt = now.toISOString();

      const stdout = await runAntigravityUsageCommand({
        executable: this.executable,
        printTimeoutSeconds: this.printTimeoutSeconds,
        timeoutMs: this.timeoutMs,
        ...(this.cwd ? { cwd: this.cwd } : {}),
        ...(this.spawnProcess ? { spawnProcess: this.spawnProcess } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      let envelope: ReturnType<typeof parseAntigravityUsageEnvelope>;
      try {
        envelope = parseAntigravityUsageEnvelope(JSON.parse(stdout) as unknown);
      } catch {
        throw new AntigravityOutputError();
      }

      if (envelope.status !== 'SUCCESS') {
        if (containsAuthenticationMarker(envelope.error)) {
          throw new AntigravityTransportError('AUTH_REQUIRED');
        }
        throw new AntigravityTransportError('PROVIDER_UNAVAILABLE');
      }
      if (!envelope.command || envelope.command.name !== 'usage') {
        throw new AntigravityOutputError();
      }

      const windows = envelope.command.data.groups.flatMap((group, index) =>
        group.buckets.map((bucket) => normalizeBucket(this.id, group, index, bucket, observedAt)),
      );
      const observation = parseProviderObservation({
        providerId: this.id,
        health: windows.length > 0 ? 'UP' : 'DEGRADED',
        observedAt,
        staleAfterSeconds: this.staleAfterSeconds,
        windows,
        ...(windows.length === 0 ? { summary: 'AGY_NO_SUPPORTED_WINDOWS' } : {}),
      });
      this.currentHealth = observation.health;
      return observation;
    } catch (error) {
      const health = healthFor(error);
      this.currentHealth = health;
      return parseProviderObservation({
        providerId: this.id,
        health,
        observedAt,
        staleAfterSeconds: this.staleAfterSeconds,
        windows: [],
        summary: isEnvelopeAuthRequired(error) ? 'AGY_AUTH_REQUIRED' : summaryFor(error),
      });
    }
  }
}
