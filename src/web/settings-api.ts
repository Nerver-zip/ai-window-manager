import { z } from 'zod';
import type { ActivationPolicy } from '../domain/types.js';
import { resolveWindowTarget } from '../domain/window-target.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { Clock } from '../scheduler/clock.js';
import {
  isValidTimeZone,
  parseActivationPolicy,
  type TimezoneSetting,
  validateToleranceAgainstDuration,
} from '../scheduler/policy.js';
import { resolveLocalOccurrence } from '../scheduler/time.js';
import type {
  ProviderMode,
  SchedulePolicyRecord,
  StorageRepositories,
} from '../storage/repositories.js';
import { isProviderVisible } from '../providers/visibility.js';

const ID = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

export const ProviderSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(['monitor_only', 'automation']).optional(),
    pollIntervalSeconds: z.number().int().min(30).max(86400),
  })
  .strict();

export const ScheduleSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    providerId: ID,
    windowKind: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    targetResetLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.string().refine(isValidTimeZone, 'timezone must be a valid IANA timezone'),
    toleranceSeconds: z.number().int().min(0).max(3600),
  })
  .strict();

const ActivationPolicyBaseSchema = z.object({
  enabled: z.boolean().default(true),
  providerId: ID,
  timezone: z.string().min(1).max(128).optional(),
});

export const ActivationPolicySettingsSchema = z.discriminatedUnion('kind', [
  ActivationPolicyBaseSchema.extend({
    kind: z.literal('manual'),
    windowKind: z.string().min(1).max(64).optional(),
  }),
  ActivationPolicyBaseSchema.extend({
    kind: z.literal('auto'),
    windowKind: z.string().min(1).max(64),
  }),
  ActivationPolicyBaseSchema.extend({
    kind: z.literal('fixed'),
    windowKind: z.string().min(1).max(64),
    anchorLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    toleranceSeconds: z.number().int().min(0).max(3_600),
  }),
  ActivationPolicyBaseSchema.extend({
    kind: z.literal('custom_schedule'),
    windowKind: z.string().min(1).max(64),
    times: z
      .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
      .min(1)
      .max(24),
    toleranceSeconds: z.number().int().min(0).max(3_600),
  }),
  ActivationPolicyBaseSchema.extend({
    kind: z.literal('active_hours'),
    windowKind: z.string().min(1).max(64),
    periods: z
      .array(
        z
          .object({
            start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
            end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          })
          .strict(),
      )
      .min(1)
      .max(24),
  }),
]);

export const TimezoneSettingsSchema = z
  .object({
    timezone: z.string().min(1).max(128).refine(isValidTimeZone),
    source: z.enum(['detected', 'manual']).default('manual'),
  })
  .strict();

export interface SettingsApiInput {
  repositories: StorageRepositories;
  adapters: ReadonlyMap<string, ProviderAdapter>;
  clock: Clock;
  fakeProviderEnabled?: boolean;
}

export type SettingsApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; statusCode: 400 | 404 | 409; code: string; message: string };

export interface ScheduleSettingsValue {
  enabled: boolean;
  providerId: string;
  windowKind: string;
  targetResetLocalTime: string;
  timezone: string;
  toleranceSeconds: number;
}

export interface ActivationPolicySettingsValue {
  policy: ActivationPolicy;
  timezone: TimezoneSetting;
}

export function readTimezoneSetting(
  input: Pick<SettingsApiInput, 'repositories'>,
): TimezoneSetting | undefined {
  const timezone = input.repositories.settings.get<string>('timezone')?.value;
  const source = input.repositories.settings.get<string>('timezone_source')?.value;
  if (typeof timezone !== 'string' || !isValidTimeZone(timezone)) return undefined;
  return {
    timezone,
    source: source === 'manual' ? 'manual' : 'detected',
  };
}

