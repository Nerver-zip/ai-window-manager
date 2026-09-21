import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ProviderActionResultSchema,
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
  ProviderActionResult,
} from '../../domain/types.js';
import type { ProviderAdapter, ProviderContext } from '../provider.js';
import {
  CodexAppServerClient,
  CodexTransportError,
  type CodexAppServerClientOptions,
  type CodexProcessFactory,
} from './transport.js';
import {
  parseCodexRateLimitsResponse,
  type CodexRateLimitSnapshot,
  type CodexRateLimitWindow,
  type CodexRateLimitsResponse,
} from './protocol.js';

const DEFAULT_STALE_AFTER_SECONDS = 300;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
export const CODEX_TRIGGER_MESSAGE = 'Hi!';

export interface CodexProviderOptions {
  codexHome: string;
  id?: string;
  executable?: string;
  staleAfterSeconds?: number;
  requestTimeoutMs?: number;
  triggerEnabled?: boolean;
  triggerWorkspace?: string;
  now?: () => Date;
  spawnProcess?: CodexProcessFactory;
}

interface Bucket {
  key: string;
  snapshot: CodexRateLimitSnapshot;
}

type WindowSlot = 'primary' | 'secondary';

function fact<T>(
  value: T,
  source: EvidenceSource,
  confidence: Confidence,
  observedAt: string,
): Fact<T> {
  return { value, source, confidence, observedAt };
}

function normalizedMachineKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
  const base = normalized.length > 0 ? normalized : 'bucket';
  return `codex_${base}`.slice(0, 48);
}

function uniqueWindowKind(base: string, slot: WindowSlot, used: Set<string>): string {
  const root = `${base}_${slot}`.slice(0, 64);
  let candidate = root;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${root.slice(0, 61 - String(suffix).length)}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function toUtcInstant(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid reset timestamp');
  return date.toISOString();
}

function durationSeconds(window: CodexRateLimitWindow): number | undefined {
  if (window.windowDurationMins === null || window.windowDurationMins === undefined)
    return undefined;
  const seconds = window.windowDurationMins * 60;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 31_622_400) {
    throw new Error('invalid window duration');
  }
  return seconds;
}

function windowSnapshot(
  providerId: string,
  windowKind: string,
  window: CodexRateLimitWindow,
  observedAt: string,
  inferPhase: boolean,
): WindowSnapshot {
  const duration = durationSeconds(window);
  const resetAt =
    window.resetsAt === null || window.resetsAt === undefined
      ? undefined
      : toUtcInstant(window.resetsAt);
  const snapshot: WindowSnapshot = {
    providerId,
    windowKind,
    observedAt,
    phase: fact<WindowPhase>('UNKNOWN', 'unknown', 'unknown', observedAt),
    ...(duration === undefined
      ? {}
      : { durationSeconds: fact(duration, 'official_supported', 'exact', observedAt) }),
    ...(resetAt === undefined
      ? {}
      : { resetAt: fact(resetAt, 'official_supported', 'exact', observedAt) }),
    usageRatio: fact(window.usedPercent / 100, 'official_supported', 'exact', observedAt),
    remainingRatio: fact(1 - window.usedPercent / 100, 'inferred', 'exact', observedAt),
  };

  if (duration !== undefined && resetAt !== undefined) {
    const startedAt = new Date(new Date(resetAt).getTime() - duration * 1000);
    snapshot.startedAt = fact(startedAt.toISOString(), 'inferred', 'high', observedAt);
  }
  if (inferPhase && resetAt !== undefined) {
    const isResetDue = new Date(resetAt).getTime() <= new Date(observedAt).getTime();
    let phase: WindowPhase;
    if (window.usedPercent === 0 || isResetDue) {
      phase = 'INACTIVE';
    } else if (window.usedPercent >= 100) {
      phase = 'EXHAUSTED';
    } else {
      phase = 'ACTIVE';
    }
    snapshot.phase = fact(phase, 'inferred', 'high', observedAt);
  }
  return snapshot;
}

