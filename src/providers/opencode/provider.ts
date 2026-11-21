import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ProviderActionResultSchema,
  ProviderIdSchema,
  StaleAfterSecondsSchema,
  TriggerWindowRequestSchema,
  parseProviderObservation,
} from '../../domain/schemas.js';
import type {
  Confidence,
  EvidenceSource,
  Fact,
  ProviderActionResult,
  ProviderCapabilities,
  ProviderHealth,
  ProviderObservation,
  TriggerWindowRequest,
  WindowPhase,
  WindowSnapshot,
} from '../../domain/types.js';
import type { ProviderAdapter, ProviderCleanupArtifact, ProviderContext } from '../provider.js';
import {
  OpenCodeOutputError,
  generateOpenCodeSessionId,
  isOpenCodeSessionId,
  parseRunEvent,
  parseUsageEnvelope,
  type OpenCodeMeterKind,
  type OpenCodeUsageMeter,
  type OpenCodeUsageReport,
} from './protocol.js';
import {
  openCodeProcessEnvironment,
  runOpenCodeCli,
  type OpenCodeCliRunResult,
  type OpenCodeProcessFactory,
} from './transport.js';

export const OPENCODE_GO_PROVIDER_ID = 'opencode_go';
export const OPENCODE_GO_FIVE_HOUR_WINDOW = 'opencode_go_five_hour';
export const OPENCODE_GO_WEEKLY_WINDOW = 'opencode_go_weekly';
export const OPENCODE_GO_MONTHLY_WINDOW = 'opencode_go_monthly';
export const OPENCODE_GO_TRIGGER_MESSAGE = 'Hi!';
export const OPENCODE_GO_DEFAULT_TRIGGER_MODEL = 'opencode-go/deepseek-v4.1-flash';
/** Go models are addressed as `opencode-go/<model-id>`; nothing else is a valid target. */
export const OPENCODE_GO_TRIGGER_MODEL_PATTERN = /^opencode-go\/[a-z0-9][a-z0-9._-]{0,95}$/;

const DEFAULT_STALE_AFTER_SECONDS = 600;
const DEFAULT_READ_TIMEOUT_MS = 60_000;
const MAX_READ_TIMEOUT_MS = 120_000;
const DEFAULT_ACTION_TIMEOUT_MS = 90_000;
const MAX_ACTION_TIMEOUT_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 30_000;
const MAX_USAGE_STDOUT_BYTES = 256 * 1024;
const MAX_ACTION_STDOUT_BYTES = 1024 * 1024;
const MAX_CLEANUP_STDOUT_BYTES = 16 * 1024;
const MAX_ACTION_LINE_BYTES = 1024 * 1024;
const USAGE_ROUTE = '/api/experimental/usage/limits';

const CANONICAL_METERS: Readonly<
  Record<
    OpenCodeMeterKind,
    { windowKind: string; durationSeconds?: number; maxResetHorizonSeconds: number }
  >
> = {
  // Official docs: the 5-hour window "starts when you first use your allowance
  // and lasts five hours"; before it starts the rolling reset is five hours out.
  rolling: {
    windowKind: OPENCODE_GO_FIVE_HOUR_WINDOW,
    durationSeconds: 18_000,
    maxResetHorizonSeconds: 18_000 + 3_600,
  },
  // Official docs: the weekly limit "resets on Monday at 00:00 UTC".
  weekly: {
    windowKind: OPENCODE_GO_WEEKLY_WINDOW,
    durationSeconds: 604_800,
    maxResetHorizonSeconds: 604_800 + 86_400,
  },
  // The monthly allowance follows the paid period, so its length varies and no
  // fixed duration is claimed.
  monthly: {
    windowKind: OPENCODE_GO_MONTHLY_WINDOW,
    maxResetHorizonSeconds: 35 * 86_400,
  },
};

export interface OpenCodeGoProviderOptions {
  /** Dedicated official-client state directory (HOME and every XDG base). */
  homeDirectory: string;
  /** Empty private working directory used for every CLI invocation. */
  workspaceDirectory?: string;
  id?: string;
  executable?: string;
  staleAfterSeconds?: number;
  readTimeoutMs?: number;
  actionTimeoutMs?: number;
  triggerEnabled?: boolean;
  triggerModel?: string;
  now?: () => Date;
  spawnProcess?: OpenCodeProcessFactory;
  /** Test seam for the AWM-chosen session ID. */
  generateSessionId?: () => string;
}

