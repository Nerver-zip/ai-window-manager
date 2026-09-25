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
  ProviderCapabilities,
  ProviderActionResult,
  ProviderHealth,
  ProviderObservation,
  TriggerWindowRequest,
  WindowPhase,
  WindowSnapshot,
} from '../../domain/types.js';
import type { ProviderAdapter, ProviderCleanupArtifact, ProviderContext } from '../provider.js';
import {
  AntigravityOutputError,
  containsAuthenticationMarker,
  parseAntigravityActionEnvelope,
  parseAntigravityUsageEnvelope,
  type AntigravityUsageBucket,
  type AntigravityUsageGroup,
} from './protocol.js';
import {
  AntigravityTransportError,
  AntigravityActionTransportError,
  runAntigravityTriggerCommand,
  runAntigravityUsageCommand,
  type AntigravityProcessFactory,
} from './transport.js';
import { deleteAntigravityConversation } from './cleanup.js';

const DEFAULT_STALE_AFTER_SECONDS = 300;
const DEFAULT_PRINT_TIMEOUT_SECONDS = 30;
const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_ACTION_TIMEOUT_SECONDS = 30;
const MAX_ACTION_TIMEOUT_SECONDS = 120;
const MAX_PRINT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_MS = 305_000;
const MAX_RESET_DISTANCE_MS = 366 * 24 * 60 * 60 * 1000;
// Normalize only tiny endpoint residuals; the observed 99.95% remaining stays active.
const REMAINING_FRACTION_EPSILON = 0.00001;

export interface AntigravityProviderOptions {
  executable: string;
  id?: string;
  staleAfterSeconds?: number;
  printTimeoutSeconds?: number;
  timeoutMs?: number;
  actionTimeoutSeconds?: number;
  antigravityHome?: string;
  triggerEnabled?: boolean;
  triggerModels?: AntigravityTriggerModels;
  cwd?: string;
  now?: () => Date;
  spawnProcess?: AntigravityProcessFactory;
}

export interface AntigravityTriggerModels {
  gemini?: string;
  claudeGpt?: string;
}

export { ANTIGRAVITY_TRIGGER_MESSAGE } from './transport.js';

const TRIGGER_MODEL_GROUP_BY_WINDOW_KIND: Readonly<Record<string, keyof AntigravityTriggerModels>> =
  {
    antigravity_gemini_five_hour: 'gemini',
    antigravity_gemini_weekly: 'gemini',
    antigravity_claude_gpt_five_hour: 'claudeGpt',
    antigravity_claude_gpt_weekly: 'claudeGpt',
  };

const WINDOW_DURATION_SECONDS = {
  '5h': 5 * 60 * 60,
  weekly: 7 * 24 * 60 * 60,
} as const;

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
  if (/\bgemini\b/.test(normalized)) return 'gemini';
  if (/\bclaude\b|\bgpt\b/.test(normalized)) return 'claude_gpt';
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
  const phase = fact<WindowPhase>(
    bucket.remaining_fraction >= 1 - REMAINING_FRACTION_EPSILON
      ? 'INACTIVE'
      : bucket.remaining_fraction <= REMAINING_FRACTION_EPSILON
        ? 'EXHAUSTED'
        : 'ACTIVE',
    'inferred',
    'high',
    observedAt,
  );
  return {
    providerId,
    windowKind: windowKey(group.name, groupIndex, bucket.window),
    observedAt,
    phase,
    durationSeconds: fact(WINDOW_DURATION_SECONDS[bucket.window], 'inferred', 'exact', observedAt),
    usageRatio: fact(1 - bucket.remaining_fraction, 'inferred', 'exact', observedAt),
    remainingRatio: fact(bucket.remaining_fraction, 'observed', 'exact', observedAt),
    ...(resetAt ? { resetAt: fact(resetAt, 'observed', 'exact', observedAt) } : {}),
  };
}