function buckets(response: CodexRateLimitsResponse): Bucket[] {
  const map = response.rateLimitsByLimitId;
  if (map && Object.keys(map).length > 0) {
    return Object.entries(map).map(([key, snapshot]) => ({ key, snapshot }));
  }
  return [{ key: response.rateLimits.limitId ?? 'primary', snapshot: response.rateLimits }];
}

function healthFor(error: unknown): ProviderHealth {
  if (error instanceof CodexTransportError) {
    if (error.code === 'AUTH_REQUIRED') return 'AUTH_REQUIRED';
    if (
      error.code === 'TIMEOUT' ||
      error.code === 'EOF' ||
      error.code === 'PROCESS_ERROR' ||
      error.code === 'ABORTED'
    ) {
      return 'UNAVAILABLE';
    }
  }
  return 'ERROR';
}

function summaryFor(error: unknown): string {
  if (error instanceof CodexTransportError) return `CODEX_${error.code}`;
  if (error instanceof Error && error.message === 'invalid window duration')
    return 'CODEX_INVALID_RESPONSE';
  if (error instanceof Error && error.message === 'invalid reset timestamp')
    return 'CODEX_INVALID_RESPONSE';
  return 'CODEX_INVALID_RESPONSE';
}

export class CodexProvider implements ProviderAdapter {
  readonly id: string;
  private readonly executable: string;
  private readonly codexHome: string;
  private readonly staleAfterSeconds: number;
  private readonly requestTimeoutMs: number;
  private readonly triggerEnabled: boolean;
  private readonly triggerWorkspace: string;
  private readonly now: () => Date;
  private readonly spawnProcess: CodexProcessFactory | undefined;
  private currentHealth: ProviderHealth = 'UNAVAILABLE';