class OpenCodeReadError extends Error {
  constructor(
    readonly health: ProviderHealth,
    readonly summary: string,
  ) {
    super(summary);
    this.name = 'OpenCodeReadError';
  }
}

class OpenCodeCleanupError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'OpenCodeCleanupError';
  }
}

function fact<T>(
  value: T,
  source: EvidenceSource,
  confidence: Confidence,
  observedAt: string,
): Fact<T> {
  return { value, source, confidence, observedAt };
}

export function openCodeWindowKindForMeter(kind: OpenCodeMeterKind): string {
  return CANONICAL_METERS[kind].windowKind;
}

/**
 * Normalize one Go meter at the time the official client returned it.
 *
 * - a future reset with consumption is an anchored ACTIVE (or EXHAUSTED) window;
 * - a future reset with zero consumption is UNKNOWN: before the first request
 *   the server reports the rolling reset five hours from now, which is
 *   indistinguishable from an anchored window in one snapshot, so the
 *   application's temporal-evidence tracker decides;
 * - `limited` (the server refuses requests) or 100% is EXHAUSTED;
 * - a reset at or before the read is RESET_DUE, never evidence of a new allowance.
 */
export function openCodeWindowSnapshot(
  providerId: string,
  meter: OpenCodeUsageMeter,
  observedAt: string,
): WindowSnapshot {
  const canonical = CANONICAL_METERS[meter.kind];
  const observedMs = Date.parse(observedAt);
  const resetMs = Date.parse(meter.resetsAt);
  const usageRatio = Math.min(meter.percent, 100) / 100;

  const snapshot: WindowSnapshot = {
    providerId,
    windowKind: canonical.windowKind,
    observedAt,
    phase: fact<WindowPhase>('UNKNOWN', 'unknown', 'unknown', observedAt),
    resetAt: fact(meter.resetsAt, 'official_supported', 'exact', observedAt),
  };
  if (canonical.durationSeconds !== undefined) {
    snapshot.durationSeconds = fact(
      canonical.durationSeconds,
      'official_supported',
      'high',
      observedAt,
    );
  }
  if (resetMs > observedMs + canonical.maxResetHorizonSeconds * 1000) {
    throw new OpenCodeOutputError('SCHEMA_CHANGED');
  }
  if (resetMs <= observedMs) {
    snapshot.phase = fact<WindowPhase>('RESET_DUE', 'inferred', 'high', observedAt);
    return snapshot;
  }

  snapshot.usageRatio = fact(usageRatio, 'official_supported', 'exact', observedAt);
  snapshot.remainingRatio = fact(1 - usageRatio, 'inferred', 'exact', observedAt);
  if (canonical.durationSeconds !== undefined) {
    snapshot.startedAt = fact(
      new Date(resetMs - canonical.durationSeconds * 1000).toISOString(),
      'inferred',
      'medium',
      observedAt,
    );
  }
  if (meter.limited || meter.percent >= 100) {
    snapshot.phase = fact<WindowPhase>('EXHAUSTED', 'inferred', 'high', observedAt);
  } else if (meter.percent > 0) {
    snapshot.phase = fact<WindowPhase>('ACTIVE', 'inferred', 'high', observedAt);
  }
  return snapshot;
}

export class OpenCodeGoProvider implements ProviderAdapter {
  readonly id: string;
  private readonly homeDirectory: string;
  private readonly workspaceDirectory: string;
  private readonly executable: string;
  private readonly staleAfterSeconds: number;
  private readonly readTimeoutMs: number;
  private readonly actionTimeoutMs: number;
  private readonly triggerEnabled: boolean;
  private readonly triggerModel: string;
  private readonly now: () => Date;
  private readonly spawnProcess: OpenCodeProcessFactory | undefined;
  private readonly newSessionId: () => string;
  private currentHealth: ProviderHealth = 'UNAVAILABLE';

