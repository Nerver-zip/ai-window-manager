import { z } from 'zod';
import type { ProviderAdapter } from '../providers/provider.js';
import type { Clock } from '../scheduler/clock.js';
import { resolveLocalOccurrence } from '../scheduler/time.js';
import type {
  ProviderMode,
  SchedulePolicyRecord,
  StorageRepositories,
} from '../storage/repositories.js';

const ID = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

export const ProviderSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(['monitor_only', 'automation']).default('monitor_only'),
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

export interface SettingsApiInput {
  repositories: StorageRepositories;
  adapters: ReadonlyMap<string, ProviderAdapter>;
  clock: Clock;
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

export function updateProviderSettings(
  input: SettingsApiInput,
  providerId: unknown,
  body: unknown,
): SettingsApiResult<{ providerId: string; mode: ProviderMode }> {
  if (typeof providerId !== 'string' || !ID.safeParse(providerId).success) {
    return failure(400, 'BAD_REQUEST', 'provider id is invalid');
  }
  const provider = input.repositories.providers.get(providerId);
  if (!provider) return failure(404, 'NOT_FOUND', 'provider not found');

  const parsed = ProviderSettingsSchema.safeParse(body);
  if (!parsed.success) return failure(400, 'BAD_REQUEST', 'provider settings are invalid');
  if (parsed.data.mode === 'automation') {
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
    mode: parsed.data.mode,
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
      mode: parsed.data.mode,
      pollIntervalSeconds: parsed.data.pollIntervalSeconds,
    },
  });
  return { ok: true, value: { providerId, mode: parsed.data.mode } };
}

export function updateScheduleSettings(
  input: SettingsApiInput,
  body: unknown,
): SettingsApiResult<{ policy: SchedulePolicyRecord; preview: SchedulePreview }> {
  const parsed = ScheduleSettingsSchema.safeParse(body);
  if (!parsed.success) return failure(400, 'BAD_REQUEST', 'schedule settings are invalid');
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

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