export function updateTimezoneSetting(
  input: SettingsApiInput,
  body: unknown,
): SettingsApiResult<{ timezone: TimezoneSetting }> {
  const parsed = TimezoneSettingsSchema.safeParse(body);
  if (!parsed.success)
    return failure(400, 'INVALID_TIMEZONE', 'timezone must be a valid IANA identifier');
  const existing = readTimezoneSetting(input);
  if (existing?.source === 'manual' && parsed.data.source === 'detected') {
    return { ok: true, value: { timezone: existing } };
  }
  const nowMs = input.clock.now().getTime();
  input.repositories.settings.set('timezone', parsed.data.timezone, nowMs);
  input.repositories.settings.set('timezone_source', parsed.data.source, nowMs);
  input.repositories.events.append({
    occurredAtMs: nowMs,
    providerId: null,
    type: 'timezone_updated',
    severity: 'info',
    reasonCode: 'TIMEZONE_UPDATED',
    data: { timezone: parsed.data.timezone, source: parsed.data.source },
  });
  return { ok: true, value: { timezone: parsed.data } };
}

export function updateActivationPolicy(
  input: SettingsApiInput,
  body: unknown,
): SettingsApiResult<ActivationPolicySettingsValue> {
  const parsed = ActivationPolicySettingsSchema.safeParse(body);
  if (!parsed.success) return failure(400, 'BAD_REQUEST', 'activation policy settings are invalid');
  if (!isProviderVisible(parsed.data.providerId, input.fakeProviderEnabled ?? true))
    return failure(404, 'NOT_FOUND', 'provider not found');
  const provider = input.repositories.providers.get(parsed.data.providerId);
  if (!provider) return failure(404, 'NOT_FOUND', 'provider not found');

  const existingTimezone = readTimezoneSetting(input);
  const existingPolicy = input.repositories.schedulePolicies
    .list(parsed.data.providerId)
    .find((candidate) => candidate.id === `activation-${parsed.data.providerId}`);
  const timezone = parsed.data.timezone ?? existingTimezone?.timezone ?? existingPolicy?.timezone;
  if (!timezone || !isValidTimeZone(timezone)) {
    return failure(400, 'TIMEZONE_REQUIRED', 'choose a valid time zone before saving this policy');
  }
  const timezoneChanged = Boolean(
    parsed.data.timezone &&
    (!existingTimezone || parsed.data.timezone !== existingTimezone.timezone),
  );

  const currentObservation = input.repositories.providerState.get(
    parsed.data.providerId,
  )?.observation;
  const requestedWindowKind = 'windowKind' in parsed.data ? parsed.data.windowKind : undefined;
  let windowKind: string | undefined;
  if (requestedWindowKind) {
    const target = resolveWindowTarget(requestedWindowKind, currentObservation?.windows ?? []);
    if (target.status === 'ambiguous') {
      return failure(
        400,
        'AMBIGUOUS_WINDOW_TARGET',
        'choose a quota group because this saved window target matches multiple provider windows',
      );
    }
    if (target.status === 'missing') {
      return failure(
        400,
        'WINDOW_TARGET_NOT_REPORTED',
        'choose a usage window reported by the provider before saving this policy',
      );
    }
    windowKind = target.windowKind;
  }
  if (
    !windowKind &&
    (parsed.data.kind !== 'manual' || (currentObservation?.windows.length ?? 0) > 0)
  ) {
    return failure(
      400,
      'WINDOW_TARGET_REQUIRED',
      'choose one exact reported usage window before saving this policy',
    );
  }
  const selectedWindow = currentObservation?.windows.find(
    (window) => window.windowKind === windowKind,
  );
  if ('toleranceSeconds' in parsed.data) {
    try {
      validateToleranceAgainstDuration(
        parsed.data.toleranceSeconds,
        selectedWindow?.durationSeconds?.value,
      );
    } catch (error) {
      return failure(
        400,
        'INVALID_TOLERANCE',
        error instanceof Error ? error.message : 'tolerance is invalid',
      );
    }
  }

  const nowMs = input.clock.now().getTime();
  const policyId = `activation-${parsed.data.providerId}`;
  const previous = input.repositories.schedulePolicies.get(policyId);
  const config: Record<string, unknown> = {};
  if (windowKind) config.windowKind = windowKind;
  if (parsed.data.kind === 'fixed') {
    config.anchorLocalTime = parsed.data.anchorLocalTime;
    config.toleranceSeconds = parsed.data.toleranceSeconds;
  } else if (parsed.data.kind === 'custom_schedule') {
    config.times = parsed.data.times;
    config.toleranceSeconds = parsed.data.toleranceSeconds;
  } else if (parsed.data.kind === 'active_hours') {
    config.periods = parsed.data.periods;
  }
  const record = {
    id: policyId,
    providerId: parsed.data.providerId,
    kind: parsed.data.kind,
    kindExplicit: true,
    enabled: parsed.data.enabled,
    timezone,
    config,
    createdAtMs: previous?.createdAtMs ?? nowMs,
    updatedAtMs: nowMs,
  };
  let policy: ActivationPolicy;
  try {
    policy = parseActivationPolicy({
      id: record.id,
      providerId: record.providerId,
      kind: record.kind,
      enabled: record.enabled,
      timezone: record.timezone,
      updatedAtMs: record.updatedAtMs,
      ...config,
    });
  } catch (error) {
    return failure(
      400,
      'INVALID_POLICY',
      error instanceof Error ? error.message : 'activation policy is invalid',
    );
  }
  if (timezoneChanged) {
    const timezoneResult = updateTimezoneSetting(input, {
      timezone: parsed.data.timezone,
      source: 'manual',
    });
    if (!timezoneResult.ok)
      return failure(timezoneResult.statusCode, timezoneResult.code, timezoneResult.message);
  }
  input.repositories.schedulePolicies.upsert(record);
  input.repositories.events.append({
    occurredAtMs: nowMs,
    providerId: policy.providerId,
    type: 'schedule_policy_updated',
    severity: 'info',
    reasonCode: 'SCHEDULE_POLICY_UPDATED',
    data: { policyId, policyKind: policy.kind, enabled: policy.enabled, timezone },
  });
  return {
    ok: true,
    value: {
      policy,
      timezone: {
        timezone,
        source: timezoneChanged ? 'manual' : (existingTimezone?.source ?? 'detected'),
      },
    },
  };
}

