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
import type { ProviderAdapter, ProviderContext } from '../provider.js';
import {
  ClaudeOutputError,
  parseClaudeAuthStatus,
  parseStreamEvent,
  parseUsageReport,
  type ClaudeAuthState,
  type ClaudeUsageMeter,
  type ClaudeUsageReport,
} from './protocol.js';
import {
  claudeProcessEnvironment,
  runClaudeCli,
  type ClaudeCliRunResult,
  type ClaudeProcessFactory,
} from './transport.js';

export const CLAUDE_CODE_PROVIDER_ID = 'claude_code';
export const CLAUDE_CODE_FIVE_HOUR_WINDOW = 'claude_code_five_hour';
export const CLAUDE_CODE_SEVEN_DAY_WINDOW = 'claude_code_seven_day';
export const CLAUDE_CODE_TRIGGER_MESSAGE = 'Hi!';
export const CLAUDE_CODE_DEFAULT_TRIGGER_MODEL = 'haiku';
export const CLAUDE_CODE_TRIGGER_MODEL_PATTERN =
  /^(?:haiku|sonnet|opus|claude-[a-z0-9][a-z0-9.-]{0,95})$/;

const DEFAULT_STALE_AFTER_SECONDS = 600;
const DEFAULT_READ_TIMEOUT_MS = 45_000;
const MAX_READ_TIMEOUT_MS = 120_000;
const DEFAULT_ACTION_TIMEOUT_MS = 60_000;
const MAX_ACTION_TIMEOUT_MS = 120_000;
const AUTH_STATUS_TIMEOUT_MS = 20_000;
const MAX_USAGE_STDOUT_BYTES = 512 * 1024;
const MAX_ACTION_STDOUT_BYTES = 512 * 1024;
const MAX_AUTH_STDOUT_BYTES = 32 * 1024;
const MAX_WINDOWS = 32;
const AMBIGUOUS_WINDOW_IDENTITY_SUMMARY = 'PROVIDER_WINDOW_IDENTITY_AMBIGUOUS';

const CANONICAL_METERS: Readonly<
  Record<string, { windowKind: string; durationSeconds: number; resetSlackSeconds: number }>
> = {
  session: {
    windowKind: CLAUDE_CODE_FIVE_HOUR_WINDOW,
    durationSeconds: 18_000,
    resetSlackSeconds: 3_600,
  },
  weekly_all: {
    windowKind: CLAUDE_CODE_SEVEN_DAY_WINDOW,
    durationSeconds: 604_800,
    resetSlackSeconds: 86_400,
  },
};

/**
 * Common flags for every non-interactive invocation: no tools, no MCP servers,
 * no user/project/local settings, and no saved session or transcript.
 */
const ISOLATION_FLAGS = [
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--tools',
  '',
  '--strict-mcp-config',
  '--setting-sources',
  '',
] as const;

export interface ClaudeCodeProviderOptions {
  /** Dedicated official-client state directory (`CLAUDE_CONFIG_DIR`). */
  configDirectory: string;
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
  spawnProcess?: ClaudeProcessFactory;
}

class ClaudeWindowIdentityAmbiguousError extends Error {
  constructor() {
    super('multiple Claude Code usage meters map to the same window identity');
    this.name = 'ClaudeWindowIdentityAmbiguousError';
  }
}