  constructor(options: CodexProviderOptions) {
    if (options.codexHome.trim().length === 0)
      throw new Error('CodexProvider codexHome is required');
    this.id = ProviderIdSchema.parse(options.id ?? 'codex');
    this.executable = options.executable ?? 'codex';
    this.codexHome = options.codexHome;
    this.staleAfterSeconds = StaleAfterSecondsSchema.parse(
      options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS,
    );
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0 ||
      this.requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      throw new Error(
        `CodexProvider requestTimeoutMs must be between 1 and ${MAX_REQUEST_TIMEOUT_MS}`,
      );
    }
    this.triggerEnabled = options.triggerEnabled ?? false;
    this.triggerWorkspace = resolve(options.triggerWorkspace ?? '/tmp/awm-codex-trigger');
    this.now = options.now ?? (() => new Date());
    this.spawnProcess = options.spawnProcess;
  }

  capabilities(): ProviderCapabilities {
    return {
      usageRead: {
        supported: true,
        contract: 'official_supported',
        notes: 'account/rateLimits/read returns nullable usage windows',
      },
      resetRead: {
        supported: true,
        contract: 'official_supported',
        notes: 'resetAt is preserved only when returned by the official client',
      },
      windowTrigger: {
        supported: this.triggerEnabled,
        contract: 'official_supported',
        consumesQuota: true,
        notes: this.triggerEnabled
          ? 'Enabled opt-in ordinary official app-server turn; sends a fixed minimal Hi! message'
          : 'Disabled by AWM_CODEX_TRIGGER_ENABLED; no quota-consuming action is available',
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
      if (!Number.isFinite(now.getTime())) throw new Error('invalid observation time');
      observedAt = now.toISOString();

      const clientOptions: CodexAppServerClientOptions = {
        executable: this.executable,
        codexHome: this.codexHome,
        requestTimeoutMs: this.requestTimeoutMs,
        ...(this.spawnProcess ? { spawnProcess: this.spawnProcess } : {}),
      };
      const client = new CodexAppServerClient(clientOptions);
      const rawResponse = await client.readRateLimits(ctx.signal);
      const response = parseCodexRateLimitsResponse(rawResponse);
      const observation = this.normalize(response, observedAt);
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
        summary: summaryFor(error),
      });
    }
  }

  private normalize(response: CodexRateLimitsResponse, observedAt: string): ProviderObservation {
    const usedWindowKinds = new Set<string>();
    const windows: WindowSnapshot[] = [];
    for (const bucket of buckets(response)) {
      const base = normalizedMachineKey(bucket.key);
      for (const slot of ['primary', 'secondary'] as const) {
        const rateWindow = bucket.snapshot[slot];
        if (!rateWindow) continue;
        windows.push(
          windowSnapshot(
            this.id,
            uniqueWindowKind(base, slot, usedWindowKinds),
            rateWindow,
            observedAt,
            this.triggerEnabled,
          ),
        );
      }
    }

    return parseProviderObservation({
      providerId: this.id,
      health: windows.length > 0 ? 'UP' : 'DEGRADED',
      observedAt,
      staleAfterSeconds: this.staleAfterSeconds,
      windows,
      ...(windows.length === 0 ? { summary: 'CODEX_NO_RATE_LIMIT_WINDOWS' } : {}),
    });
  }

  async triggerWindow(
    ctx: ProviderContext,
    request: Parameters<NonNullable<ProviderAdapter['triggerWindow']>>[1],
  ): Promise<ProviderActionResult> {
    void request;
    const occurredAt = this.now();
    if (!Number.isFinite(occurredAt.getTime())) {
      return actionResult('rejected', 'CODEX_INVALID_TIME', undefined, new Date(0));
    }
    if (!this.triggerEnabled) {
      return actionResult('rejected', 'CODEX_TRIGGER_DISABLED', undefined, occurredAt);
    }

    try {
      mkdirSync(this.triggerWorkspace, { recursive: true, mode: 0o700 });
      chmodSync(this.triggerWorkspace, 0o700);
      const clientOptions: CodexAppServerClientOptions = {
        executable: this.executable,
        codexHome: this.codexHome,
        requestTimeoutMs: this.requestTimeoutMs,
        ...(this.spawnProcess ? { spawnProcess: this.spawnProcess } : {}),
      };
      const client = new CodexAppServerClient(clientOptions);
      await client.sendMessage(CODEX_TRIGGER_MESSAGE, this.triggerWorkspace, ctx.signal);
      return actionResult('succeeded', undefined, 'CODEX_TURN_COMPLETED', occurredAt);
    } catch (error) {
      return triggerFailureResult(error, occurredAt);
    }
  }
}

function actionResult(
  status: ProviderActionResult['status'],
  errorCode: string | undefined,
  confirmationHint: string | undefined,
  occurredAt: Date,
): ProviderActionResult {
  const raw = {
    status,
    occurredAt: occurredAt.toISOString(),
    ...(confirmationHint ? { confirmationHint } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
  return ProviderActionResultSchema.parse(raw) as ProviderActionResult;
}

function triggerFailureResult(error: unknown, occurredAt: Date): ProviderActionResult {
  if (!(error instanceof CodexTransportError)) {
    return actionResult('uncertain', 'CODEX_TURN_OUTCOME_UNKNOWN', undefined, occurredAt);
  }

  if (error.code === 'AUTH_REQUIRED') {
    return actionResult('failed', 'AUTH_REQUIRED', undefined, occurredAt);
  }

  if (error.stage === 'initialize' || error.stage === 'thread_start') {
    if (error.code === 'PROTOCOL_ERROR') {
      return actionResult('rejected', 'CODEX_THREAD_START_REJECTED', undefined, occurredAt);
    }
    return actionResult('failed', 'PROCESS_START_FAILED', undefined, occurredAt);
  }

  if (error.stage === 'turn_start' && error.code === 'PROTOCOL_ERROR') {
    return actionResult('rejected', 'CODEX_TURN_START_REJECTED', undefined, occurredAt);
  }

  if (error.code === 'TURN_FAILED') {
    return actionResult('uncertain', 'CODEX_TURN_FAILED', undefined, occurredAt);
  }

  return actionResult('uncertain', 'CODEX_TURN_OUTCOME_UNKNOWN', undefined, occurredAt);
}