export function updateProviderSettings(
  input: SettingsApiInput,
  providerId: unknown,
  body: unknown,
): SettingsApiResult<{ providerId: string; mode: ProviderMode }> {
  if (typeof providerId !== 'string' || !ID.safeParse(providerId).success) {
    return failure(400, 'BAD_REQUEST', 'provider id is invalid');
  }
  if (!isProviderVisible(providerId, input.fakeProviderEnabled ?? true))
    return failure(404, 'NOT_FOUND', 'provider not found');
  const provider = input.repositories.providers.get(providerId);
  if (!provider) return failure(404, 'NOT_FOUND', 'provider not found');

  const parsed = ProviderSettingsSchema.safeParse(body);
  if (!parsed.success) return failure(400, 'BAD_REQUEST', 'provider settings are invalid');
  const mode = parsed.data.mode ?? provider.mode;
  if (mode === 'automation') {
    const adapter = input.adapters.get(providerId);
    if (!adapter) return failure(409, 'PROVIDER_UNAVAILABLE', 'provider adapter is unavailable');
    try {
      const capabilities = adapter.capabilities();
      if (!capabilities.windowTrigger.supported) {
        return failure(409, 'ACTION_CAPABILITY_UNAVAILABLE', 'provider trigger is unavailable');
      }
    } catch {
      return failure(409, 'ACTION_CAPABILITY_UNAVAILABLE', 'provider capabilities are unavailable');
    }
  }

  const nowMs = input.clock.now().getTime();
  input.repositories.providers.upsert({
    ...provider,
    enabled: parsed.data.enabled,
    mode,
    modeExplicit: parsed.data.mode === undefined ? (provider.modeExplicit ?? false) : true,
    pollIntervalSeconds: parsed.data.pollIntervalSeconds,
    updatedAtMs: nowMs,
  });
  input.repositories.events.append({
    occurredAtMs: nowMs,
    providerId,
    type: 'provider_settings_updated',
    severity: 'info',
    reasonCode: 'PROVIDER_SETTINGS_UPDATED',
    data: {
      enabled: parsed.data.enabled,
      mode,
      pollIntervalSeconds: parsed.data.pollIntervalSeconds,
    },
  });
  return { ok: true, value: { providerId, mode } };
}