class ClaudeReadError extends Error {
  constructor(
    readonly health: ProviderHealth,
    readonly summary: string,
  ) {
    super(summary);
    this.name = 'ClaudeReadError';
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

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .slice(0, 24);
}

/** Stable identity for a server meter; only `session` and `weekly_all` are canonical targets. */
export function claudeWindowKindForMeter(meter: ClaudeUsageMeter): string {
  const canonical = CANONICAL_METERS[meter.kind];
  if (canonical) return canonical.windowKind;
  const kind = slug(meter.kind) || 'meter';
  const scope = meter.scopeLabel ? slug(meter.scopeLabel) : '';
  return `claude_code_${kind}${scope ? `_${scope}` : ''}`.slice(0, 64);
}

/**
 * Normalize one server meter at the time the official client returned it.
 *
 * - a future reset with consumption is an anchored ACTIVE (or EXHAUSTED) window;
 * - a future reset with zero consumption is UNKNOWN: it may be a rolling
 *   projection, so the application's temporal-evidence tracker decides;
 * - the canonical session meter with exact zero use and no reset is INACTIVE
 *   at high confidence: the official CLI omits its session reset until the
 *   first message starts that window;
 * - zero consumption without any reset for other canonical meters is only
 *   INACTIVE at medium confidence, never actionable by itself;
 * - a reset at or before the read is RESET_DUE, never evidence of a new allowance.
 */
export function claudeWindowSnapshot(
  providerId: string,
  meter: ClaudeUsageMeter,
  observedAt: string,
): WindowSnapshot {
  const canonical = CANONICAL_METERS[meter.kind];
  const windowKind = claudeWindowKindForMeter(meter);
  const observedMs = Date.parse(observedAt);
  const percent = Math.min(meter.percent, 100);
  const usageRatio = percent / 100;
  const resetMs = meter.resetsAt === null ? null : Date.parse(meter.resetsAt);

  const snapshot: WindowSnapshot = {
    providerId,
    windowKind,
    observedAt,
    phase: fact<WindowPhase>('UNKNOWN', 'unknown', 'unknown', observedAt),
  };
  if (meter.resetsAt !== null) {
    snapshot.resetAt = fact(meter.resetsAt, 'official_supported', 'exact', observedAt);
  }
  if (!canonical) {
    // Retain additional server meters (for example model-scoped weekly rows)
    // without guessing their cadence or scheduling semantics.
    snapshot.usageRatio = fact(usageRatio, 'official_supported', 'exact', observedAt);
    snapshot.remainingRatio = fact(1 - usageRatio, 'inferred', 'exact', observedAt);
    return snapshot;
  }

  snapshot.durationSeconds = fact(
    canonical.durationSeconds,
    'official_supported',
    'high',
    observedAt,
  );
  if (
    resetMs !== null &&
    resetMs > observedMs + (canonical.durationSeconds + canonical.resetSlackSeconds) * 1000
  ) {
    throw new ClaudeOutputError('SCHEMA_CHANGED');
  }
  if (resetMs !== null && resetMs <= observedMs) {
    snapshot.phase = fact<WindowPhase>('RESET_DUE', 'inferred', 'high', observedAt);
    return snapshot;
  }

  snapshot.usageRatio = fact(usageRatio, 'official_supported', 'exact', observedAt);
  snapshot.remainingRatio = fact(1 - usageRatio, 'inferred', 'exact', observedAt);
  if (resetMs !== null) {
    snapshot.startedAt = fact(
      new Date(resetMs - canonical.durationSeconds * 1000).toISOString(),
      'inferred',
      'medium',
      observedAt,
    );
    if (meter.percent >= 100) {
      snapshot.phase = fact<WindowPhase>('EXHAUSTED', 'inferred', 'high', observedAt);
    } else if (meter.percent > 0) {
      snapshot.phase = fact<WindowPhase>('ACTIVE', 'inferred', 'high', observedAt);
    } else {
      snapshot.phase = fact<WindowPhase>('UNKNOWN', 'inferred', 'unknown', observedAt);
    }
  } else if (meter.percent === 0) {
    const neverStartedSession =
      windowKind === CLAUDE_CODE_FIVE_HOUR_WINDOW &&
      meter.scopeLabel === null &&
      meter.resetsAt === null;
    snapshot.phase = fact<WindowPhase>(
      'INACTIVE',
      'inferred',
      neverStartedSession ? 'high' : 'medium',
      observedAt,
    );
  } else {
    snapshot.phase = fact<WindowPhase>('UNKNOWN', 'inferred', 'unknown', observedAt);
  }
  return snapshot;
}

function triggerModelMatches(configured: string, reported: string): boolean {
  if (configured === 'haiku' || configured === 'sonnet' || configured === 'opus') {
    return reported.startsWith('claude-') && reported.includes(configured);
  }
  return reported === configured;
}

export class ClaudeCodeProvider implements ProviderAdapter {
  readonly id: string;
  private readonly configDirectory: string;
  private readonly workspaceDirectory: string;
  private readonly executable: string;
  private readonly staleAfterSeconds: number;
  private readonly readTimeoutMs: number;
  private readonly actionTimeoutMs: number;
  private readonly triggerEnabled: boolean;
  private readonly triggerModel: string;
  private readonly now: () => Date;
  private readonly spawnProcess: ClaudeProcessFactory | undefined;
  private currentHealth: ProviderHealth = 'UNAVAILABLE';

