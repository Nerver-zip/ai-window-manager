import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * OpenCode CLI protocol boundary.
 *
 * Everything here parses untrusted official-client output. Conversation
 * content (assistant text, reasoning, tool input/output, prompts) is never
 * returned to callers; only allowlisted, bounded metadata is.
 */

const MAX_LABEL_LENGTH = 128;
/** OpenCode session IDs are `ses_` plus 26 alphanumerics (12 hex + 14 base62). */
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export class OpenCodeOutputError extends Error {
  constructor(readonly code: 'OUTPUT_INVALID' | 'SCHEMA_CHANGED') {
    super(`OpenCode output ${code.toLowerCase().replaceAll('_', ' ')}`);
    this.name = 'OpenCodeOutputError';
  }
}

export function isOpenCodeSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

/**
 * AWM chooses the exact session ID so that it can persist the cleanup
 * obligation before the prompt is dispatched (`opencode run --session <id>`
 * creates the session when it does not exist).
 */
export function generateOpenCodeSessionId(random: (size: number) => Buffer = randomBytes): string {
  const hex = random(6).toString('hex');
  let suffix = '';
  // Rejection sampling keeps the base62 characters unbiased.
  while (suffix.length < 14) {
    for (const byte of random(32)) {
      if (byte < 248 && suffix.length < 14) suffix += BASE62[byte % 62];
    }
  }
  return `ses_${hex}${suffix}`;
}

const MeterSchema = z
  .object({
    percent: z.number().finite().min(0).max(100),
    limited: z.boolean(),
    resetsAt: z.number().finite().int().positive(),
  })
  .passthrough();

const UsageEnvelopeSchema = z
  .object({
    data: z
      .object({
        workspace: z.object({ id: z.string().min(1).max(MAX_LABEL_LENGTH) }).passthrough(),
        go: z
          .object({ rolling: MeterSchema, weekly: MeterSchema, monthly: MeterSchema })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

export type OpenCodeMeterKind = 'rolling' | 'weekly' | 'monthly';

export interface OpenCodeUsageMeter {
  kind: OpenCodeMeterKind;
  /** Share of the window's allowance used, 0-100. */
  percent: number;
  /** The server refuses requests until this window resets. */
  limited: boolean;
  /** UTC instant of the reset. */
  resetsAt: string;
}

export type OpenCodeUsageReport =
  /** Not signed in to an OpenCode Console workspace (a bare provider key has none). */
  | { status: 'signed_out' }
  /** Signed in, but the workspace has no Go subscription for this member. */
  | { status: 'no_go' }
  | { status: 'meters'; meters: OpenCodeUsageMeter[] };

/**
 * Validate `GET /api/experimental/usage/limits` as relayed by `opencode api`.
 * Only the Go meters are read; Console budgets and workspace names are ignored.
 */
export function parseUsageEnvelope(stdout: string): OpenCodeUsageReport {
  // A server without this experimental route answers with its web app (HTML,
  // exit 0). That is a contract change, not malformed data.
  if (stdout.trimStart().startsWith('<')) throw new OpenCodeOutputError('SCHEMA_CHANGED');
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new OpenCodeOutputError('OUTPUT_INVALID');
  }
  const parsed = UsageEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new OpenCodeOutputError('SCHEMA_CHANGED');
  const data = parsed.data.data;
  if (data === null) return { status: 'signed_out' };
  if (data.go === undefined) return { status: 'no_go' };
  const meters: OpenCodeUsageMeter[] = [];
  for (const kind of ['rolling', 'weekly', 'monthly'] as const) {
    const meter = data.go[kind];
    const resetMs = meter.resetsAt;
    const resetsAt = new Date(resetMs);
    if (!Number.isFinite(resetsAt.getTime())) throw new OpenCodeOutputError('SCHEMA_CHANGED');
    meters.push({
      kind,
      percent: meter.percent,
      limited: meter.limited,
      resetsAt: resetsAt.toISOString(),
    });
  }
  return { status: 'meters', meters };
}

const RunEventSchema = z
  .object({
    type: z.string().min(1).max(MAX_LABEL_LENGTH),
    sessionID: z.string().max(MAX_LABEL_LENGTH).optional(),
    error: z
      .object({ type: z.string().max(MAX_LABEL_LENGTH) })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type OpenCodeRunEvent = { sessionId: string | null } & (
  | { kind: 'step_start' }
  | { kind: 'step_finish' }
  /** `errorType` is the provider-reported class only; the message text is dropped. */
  | { kind: 'error'; errorType: string }
  | { kind: 'retry' }
  | { kind: 'other' }
);

/** Parse one `opencode run --format json` line without keeping conversation text. */
export function parseRunEvent(line: string): OpenCodeRunEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new OpenCodeOutputError('OUTPUT_INVALID');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OpenCodeOutputError('OUTPUT_INVALID');
  }
  const event = RunEventSchema.safeParse(value);
  if (!event.success) throw new OpenCodeOutputError('SCHEMA_CHANGED');
  const sessionId = event.data.sessionID ?? null;
  switch (event.data.type) {
    case 'step_start':
      return { kind: 'step_start', sessionId };
    case 'step_finish':
      return { kind: 'step_finish', sessionId };
    case 'retry':
      return { kind: 'retry', sessionId };
    case 'error':
      return { kind: 'error', errorType: event.data.error?.type ?? 'unknown', sessionId };
    default:
      return { kind: 'other', sessionId };
  }
}