  constructor(options: OpenCodeGoProviderOptions) {
    if (options.homeDirectory.trim().length === 0) {
      throw new Error('OpenCodeGoProvider homeDirectory is required');
    }
    this.id = ProviderIdSchema.parse(options.id ?? OPENCODE_GO_PROVIDER_ID);
    this.homeDirectory = resolve(options.homeDirectory);
    this.workspaceDirectory = resolve(options.workspaceDirectory ?? '/tmp/awm-opencode-go');
    this.executable = options.executable ?? 'opencode';
    this.staleAfterSeconds = StaleAfterSecondsSchema.parse(
      options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS,
    );
    this.readTimeoutMs = boundedTimeout(
      options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
      MAX_READ_TIMEOUT_MS,
      'readTimeoutMs',
    );
    this.actionTimeoutMs = boundedTimeout(
      options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
      MAX_ACTION_TIMEOUT_MS,
      'actionTimeoutMs',
    );
    this.triggerEnabled = options.triggerEnabled ?? false;
    this.triggerModel = options.triggerModel ?? OPENCODE_GO_DEFAULT_TRIGGER_MODEL;
    if (!OPENCODE_GO_TRIGGER_MODEL_PATTERN.test(this.triggerModel)) {
      throw new Error('OpenCodeGoProvider triggerModel must be an opencode-go/<model> ID');
    }
    this.now = options.now ?? (() => new Date());
    this.spawnProcess = options.spawnProcess;
    this.newSessionId = options.generateSessionId ?? (() => generateOpenCodeSessionId());
  }

