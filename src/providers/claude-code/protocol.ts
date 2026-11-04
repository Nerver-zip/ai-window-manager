import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Claude Code CLI protocol boundary.
 *
 * Everything here parses untrusted official-client output. Conversation
 * content (assistant text, local-command text, result text, prompts) is never
 * returned to callers; only allowlisted, bounded metadata is.
 */

const MAX_METER_ROWS = 64;
const MAX_LABEL_LENGTH = 128;

/** `claude auth status --json`; only the fields AWM needs are interpreted. */
const ClaudeAuthStatusSchema = z
  .object({
    loggedIn: z.boolean(),
    authMethod: z.string().max(64).optional(),
    apiProvider: z.string().max(64).optional(),
    email: z.string().max(320).nullable().optional(),
    orgId: z.string().max(128).nullable().optional(),
    subscriptionType: z.string().max(64).nullable().optional(),
  })
  .passthrough();

export type ClaudeAuthState =
  | { state: 'authenticated'; accountFingerprint: string; subscriptionType: string | null }
  | { state: 'unsupported_auth' }
  | { state: 'unauthenticated' }
  | { state: 'unknown' };

/**
 * Interpret the official auth status. Only first-party Claude.ai subscription
 * logins carry subscription usage windows; API-key, gateway and cloud-provider
 * sessions are reported as unsupported rather than silently used.
 */
export function parseClaudeAuthStatus(exitCode: number | null, stdout: string): ClaudeAuthState {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return { state: 'unknown' };
  }
  const parsed = ClaudeAuthStatusSchema.safeParse(value);
  if (!parsed.success) return { state: 'unknown' };
  const status = parsed.data;
  if (!status.loggedIn) {
    return exitCode === 1 ? { state: 'unauthenticated' } : { state: 'unknown' };
  }
  if (exitCode !== 0) return { state: 'unknown' };
  if (
    status.authMethod !== 'claude.ai' ||
    (status.apiProvider !== undefined && status.apiProvider !== 'firstParty')
  ) {
    return { state: 'unsupported_auth' };
  }
  const accountFingerprint = accountFingerprintFromAuthStatus(status.email, status.orgId);
  if (!accountFingerprint) return { state: 'unknown' };
  const subscriptionType = status.subscriptionType;
  return {
    state: 'authenticated',
    accountFingerprint,
    subscriptionType:
      typeof subscriptionType === 'string' && /^[a-z0-9_-]{1,32}$/i.test(subscriptionType)
        ? subscriptionType.toLowerCase()
        : null,
  };
}

/**
 * Domain-separated, truncated one-way digest of the signed-in identity. It lets
 * AWM notice an account switch between reads without storing email/org values.
 */
export function accountFingerprintFromAuthStatus(
  email: string | null | undefined,
  orgId: string | null | undefined,
): string | undefined {
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const normalizedOrg = typeof orgId === 'string' ? orgId.trim().toLowerCase() : '';
  if (normalizedEmail.length === 0 || normalizedOrg.length === 0) return undefined;
  return createHash('sha256')
    .update(`awm-claude-code-account:v1\n${normalizedEmail}\n${normalizedOrg}`)
    .digest('hex')
    .slice(0, 32);
}

