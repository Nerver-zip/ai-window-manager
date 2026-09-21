import { z } from 'zod';
import type { ActivationPolicy, ActivationPolicyKind, ActiveHoursPeriod } from '../domain/types.js';

export const MIN_TOLERANCE_SECONDS = 0;
export const MAX_TOLERANCE_SECONDS = 3_600;
export const MIN_ACTIVE_HOURS_COVERAGE_SECONDS = 3_600;
export const TIMEZONE_SETTING_KEY = 'timezone';
export const TIMEZONE_SOURCE_SETTING_KEY = 'timezone_source';

const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const ToleranceSchema = z.number().int().min(MIN_TOLERANCE_SECONDS).max(MAX_TOLERANCE_SECONDS);
const TimezoneSchema = z.string().min(1).max(128).refine(isValidTimeZone);
const BaseSchema = z.object({
  id: z.string().min(1).max(64),
  providerId: z.string().min(1).max(64),
  enabled: z.boolean(),
  timezone: TimezoneSchema,
  updatedAtMs: z.number().int().nonnegative(),
});

export const ActivationPolicySchema = z.discriminatedUnion('kind', [
  BaseSchema.extend({ kind: z.literal('manual') }),
  BaseSchema.extend({
    kind: z.literal('auto'),
    windowKind: z.string().min(1).max(64).optional(),
  }),
  BaseSchema.extend({
    kind: z.literal('fixed'),
    windowKind: z.string().min(1).max(64),
    anchorLocalTime: LocalTimeSchema,
    toleranceSeconds: ToleranceSchema,
  }),
  BaseSchema.extend({
    kind: z.literal('custom_schedule'),
    windowKind: z.string().min(1).max(64),
    times: z.array(LocalTimeSchema).min(1).max(24),
    toleranceSeconds: ToleranceSchema,
  }),
  BaseSchema.extend({
    kind: z.literal('active_hours'),
    windowKind: z.string().min(1).max(64),
    periods: z
      .array(z.object({ start: LocalTimeSchema, end: LocalTimeSchema }).strict())
      .min(1)
      .max(24),
  }),
]);

export interface SchedulePolicyLike {
  id: string;
  providerId: string;
  kind: string;
  enabled: boolean;
  timezone: string;
  config: unknown;
  updatedAtMs: number;
}

export interface TimezoneSetting {
  timezone: string;
  source: 'detected' | 'manual';
}

export function parseActivationPolicy(value: unknown): ActivationPolicy {
  const parsed = ActivationPolicySchema.parse(value);
  validatePolicySemantics(parsed);
  return parsed;
}

export function safeParseActivationPolicy(value: unknown) {
  const parsed = ActivationPolicySchema.safeParse(value);
  if (!parsed.success) return parsed;
  try {
    validatePolicySemantics(parsed.data);
    return parsed;
  } catch (error) {
    return {
      success: false as const,
      error: new z.ZodError([
        {
          code: 'custom',
          path: [],
          message: String(error instanceof Error ? error.message : error),
        },
      ]),
    };
  }
}

export function activationPolicyFromRecord(
  record: SchedulePolicyLike,
  timezone = record.timezone,
): ActivationPolicy | undefined {
  const config = asRecord(record.config);
  const base = {
    id: record.id,
    providerId: record.providerId,
    enabled: record.enabled,
    timezone,
    updatedAtMs: record.updatedAtMs,
  };

  if (record.kind === 'manual') {
    return parseActivationPolicy({ ...base, kind: 'manual' });
  }

  if (record.kind === 'auto') {
    const windowKind = stringValue(config.windowKind);
    const value: {
      id: string;
      providerId: string;
      enabled: boolean;
      timezone: string;
      updatedAtMs: number;
      kind: 'auto';
      windowKind?: string;
    } = { ...base, kind: 'auto' };
    if (windowKind) value.windowKind = windowKind;
    return parseActivationPolicy(value);
  }

  if (record.kind === 'fixed' || record.kind === 'target_reset') {
    const anchorLocalTime = stringValue(
      config.anchorLocalTime ?? config.targetResetLocalTime ?? config.target,
    );
    const toleranceSeconds = numberValue(config.toleranceSeconds) ?? 30;
    if (!anchorLocalTime) return undefined;
    return parseActivationPolicy({
      ...base,
      kind: 'fixed',
      windowKind: stringValue(config.windowKind) ?? 'five_hour',
      anchorLocalTime,
      toleranceSeconds,
    });
  }

  if (record.kind === 'custom_schedule') {
    const times = Array.isArray(config.times)
      ? config.times.filter((value): value is string => typeof value === 'string')
      : [];
    return parseActivationPolicy({
      ...base,
      kind: 'custom_schedule',
      windowKind: stringValue(config.windowKind) ?? 'five_hour',
      times,
      toleranceSeconds: numberValue(config.toleranceSeconds) ?? 30,
    });
  }

  if (record.kind === 'active_hours' || record.kind === 'work_window') {
    const periods = Array.isArray(config.periods)
      ? config.periods.flatMap((value) => {
          if (
            !isRecord(value) ||
            typeof value.start !== 'string' ||
            typeof value.end !== 'string'
          ) {
            return [];
          }
          return [{ start: value.start, end: value.end }];
        })
      : [];
    if (periods.length === 0) return undefined;
    return parseActivationPolicy({
      ...base,
      kind: 'active_hours',
      windowKind: stringValue(config.windowKind) ?? 'five_hour',
      periods,
    });
  }

  return undefined;
}

export function validatePolicySemantics(policy: ActivationPolicy): void {
  if (policy.kind === 'custom_schedule') {
    if (new Set(policy.times).size !== policy.times.length) {
      throw new RangeError('custom schedule times must be unique');
    }
  }
  if (policy.kind === 'active_hours') validatePeriods(policy.periods);
}

export function validateToleranceAgainstDuration(
  toleranceSeconds: number,
  durationSeconds: number | undefined,
): void {
  if (!Number.isInteger(toleranceSeconds)) throw new RangeError('tolerance must be an integer');
  if (toleranceSeconds < MIN_TOLERANCE_SECONDS || toleranceSeconds > MAX_TOLERANCE_SECONDS) {
    throw new RangeError('tolerance is outside the supported range');
  }
  if (durationSeconds !== undefined && toleranceSeconds * 2 >= durationSeconds) {
    throw new RangeError('tolerance must leave neighboring anchors unambiguous');
  }
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function localTimeMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new RangeError('local time must use HH:mm');
  return Number(match[1]) * 60 + Number(match[2]);
}

export function sortLocalTimes(times: readonly string[]): string[] {
  return [...times].sort((left, right) => localTimeMinutes(left) - localTimeMinutes(right));
}

function validatePeriods(periods: readonly ActiveHoursPeriod[]): void {
  const segments: Array<{ start: number; end: number }> = [];
  for (const period of periods) {
    const start = localTimeMinutes(period.start);
    const end = localTimeMinutes(period.end);
    if (start === end) throw new RangeError('active-hour periods cannot be empty');
    if (start < end) segments.push({ start, end });
    else segments.push({ start, end: 24 * 60 }, { start: 0, end });
  }
  segments.sort((left, right) => left.start - right.start);
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (previous && current && current.start < previous.end) {
      throw new RangeError('active-hour periods cannot overlap');
    }
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type { ActivationPolicyKind };