export function updateScheduleSettings(
  input: SettingsApiInput,
  body: unknown,
): SettingsApiResult<{ policy: SchedulePolicyRecord; preview: SchedulePreview }> {
  const parsed = ScheduleSettingsSchema.safeParse(body);
  if (!parsed.success) return failure(400, 'BAD_REQUEST', 'schedule settings are invalid');
  if (!isProviderVisible(parsed.data.providerId, input.fakeProviderEnabled ?? true))
    return failure(404, 'NOT_FOUND', 'provider not found');
  const provider = input.repositories.providers.get(parsed.data.providerId);
  if (!provider) return failure(404, 'NOT_FOUND', 'provider not found');

  let preview: SchedulePreview;
  try {
    const resolved = resolveLocalOccurrence({
      localTime: parsed.data.targetResetLocalTime,
      timeZone: parsed.data.timezone,
      referenceInstant: input.clock.now(),
    });
    preview = {
      instant: resolved.instant.toISOString(),
      localDate: resolved.localDate,
      resolvedLocalTime: resolved.resolvedLocalTime,
      resolution: resolved.resolution,
      wasAdjusted: resolved.wasAdjusted,
      wasAmbiguous: resolved.wasAmbiguous,
    };
  } catch {
    return failure(400, 'INVALID_SCHEDULE_TIME', 'schedule time cannot be resolved');
  }

  const nowMs = input.clock.now().getTime();
  const policyId = `target-reset-${parsed.data.providerId}-${parsed.data.windowKind}`;
  const previous = input.repositories.schedulePolicies.get(policyId);
  const policy: SchedulePolicyRecord = {
    id: policyId,
    providerId: parsed.data.providerId,
    kind: 'target_reset',
    kindExplicit: previous?.kindExplicit ?? false,
    enabled: parsed.data.enabled,
    timezone: parsed.data.timezone,
    config: {
      windowKind: parsed.data.windowKind,
      targetResetLocalTime: parsed.data.targetResetLocalTime,
      toleranceSeconds: parsed.data.toleranceSeconds,
    },
    createdAtMs: previous?.createdAtMs ?? nowMs,
    updatedAtMs: nowMs,
  };
  input.repositories.schedulePolicies.upsert(policy);
  input.repositories.events.append({
    occurredAtMs: nowMs,
    providerId: policy.providerId,
    type: 'schedule_policy_updated',
    severity: 'info',
    reasonCode: 'SCHEDULE_POLICY_UPDATED',
    data: {
      policyId: policy.id,
      enabled: policy.enabled,
      timezone: policy.timezone,
      windowKind: parsed.data.windowKind,
    },
  });
  return { ok: true, value: { policy, preview } };
}

export interface SchedulePreview {
  instant: string;
  localDate: string;
  resolvedLocalTime: string;
  resolution: string;
  wasAdjusted: boolean;
  wasAmbiguous: boolean;
}

function failure(
  statusCode: 400 | 404 | 409,
  code: string,
  message: string,
): SettingsApiResult<never> {
  return { ok: false, statusCode, code, message };
}