function normalizeTriggerModel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const model = value.trim();
  if (model.length === 0 || model.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(model)) {
    return undefined;
  }
  return model;
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
  private readonly actionTimeoutSeconds: number;
  private readonly antigravityHome: string;
  private readonly triggerEnabled: boolean;
  private readonly triggerModels: AntigravityTriggerModels;
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
    this.actionTimeoutSeconds = options.actionTimeoutSeconds ?? DEFAULT_ACTION_TIMEOUT_SECONDS;
    if (
      !Number.isInteger(this.actionTimeoutSeconds) ||
      this.actionTimeoutSeconds <= 0 ||
      this.actionTimeoutSeconds > MAX_ACTION_TIMEOUT_SECONDS
    ) {
      throw new Error(
        `AntigravityProvider actionTimeoutSeconds must be between 1 and ${MAX_ACTION_TIMEOUT_SECONDS}`,
      );
    }
    this.antigravityHome = options.antigravityHome ?? process.env.HOME ?? process.cwd();
    this.triggerEnabled = options.triggerEnabled ?? false;
    const geminiModel = normalizeTriggerModel(options.triggerModels?.gemini);
    const claudeGptModel = normalizeTriggerModel(options.triggerModels?.claudeGpt);
    this.triggerModels = {
      ...(geminiModel ? { gemini: geminiModel } : {}),
      ...(claudeGptModel ? { claudeGpt: claudeGptModel } : {}),
    };
    this.cwd = options.cwd;
    this.now = options.now ?? (() => new Date());
    this.spawnProcess = options.spawnProcess;
  }

  capabilities(): ProviderCapabilities {
    const supportedWindowKinds = Object.entries(TRIGGER_MODEL_GROUP_BY_WINDOW_KIND)
      .filter(([, group]) => this.triggerModels[group] !== undefined)
      .map(([windowKind]) => windowKind);
    const triggerSupported = this.triggerEnabled && supportedWindowKinds.length > 0;
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
        supported: triggerSupported,
        contract: triggerSupported ? 'observed_undocumented' : 'unknown',
        consumesQuota: true,
        ...(triggerSupported ? { supportedWindowKinds } : {}),
        notes: !this.triggerEnabled
          ? 'Quota-consuming prompt action is disabled by the injected trigger gate'
          : triggerSupported
            ? 'Official agy headless prompt mode; window-positioning effect is experimental and account/CLI-specific'
            : 'A trigger model must be configured for at least one Antigravity quota family',
      },
    };
  }

  async triggerWindow(
    ctx: ProviderContext,
    request: TriggerWindowRequest,
  ): Promise<ProviderActionResult> {
    let now: Date;
    try {
      now = this.now();
    } catch {
      return actionResult('rejected', 'AGY_INVALID_TIME', new Date(0));
    }
    const occurredAt = Number.isFinite(now.getTime()) ? now : new Date(0);
    if (!Number.isFinite(now.getTime())) {
      return actionResult('rejected', 'AGY_INVALID_TIME', occurredAt);
    }
    if (!this.triggerEnabled) {
      return actionResult('rejected', 'AGY_TRIGGER_DISABLED', occurredAt);
    }
    if (!TriggerWindowRequestSchema.safeParse(request).success) {
      return actionResult('rejected', 'AGY_TRIGGER_REQUEST_INVALID', occurredAt);
    }
    if (!request.windowKind) {
      return actionResult('rejected', 'AGY_TRIGGER_TARGET_REQUIRED', occurredAt);
    }
    if (!ctx.registerCleanupArtifact) {
      return actionResult('rejected', 'AGY_CLEANUP_REGISTRATION_REQUIRED', occurredAt);
    }

    const group = Object.hasOwn(TRIGGER_MODEL_GROUP_BY_WINDOW_KIND, request.windowKind)
      ? TRIGGER_MODEL_GROUP_BY_WINDOW_KIND[request.windowKind]
      : undefined;
    if (!group) return actionResult('rejected', 'AGY_TRIGGER_TARGET_UNSUPPORTED', occurredAt);
    const model = this.triggerModels[group];
    if (!model) return actionResult('rejected', 'AGY_TRIGGER_MODEL_UNAVAILABLE', occurredAt);

    try {
      const stdout = await runAntigravityTriggerCommand({
        executable: this.executable,
        model,
        timeoutMs: this.actionTimeoutSeconds * 1_000,
        registerCleanupArtifact: ctx.registerCleanupArtifact,
        cleanupUnregisteredConversation: (conversationId) =>
          deleteAntigravityConversation(this.antigravityHome, conversationId),
        ...(this.spawnProcess ? { spawnProcess: this.spawnProcess } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      let envelope: ReturnType<typeof parseAntigravityActionEnvelope>;
      try {
        envelope = parseAntigravityActionEnvelope(JSON.parse(stdout) as unknown);
      } catch {
        return actionResult('uncertain', 'AGY_TRIGGER_OUTPUT_INVALID', occurredAt);
      }

      if (envelope.status === 'SUCCESS' && envelope.num_turns === 1 && envelope.response?.trim()) {
        return actionResult('succeeded', undefined, occurredAt);
      }
      // The official CLI does not provide a trusted dispatch-boundary code.
      // Any structured error after spawn may follow prompt dispatch, so it is
      // deliberately uncertain and must never be retried blindly.
      return actionResult('uncertain', 'AGY_TRIGGER_OUTCOME_UNKNOWN', occurredAt);
    } catch (error) {
      if (error instanceof AntigravityActionTransportError) {
        if (error.code === 'CLEANUP_REGISTRATION_FAILED') {
          return actionResult('rejected', 'AGY_CLEANUP_REGISTRATION_FAILED', occurredAt);
        }
        return actionResult(
          error.disposition,
          error.code === 'STREAM_PROTOCOL_ERROR'
            ? 'AGY_TRIGGER_OUTPUT_INVALID'
            : error.code === 'PROCESS_START_FAILED'
              ? 'PROCESS_START_FAILED'
              : 'AGY_TRIGGER_OUTCOME_UNKNOWN',
          occurredAt,
        );
      }
      return actionResult('uncertain', 'AGY_TRIGGER_OUTCOME_UNKNOWN', occurredAt);
    }
  }

  async cleanupArtifact(ctx: ProviderContext, artifact: ProviderCleanupArtifact): Promise<void> {
    void ctx;
    if (artifact.kind !== 'antigravity_conversation') {
      throw new Error('Antigravity cleanup artifact kind is unsupported');
    }
    await deleteAntigravityConversation(this.antigravityHome, artifact.externalId);
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

function actionResult(
  status: ProviderActionResult['status'],
  errorCode: string | undefined,
  occurredAt: Date,
): ProviderActionResult {
  return ProviderActionResultSchema.parse({
    status,
    occurredAt: occurredAt.toISOString(),
    ...(errorCode ? { errorCode } : {}),
  }) as ProviderActionResult;
}