  constructor(options: ClaudeCodeProviderOptions) {
    if (options.configDirectory.trim().length === 0) {
      throw new Error('ClaudeCodeProvider configDirectory is required');
    }
    this.id = ProviderIdSchema.parse(options.id ?? CLAUDE_CODE_PROVIDER_ID);
    this.configDirectory = resolve(options.configDirectory);
    this.workspaceDirectory = resolve(options.workspaceDirectory ?? '/tmp/awm-claude-code');
    this.executable = options.executable ?? 'claude';
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
    this.triggerModel = options.triggerModel ?? CLAUDE_CODE_DEFAULT_TRIGGER_MODEL;
    if (!CLAUDE_CODE_TRIGGER_MODEL_PATTERN.test(this.triggerModel)) {
      throw new Error('ClaudeCodeProvider triggerModel must be a Claude model alias or ID');
    }
    this.now = options.now ?? (() => new Date());
    this.spawnProcess = options.spawnProcess;
  }

  capabilities(): ProviderCapabilities {
    return {
      usageRead: {
        supported: true,
        contract: 'official_supported',
        notes:
          'Official claude -p /usage local command; experimental structured usage_report, no model turn',
      },
      resetRead: {
        supported: true,
        contract: 'official_supported',
        notes: 'resetAt is preserved only when the server meter reports a valid ISO timestamp',
      },
      windowTrigger: {
        supported: this.triggerEnabled,
        contract: this.triggerEnabled ? 'official_supported' : 'unknown',
        consumesQuota: true,
        ...(this.triggerEnabled ? { supportedWindowKinds: [CLAUDE_CODE_FIVE_HOUR_WINDOW] } : {}),
        notes: this.triggerEnabled
          ? `Ordinary official claude -p request (${CLAUDE_CODE_TRIGGER_MESSAGE}); consumes five-hour and weekly allowance`
          : 'Disabled by AWM_CLAUDE_CODE_TRIGGER_ENABLED; monitoring only',
      },
    };
  }

  health(ctx: ProviderContext): Promise<ProviderHealth> {
    void ctx;
    return Promise.resolve(this.currentHealth);
  }

  /** Read-only official auth status. Never prints or stores account identifiers. */
  async authStatus(signal?: AbortSignal): Promise<ClaudeAuthState> {
    this.ensureWorkspace();
    const run = await runClaudeCli({
      executable: this.executable,
      args: ['auth', 'status', '--json'],
      cwd: this.workspaceDirectory,
      env: claudeProcessEnvironment(this.configDirectory),
      timeoutMs: AUTH_STATUS_TIMEOUT_MS,
      maxStdoutBytes: MAX_AUTH_STDOUT_BYTES,
      collectStdout: true,
      ...(signal ? { signal } : {}),
      ...(this.spawnProcess ? { spawnProcess: this.spawnProcess } : {}),
    });
    if (!run.started || run.timedOut || run.aborted || run.overflow) return { state: 'unknown' };
    return parseClaudeAuthStatus(run.exitCode, run.stdout);
  }