const MeterRowSchema = z
  .object({
    kind: z.string().min(1).max(MAX_LABEL_LENGTH),
    group: z.string().max(MAX_LABEL_LENGTH),
    percent: z.number().finite(),
    resets_at: z.string().max(MAX_LABEL_LENGTH).nullable(),
    scope: z
      .object({
        model: z
          .object({ display_name: z.string().max(MAX_LABEL_LENGTH) })
          .passthrough()
          .nullable()
          .optional(),
        surface: z
          .object({ display_name: z.string().max(MAX_LABEL_LENGTH) })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    severity: z.string().max(MAX_LABEL_LENGTH).optional(),
    is_active: z.boolean().optional(),
  })
  .passthrough();

const UsageReportSchema = z
  .object({
    rate_limits: z
      .object({
        limits: z.array(z.unknown()).max(MAX_METER_ROWS).nullable(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

/** One validated server meter row from the experimental `/usage` structured report. */
export interface ClaudeUsageMeter {
  kind: string;
  group: string;
  /** Share of the window used, 0-100 (values above 100 are clamped by the adapter). */
  percent: number;
  /** UTC instant, or null when the server reports no reset for this meter. */
  resetsAt: string | null;
  scopeLabel: string | null;
}

export type ClaudeUsageReport =
  | { status: 'meters'; meters: ClaudeUsageMeter[] }
  /** The client could not fetch usage (non-subscriber lane, auth or endpoint failure). */
  | { status: 'unavailable' };

export class ClaudeOutputError extends Error {
  constructor(readonly code: 'OUTPUT_INVALID' | 'SCHEMA_CHANGED') {
    super(`Claude Code output ${code.toLowerCase().replaceAll('_', ' ')}`);
    this.name = 'ClaudeOutputError';
  }
}

function parseResetInstant(value: string | null): string | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ClaudeOutputError('SCHEMA_CHANGED');
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ClaudeOutputError('SCHEMA_CHANGED');
  return new Date(parsed).toISOString();
}

/** Validate the `usage_report` sibling carried by the `/usage` local-command message. */
export function parseUsageReport(value: unknown): ClaudeUsageReport {
  const parsed = UsageReportSchema.safeParse(value);
  if (!parsed.success) throw new ClaudeOutputError('SCHEMA_CHANGED');
  const rows = parsed.data.rate_limits?.limits;
  if (rows === null || rows === undefined) return { status: 'unavailable' };

  const meters: ClaudeUsageMeter[] = [];
  for (const raw of rows) {
    const row = MeterRowSchema.safeParse(raw);
    if (!row.success) throw new ClaudeOutputError('SCHEMA_CHANGED');
    if (row.data.percent < 0 || row.data.percent > 1_000) {
      throw new ClaudeOutputError('SCHEMA_CHANGED');
    }
    const scopeLabel =
      row.data.scope?.model?.display_name ?? row.data.scope?.surface?.display_name ?? null;
    meters.push({
      kind: row.data.kind,
      group: row.data.group,
      percent: row.data.percent,
      resetsAt: parseResetInstant(row.data.resets_at),
      scopeLabel: scopeLabel && scopeLabel.trim().length > 0 ? scopeLabel.trim() : null,
    });
  }
  return { status: 'meters', meters };
}

const InitEventSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    tools: z.array(z.unknown()).max(1_024),
    mcp_servers: z.array(z.unknown()).max(1_024),
    model: z.string().min(1).max(MAX_LABEL_LENGTH),
    apiKeySource: z.string().max(64),
  })
  .passthrough();

const AssistantEventSchema = z
  .object({
    type: z.literal('assistant'),
    error: z.string().max(MAX_LABEL_LENGTH).optional(),
    is_api_error_message: z.boolean().optional(),
    local_command_run: z
      .object({ command: z.string().max(MAX_LABEL_LENGTH) })
      .passthrough()
      .optional(),
    usage_report: z.unknown().optional(),
  })
  .passthrough();

const ResultEventSchema = z
  .object({
    type: z.literal('result'),
    subtype: z.string().max(64),
    is_error: z.boolean(),
    num_turns: z.number().finite().int().nonnegative().optional(),
    duration_api_ms: z.number().finite().nonnegative().optional(),
    local_command: z.string().max(MAX_LABEL_LENGTH).nullable().optional(),
  })
  .passthrough();

export type ClaudeStreamEvent =
  | {
      kind: 'init';
      model: string;
      toolCount: number;
      mcpServerCount: number;
      apiKeySource: string;
    }
  | {
      kind: 'assistant';
      error: string | null;
      apiErrorMessage: boolean;
      localCommand: string | null;
      hasUsageReport: boolean;
      usageReport: unknown;
    }
  | {
      kind: 'result';
      isError: boolean;
      subtype: string;
      numTurns: number | null;
      apiDurationMs: number | null;
      localCommand: string | null;
    }
  | { kind: 'other' };

/**
 * Parse one stream-json line. Throws on malformed JSON or on a recognized event
 * whose envelope no longer matches the validated contract.
 */
export function parseStreamEvent(line: string): ClaudeStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ClaudeOutputError('OUTPUT_INVALID');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ClaudeOutputError('OUTPUT_INVALID');
  }
  const type = (value as { type?: unknown }).type;
  if (type === 'system' && (value as { subtype?: unknown }).subtype === 'init') {
    const init = InitEventSchema.safeParse(value);
    if (!init.success) throw new ClaudeOutputError('SCHEMA_CHANGED');
    return {
      kind: 'init',
      model: init.data.model,
      toolCount: init.data.tools.length,
      mcpServerCount: init.data.mcp_servers.length,
      apiKeySource: init.data.apiKeySource,
    };
  }
  if (type === 'assistant') {
    const event = AssistantEventSchema.safeParse(value);
    if (!event.success) throw new ClaudeOutputError('SCHEMA_CHANGED');
    return {
      kind: 'assistant',
      error: event.data.error ?? null,
      apiErrorMessage: event.data.is_api_error_message === true,
      localCommand: event.data.local_command_run?.command ?? null,
      hasUsageReport: event.data.usage_report !== undefined && event.data.usage_report !== null,
      usageReport: event.data.usage_report,
    };
  }
  if (type === 'result') {
    const event = ResultEventSchema.safeParse(value);
    if (!event.success) throw new ClaudeOutputError('SCHEMA_CHANGED');
    return {
      kind: 'result',
      isError: event.data.is_error,
      subtype: event.data.subtype,
      numTurns: event.data.num_turns ?? null,
      apiDurationMs: event.data.duration_api_ms ?? null,
      localCommand: event.data.local_command ?? null,
    };
  }
  return { kind: 'other' };
}