  capabilities(): ProviderCapabilities {
    return {
      usageRead: {
        supported: true,
        contract: 'official_client_internal',
        notes:
          'Official opencode client, private standalone server: experimental GET /api/experimental/usage/limits; no model turn',
      },
      resetRead: {
        supported: true,
        contract: 'official_client_internal',
        notes: 'resetAt is the server-reported reset of each Go meter (rolling, weekly, monthly)',
      },
      windowTrigger: {
        supported: this.triggerEnabled,
        contract: this.triggerEnabled ? 'official_client_internal' : 'unknown',
        consumesQuota: true,
        ...(this.triggerEnabled ? { supportedWindowKinds: [OPENCODE_GO_FIVE_HOUR_WINDOW] } : {}),
        notes: this.triggerEnabled
          ? `Ordinary official opencode run (${OPENCODE_GO_TRIGGER_MESSAGE}) on a paid Go model; consumes shared Go allowance. Weekly and monthly windows start by themselves and are never targets.`
          : 'Disabled by AWM_OPENCODE_GO_TRIGGER_ENABLED; monitoring only',
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
      const startedAt = this.now();
      if (!Number.isFinite(startedAt.getTime())) throw new Error('invalid observation time');
      observedAt = startedAt.toISOString();
      const report = await this.readUsage(ctx.signal);
      // Normalize against the completion time of the official read.
      const completedAt = this.now();
      if (!Number.isFinite(completedAt.getTime())) throw new Error('invalid observation time');
      observedAt = completedAt.toISOString();
      if (report.status === 'signed_out') {
        throw new OpenCodeReadError('AUTH_REQUIRED', 'OPENCODE_GO_AUTH_REQUIRED');
      }
      if (report.status === 'no_go') {
        throw new OpenCodeReadError('DEGRADED', 'OPENCODE_GO_NOT_SUBSCRIBED');
      }
      const windows = report.meters.map((meter) =>
        openCodeWindowSnapshot(this.id, meter, observedAt),
      );
      const observation = parseProviderObservation({
        providerId: this.id,
        health: 'UP',
        observedAt,
        staleAfterSeconds: this.staleAfterSeconds,
        windows,
      });
      this.currentHealth = observation.health;
      return observation;
    } catch (error) {
      const failure = classifyReadFailure(error);
      this.currentHealth = failure.health;
      return parseProviderObservation({
        providerId: this.id,
        health: failure.health,
        observedAt,
        staleAfterSeconds: this.staleAfterSeconds,
        windows: [],
        summary: failure.summary,
      });
    }
  }

  private async readUsage(signal?: AbortSignal): Promise<OpenCodeUsageReport> {
    this.ensureDirectories();
    const run = await runOpenCodeCli({
      executable: this.executable,
      args: ['--standalone', 'api', 'GET', USAGE_ROUTE],
      cwd: this.workspaceDirectory,
      env: openCodeProcessEnvironment(this.homeDirectory),
      timeoutMs: this.readTimeoutMs,
      maxStdoutBytes: MAX_USAGE_STDOUT_BYTES,
      collectStdout: true,
      ...(signal ? { signal } : {}),
      ...(this.spawnProcess ? { spawnProcess: this.spawnProcess } : {}),
    });
    assertProcessCompleted(run);
    return readReport(run);
  }

  async triggerWindow(
    ctx: ProviderContext,
    request: TriggerWindowRequest,
  ): Promise<ProviderActionResult> {
    let occurredAt: Date;
    try {
      occurredAt = this.now();
    } catch {
      return actionResult('rejected', 'OPENCODE_GO_INVALID_TIME', new Date(0));
    }
    if (!Number.isFinite(occurredAt.getTime())) {
      return actionResult('rejected', 'OPENCODE_GO_INVALID_TIME', new Date(0));
    }
    if (!this.triggerEnabled) {
      return actionResult('rejected', 'OPENCODE_GO_TRIGGER_DISABLED', occurredAt);
    }
    if (!TriggerWindowRequestSchema.safeParse(request).success) {
      return actionResult('rejected', 'OPENCODE_GO_TRIGGER_REQUEST_INVALID', occurredAt);
    }
    if (request.windowKind !== OPENCODE_GO_FIVE_HOUR_WINDOW) {
      return actionResult('rejected', 'OPENCODE_GO_TRIGGER_TARGET_UNSUPPORTED', occurredAt);
    }
    if (!ctx.registerCleanupArtifact) {
      return actionResult('rejected', 'OPENCODE_GO_CLEANUP_REGISTRATION_REQUIRED', occurredAt);
    }
    try {
      this.ensureDirectories();
    } catch {
      return actionResult('failed', 'PROCESS_START_FAILED', occurredAt);
    }

    // AWM chooses the exact session ID and persists the cleanup obligation
    // before any process (and therefore any prompt) exists.
    const sessionId = this.newSessionId();
    if (!isOpenCodeSessionId(sessionId)) {
      return actionResult('failed', 'OPENCODE_GO_SESSION_ID_INVALID', occurredAt);
    }
    try {
      await ctx.registerCleanupArtifact({ kind: 'opencode_session', externalId: sessionId });
    } catch {
      return actionResult('failed', 'OPENCODE_GO_CLEANUP_REGISTRATION_FAILED', occurredAt);
    }

    // The executor's final authorization gate runs immediately before the
    // process (and therefore the prompt) is started.
    ctx.assertDispatchAllowed?.();

    let stepFinished = false;
    let stepStarted = false;
    let errorType: string | undefined;
    let sessionMismatch = false;
    let malformed = false;
    const run = await runOpenCodeCli({
      executable: this.executable,
      args: [
        '--standalone',
        'run',
        '--format',
        'json',
        '--session',
        sessionId,
        '--archived',
        '--model',
        this.triggerModel,
        OPENCODE_GO_TRIGGER_MESSAGE,
      ],
      cwd: this.workspaceDirectory,
      env: openCodeProcessEnvironment(this.homeDirectory),
      timeoutMs: this.actionTimeoutMs,
      maxStdoutBytes: MAX_ACTION_STDOUT_BYTES,
      maxLineBytes: MAX_ACTION_LINE_BYTES,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(this.spawnProcess ? { spawnProcess: this.spawnProcess } : {}),
      onLine: (line) => {
        let event;
        try {
          event = parseRunEvent(line);
        } catch {
          malformed = true;
          return 'continue';
        }
        if (event.sessionId !== null && event.sessionId !== sessionId) sessionMismatch = true;
        if (event.kind === 'step_start') stepStarted = true;
        else if (event.kind === 'step_finish') stepFinished = true;
        else if (event.kind === 'error') errorType ??= event.errorType;
        return 'continue';
      },
    });
    // Response text, reasoning and tool output are never parsed or retained.

    if (!run.started) return actionResult('failed', 'PROCESS_START_FAILED', occurredAt);
    if (errorType === 'provider.no-route' && !stepStarted && !stepFinished) {
      // The client could not route the model, so no model request was made.
      return actionResult('failed', 'OPENCODE_GO_MODEL_UNAVAILABLE', occurredAt);
    }
    if (sessionMismatch) {
      return actionResult('uncertain', 'OPENCODE_GO_TRIGGER_SESSION_MISMATCH', occurredAt);
    }
    if (run.timedOut) return actionResult('uncertain', 'OPENCODE_GO_TRIGGER_TIMEOUT', occurredAt);
    if (run.aborted) return actionResult('uncertain', 'OPENCODE_GO_TRIGGER_ABORTED', occurredAt);
    if (run.overflow || malformed) {
      return actionResult('uncertain', 'OPENCODE_GO_TRIGGER_OUTPUT_INVALID', occurredAt);
    }
    if (run.exitCode === 0 && stepFinished && errorType === undefined) {
      return actionResult('succeeded', undefined, occurredAt, 'OPENCODE_GO_TURN_COMPLETED');
    }
    if (errorType !== undefined) {
      return actionResult('uncertain', 'OPENCODE_GO_TRIGGER_API_ERROR', occurredAt);
    }
    return actionResult('uncertain', 'OPENCODE_GO_TRIGGER_OUTCOME_UNKNOWN', occurredAt);
  }

  /**
   * Delete the exact disposable session created by an AWM trigger through the
   * official `opencode session delete`. Never touches any other session ID.
   */
  async cleanupArtifact(ctx: ProviderContext, artifact: ProviderCleanupArtifact): Promise<void> {
    if (artifact.kind !== 'opencode_session' || !isOpenCodeSessionId(artifact.externalId)) {
      throw new OpenCodeCleanupError('OPENCODE_GO_CLEANUP_ARTIFACT_INVALID');
    }
    try {
      this.ensureDirectories();
    } catch {
      throw new OpenCodeCleanupError('PROCESS_START_FAILED');
    }
    const run = await runOpenCodeCli({
      executable: this.executable,
      args: ['--standalone', 'session', 'delete', artifact.externalId],
      cwd: this.workspaceDirectory,
      env: openCodeProcessEnvironment(this.homeDirectory),
      timeoutMs: CLEANUP_TIMEOUT_MS,
      maxStdoutBytes: MAX_CLEANUP_STDOUT_BYTES,
      collectStderr: true,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(this.spawnProcess ? { spawnProcess: this.spawnProcess } : {}),
    });
    if (!run.started) throw new OpenCodeCleanupError('PROCESS_START_FAILED');
    if (run.timedOut) throw new OpenCodeCleanupError('OPENCODE_GO_CLEANUP_TIMEOUT');
    if (run.aborted) throw new OpenCodeCleanupError('OPENCODE_GO_CLEANUP_ABORTED');
    if (run.exitCode === 0) return;
    // An already-deleted session is the desired end state, not a failure.
    if (run.stderr.includes(`Session not found: ${artifact.externalId}`)) return;
    throw new OpenCodeCleanupError('OPENCODE_GO_CLEANUP_FAILED');
  }

  private ensureDirectories(): void {
    for (const directory of [this.workspaceDirectory, this.homeDirectory]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
  }
}

function readReport(run: OpenCodeCliRunResult): OpenCodeUsageReport {
  if (run.exitCode !== 0) throw new OpenCodeOutputError('OUTPUT_INVALID');
  return parseUsageEnvelope(run.stdout);
}

function boundedTimeout(value: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`OpenCodeGoProvider ${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function assertProcessCompleted(run: OpenCodeCliRunResult): void {
  if (run.aborted) throw new OpenCodeReadError('UNAVAILABLE', 'OPENCODE_GO_PROVIDER_UNAVAILABLE');
  if (!run.started) {
    throw new OpenCodeReadError('UNAVAILABLE', 'OPENCODE_GO_EXECUTABLE_UNAVAILABLE');
  }
  if (run.timedOut) throw new OpenCodeReadError('UNAVAILABLE', 'OPENCODE_GO_PROVIDER_TIMEOUT');
  if (run.overflow) throw new OpenCodeOutputError('OUTPUT_INVALID');
}

function classifyReadFailure(error: unknown): { health: ProviderHealth; summary: string } {
  if (error instanceof OpenCodeReadError) return { health: error.health, summary: error.summary };
  if (error instanceof OpenCodeOutputError && error.code === 'SCHEMA_CHANGED') {
    return { health: 'ERROR', summary: 'OPENCODE_GO_CONTRACT_CHANGED' };
  }
  return { health: 'ERROR', summary: 'OPENCODE_GO_OUTPUT_INVALID' };
}

function actionResult(
  status: ProviderActionResult['status'],
  errorCode: string | undefined,
  occurredAt: Date,
  confirmationHint?: string,
): ProviderActionResult {
  return ProviderActionResultSchema.parse({
    status,
    occurredAt: occurredAt.toISOString(),
    ...(errorCode ? { errorCode } : {}),
    ...(confirmationHint ? { confirmationHint } : {}),
  }) as ProviderActionResult;
}