  async inspect(ctx: ProviderContext): Promise<ProviderObservation> {
    let observedAt = new Date().toISOString();
    try {
      const startedAt = this.now();
      if (!Number.isFinite(startedAt.getTime())) throw new Error('invalid observation time');
      observedAt = startedAt.toISOString();
      const report = await this.readUsageReport(ctx.signal);
      // Normalize against the completion time of the official read.
      const completedAt = this.now();
      if (!Number.isFinite(completedAt.getTime())) throw new Error('invalid observation time');
      observedAt = completedAt.toISOString();
      if (report.status === 'unavailable') {
        throw await this.classifyMissingReport(ctx.signal);
      }
      const observation = this.normalize(report.meters, observedAt);
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

  private normalize(meters: readonly ClaudeUsageMeter[], observedAt: string): ProviderObservation {
    if (meters.length > MAX_WINDOWS) throw new ClaudeOutputError('SCHEMA_CHANGED');
    const windows: WindowSnapshot[] = [];
    const seen = new Set<string>();
    for (const meter of meters) {
      const snapshot = claudeWindowSnapshot(this.id, meter, observedAt);
      if (seen.has(snapshot.windowKind)) throw new ClaudeWindowIdentityAmbiguousError();
      seen.add(snapshot.windowKind);
      windows.push(snapshot);
    }
    return parseProviderObservation({
      providerId: this.id,
      health: windows.length > 0 ? 'UP' : 'DEGRADED',
      observedAt,
      staleAfterSeconds: this.staleAfterSeconds,
      windows,
      ...(windows.length === 0 ? { summary: 'CLAUDE_CODE_NO_USAGE_WINDOWS' } : {}),
    });
  }

  private async readUsageReport(signal?: AbortSignal): Promise<ClaudeUsageReport> {
    this.ensureWorkspace();
    let usageMessages = 0;
    let report: ClaudeUsageReport | undefined;
    let result:
      { isError: boolean; numTurns: number | null; localCommand: string | null } | undefined;
    let invalid: ClaudeOutputError | undefined;
    const run = await runClaudeCli({
      executable: this.executable,
      args: ['-p', ...ISOLATION_FLAGS, '/usage'],
      cwd: this.workspaceDirectory,
      env: claudeProcessEnvironment(this.configDirectory),
      timeoutMs: this.readTimeoutMs,
      maxStdoutBytes: MAX_USAGE_STDOUT_BYTES,
      ...(signal ? { signal } : {}),
      ...(this.spawnProcess ? { spawnProcess: this.spawnProcess } : {}),
      onLine: (line) => {
        try {
          const event = parseStreamEvent(line);
          if (event.kind === 'assistant') {
            // Any model-produced message means this was not the local command.
            if (event.localCommand !== 'usage') {
              invalid = new ClaudeOutputError('SCHEMA_CHANGED');
              return 'stop';
            }
            usageMessages += 1;
            report = event.hasUsageReport
              ? parseUsageReport(event.usageReport)
              : { status: 'unavailable' };
          } else if (event.kind === 'result') {
            result = {
              isError: event.isError,
              numTurns: event.numTurns,
              localCommand: event.localCommand,
            };
          }
          return 'continue';
        } catch (error) {
          invalid =
            error instanceof ClaudeOutputError ? error : new ClaudeOutputError('OUTPUT_INVALID');
          return 'stop';
        }
      },
    });
    assertProcessCompleted(run);
    if (invalid) throw invalid;
    if (
      run.exitCode !== 0 ||
      !result ||
      result.isError ||
      result.localCommand !== 'usage' ||
      result.numTurns !== 0 ||
      usageMessages !== 1 ||
      !report
    ) {
      throw new ClaudeOutputError('OUTPUT_INVALID');
    }
    return report;
  }

  private async classifyMissingReport(signal?: AbortSignal): Promise<ClaudeReadError> {
    const auth = await this.authStatus(signal);
    if (auth.state === 'unauthenticated') {
      return new ClaudeReadError('AUTH_REQUIRED', 'CLAUDE_CODE_AUTH_REQUIRED');
    }
    if (auth.state === 'unsupported_auth') {
      return new ClaudeReadError('AUTH_REQUIRED', 'CLAUDE_CODE_SUBSCRIPTION_REQUIRED');
    }
    if (auth.state === 'authenticated') {
      return new ClaudeReadError('DEGRADED', 'CLAUDE_CODE_USAGE_UNAVAILABLE');
    }
    return new ClaudeReadError('ERROR', 'CLAUDE_CODE_AUTH_STATUS_UNKNOWN');
  }

  async triggerWindow(
    ctx: ProviderContext,
    request: TriggerWindowRequest,
  ): Promise<ProviderActionResult> {
    let occurredAt: Date;
    try {
      occurredAt = this.now();
    } catch {
      return actionResult('rejected', 'CLAUDE_CODE_INVALID_TIME', new Date(0));
    }
    if (!Number.isFinite(occurredAt.getTime())) {
      return actionResult('rejected', 'CLAUDE_CODE_INVALID_TIME', new Date(0));
    }
    if (!this.triggerEnabled) {
      return actionResult('rejected', 'CLAUDE_CODE_TRIGGER_DISABLED', occurredAt);
    }
    if (!TriggerWindowRequestSchema.safeParse(request).success) {
      return actionResult('rejected', 'CLAUDE_CODE_TRIGGER_REQUEST_INVALID', occurredAt);
    }
    if (request.windowKind !== CLAUDE_CODE_FIVE_HOUR_WINDOW) {
      return actionResult('rejected', 'CLAUDE_CODE_TRIGGER_TARGET_UNSUPPORTED', occurredAt);
    }
    try {
      this.ensureWorkspace();
    } catch {
      return actionResult('failed', 'PROCESS_START_FAILED', occurredAt);
    }

    // The executor's final authorization gate runs immediately before the
    // process (and therefore the prompt) is started.
    ctx.assertDispatchAllowed?.();

    let initProblem = false;
    let authenticationFailed = false;
    let apiError = false;
    let malformed = false;
    let result: { isError: boolean } | undefined;
    const run = await runClaudeCli({
      executable: this.executable,
      args: [
        '-p',
        ...ISOLATION_FLAGS,
        '--max-turns',
        '1',
        '--disable-slash-commands',
        '--model',
        this.triggerModel,
        CLAUDE_CODE_TRIGGER_MESSAGE,
      ],
      cwd: this.workspaceDirectory,
      env: claudeProcessEnvironment(this.configDirectory),
      timeoutMs: this.actionTimeoutMs,
      maxStdoutBytes: MAX_ACTION_STDOUT_BYTES,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(this.spawnProcess ? { spawnProcess: this.spawnProcess } : {}),
      onLine: (line) => {
        let event;
        try {
          event = parseStreamEvent(line);
        } catch {
          malformed = true;
          return 'continue';
        }
        if (event.kind === 'init') {
          if (
            event.toolCount !== 0 ||
            event.mcpServerCount !== 0 ||
            event.apiKeySource !== 'none' ||
            !triggerModelMatches(this.triggerModel, event.model)
          ) {
            initProblem = true;
            return 'stop';
          }
        } else if (event.kind === 'assistant' && event.error !== null) {
          if (event.error === 'authentication_failed') authenticationFailed = true;
          else apiError = true;
        } else if (event.kind === 'result') {
          result = { isError: event.isError };
        }
        return 'continue';
      },
    });
    // The response text is discarded; only the classified outcome remains.

    if (!run.started) return actionResult('failed', 'PROCESS_START_FAILED', occurredAt);
    if (initProblem) {
      return actionResult('uncertain', 'CLAUDE_CODE_TRIGGER_INIT_UNEXPECTED', occurredAt);
    }
    if (authenticationFailed && result?.isError === true) {
      return actionResult('failed', 'AUTH_REQUIRED', occurredAt);
    }
    if (run.timedOut) return actionResult('uncertain', 'CLAUDE_CODE_TRIGGER_TIMEOUT', occurredAt);
    if (run.aborted) return actionResult('uncertain', 'CLAUDE_CODE_TRIGGER_ABORTED', occurredAt);
    if (run.overflow || malformed) {
      return actionResult('uncertain', 'CLAUDE_CODE_TRIGGER_OUTPUT_INVALID', occurredAt);
    }
    if (result && !result.isError && !apiError && run.exitCode === 0) {
      return actionResult('succeeded', undefined, occurredAt, 'CLAUDE_CODE_TURN_COMPLETED');
    }
    if (result?.isError || apiError) {
      return actionResult('uncertain', 'CLAUDE_CODE_TRIGGER_API_ERROR', occurredAt);
    }
    return actionResult('uncertain', 'CLAUDE_CODE_TRIGGER_OUTCOME_UNKNOWN', occurredAt);
  }

  private ensureWorkspace(): void {
    mkdirSync(this.workspaceDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.workspaceDirectory, 0o700);
  }
}

function boundedTimeout(value: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`ClaudeCodeProvider ${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function assertProcessCompleted(run: ClaudeCliRunResult): void {
  if (run.aborted) throw new ClaudeReadError('UNAVAILABLE', 'CLAUDE_CODE_PROVIDER_UNAVAILABLE');
  if (!run.started) throw new ClaudeReadError('UNAVAILABLE', 'CLAUDE_CODE_EXECUTABLE_UNAVAILABLE');
  if (run.timedOut) throw new ClaudeReadError('UNAVAILABLE', 'CLAUDE_CODE_PROVIDER_TIMEOUT');
  if (run.overflow) throw new ClaudeOutputError('OUTPUT_INVALID');
}

function classifyReadFailure(error: unknown): { health: ProviderHealth; summary: string } {
  if (error instanceof ClaudeReadError) return { health: error.health, summary: error.summary };
  if (error instanceof ClaudeWindowIdentityAmbiguousError) {
    return { health: 'ERROR', summary: AMBIGUOUS_WINDOW_IDENTITY_SUMMARY };
  }
  if (error instanceof ClaudeOutputError && error.code === 'SCHEMA_CHANGED') {
    return { health: 'ERROR', summary: 'CLAUDE_CODE_CONTRACT_CHANGED' };
  }
  return { health: 'ERROR', summary: 'CLAUDE_CODE_OUTPUT_INVALID' };
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
