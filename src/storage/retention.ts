import type { Clock } from '../scheduler/clock.js';
import type { SqliteDatabase } from './database.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Event classes used by retention. Unknown event types are ordinary by default;
 * callers must opt an event into a longer retention period through its stable
 * lifecycle, action, or security naming convention.
 */
export type EventRetentionClass = 'ordinary' | 'lifecycle' | 'action' | 'security';

/**
 * Retention periods are absolute durations in milliseconds. They are evaluated
 * against the injected UTC instant and never against local calendar time.
 *
 * The defaults are the documented MVP policy: samples and ordinary events stay
 * for 90 days; lifecycle/action/security history and terminal intents stay for
 * 365 days. Current state, settings, and schedule policies have no TTL.
 */
export interface RetentionPolicy {
  windowSamplesMs: number;
  usageIntervalsMs: number;
  ordinaryEventsMs: number;
  lifecycleEventsMs: number;
  actionEventsMs: number;
  securityEventsMs: number;
  terminalActionIntentsMs: number;
}

export const DEFAULT_RETENTION_POLICY: Readonly<RetentionPolicy> = {
  windowSamplesMs: 90 * DAY_MS,
  usageIntervalsMs: 400 * DAY_MS,
  ordinaryEventsMs: 90 * DAY_MS,
  lifecycleEventsMs: 365 * DAY_MS,
  actionEventsMs: 365 * DAY_MS,
  securityEventsMs: 365 * DAY_MS,
  terminalActionIntentsMs: 365 * DAY_MS,
};

export interface RetentionMaintenanceOptions {
  clock: Pick<Clock, 'now'>;
  policy?: Partial<RetentionPolicy>;
  /** Maximum rows removed from each table/retention class in one run. */
  batchSize?: number;
}

export interface RetentionMaintenanceResult {
  asOfMs: number;
  windowSamplesDeleted: number;
  usageIntervalsDeleted: number;
  eventsDeleted: Record<EventRetentionClass, number>;
  terminalActionIntentsDeleted: number;
  totalDeleted: number;
}

const TERMINAL_INTENT_STATES = [
  'confirmed',
  'skipped',
  'canceled',
  'failed_terminal',
  'resolved_unknown',
] as const;

/**
 * Classify an event using the same bounded naming contract as the SQL cleanup.
 * The order is intentional: auth failures are security history even though
 * provider-auth events also have a `provider_` prefix.
 */
export function classifyEventType(type: string): EventRetentionClass {
  const normalized = type.trim().toLowerCase();
  if (
    normalized.startsWith('security_') ||
    normalized.startsWith('auth_') ||
    normalized.startsWith('csrf_') ||
    normalized.startsWith('origin_') ||
    normalized === 'provider_auth_required'
  ) {
    return 'security';
  }
  if (normalized.startsWith('action_') || normalized.startsWith('manual_trigger_')) {
    return 'action';
  }
  if (
    normalized.startsWith('provider_') ||
    normalized.startsWith('scheduler_') ||
    normalized.startsWith('schedule_') ||
    normalized.startsWith('config_') ||
    normalized.startsWith('setting_') ||
    normalized.startsWith('policy_') ||
    normalized === 'inspection_failed' ||
    normalized === 'inspect_requested' ||
    normalized === 'reconcile_started' ||
    normalized === 'reconcile_finished'
  ) {
    return 'lifecycle';
  }
  return 'ordinary';
}

/**
 * Delete one bounded batch of retention-eligible rows. Re-running maintenance
 * resumes from the remaining oldest rows instead of holding a large delete.
 */
export function runRetentionMaintenance(
  db: SqliteDatabase,
  options: RetentionMaintenanceOptions,
): RetentionMaintenanceResult {
  const asOfMs = options.clock.now().getTime();
  if (!Number.isSafeInteger(asOfMs)) {
    throw new RangeError('retention clock must return a valid instant');
  }

  const policy = resolvePolicy(options.policy);
  const batchSize = validateNonNegativeInteger(options.batchSize ?? 500, 'batchSize');

  const execute = db.transaction(() => {
    const windowSamplesDeleted = deleteBatch(
      db,
      'window_samples',
      'observed_at_ms',
      asOfMs - policy.windowSamplesMs,
      `id <= COALESCE((SELECT last_sample_id FROM usage_aggregation_checkpoint WHERE id = 1), 0)`,
      batchSize,
    );
    const usageIntervalsDeleted = deleteBatch(
      db,
      'usage_intervals',
      'to_ms',
      asOfMs - policy.usageIntervalsMs,
      '1 = 1',
      batchSize,
      [],
      'source_sample_id',
    );

    const eventPolicies: Array<{
      retentionClass: EventRetentionClass;
      retentionMs: number;
    }> = [
      {
        retentionClass: 'ordinary',
        retentionMs: policy.ordinaryEventsMs,
      },
      {
        retentionClass: 'lifecycle',
        retentionMs: policy.lifecycleEventsMs,
      },
      { retentionClass: 'action', retentionMs: policy.actionEventsMs },
      {
        retentionClass: 'security',
        retentionMs: policy.securityEventsMs,
      },
    ];
    const eventsDeleted: Record<EventRetentionClass, number> = {
      ordinary: 0,
      lifecycle: 0,
      action: 0,
      security: 0,
    };
    for (const eventPolicy of eventPolicies) {
      eventsDeleted[eventPolicy.retentionClass] = deleteBatch(
        db,
        'events',
        'occurred_at_ms',
        asOfMs - eventPolicy.retentionMs,
        'retention_class = ?',
        batchSize,
        [eventPolicy.retentionClass],
      );
    }

    // Exact-state probes can walk the age index without sorting all terminal
    // states together. Preserve one shared per-table batch limit.
    let terminalActionIntentsDeleted = 0;
    for (const state of TERMINAL_INTENT_STATES) {
      const remaining = batchSize - terminalActionIntentsDeleted;
      if (remaining === 0) break;
      terminalActionIntentsDeleted += deleteBatch(
        db,
        'action_intents',
        'COALESCE(finished_at_ms, updated_at_ms)',
        asOfMs - policy.terminalActionIntentsMs,
        'state = ?',
        remaining,
        [state],
      );
    }

    const totalDeleted =
      windowSamplesDeleted +
      usageIntervalsDeleted +
      Object.values(eventsDeleted).reduce((total, count) => total + count, 0) +
      terminalActionIntentsDeleted;
    return {
      asOfMs,
      windowSamplesDeleted,
      usageIntervalsDeleted,
      eventsDeleted,
      terminalActionIntentsDeleted,
      totalDeleted,
    };
  });

  return execute();
}

function resolvePolicy(overrides: Partial<RetentionPolicy> | undefined): RetentionPolicy {
  const policy = { ...DEFAULT_RETENTION_POLICY, ...overrides };
  validateNonNegativeInteger(policy.windowSamplesMs, 'windowSamplesMs');
  validateNonNegativeInteger(policy.usageIntervalsMs, 'usageIntervalsMs');
  validateNonNegativeInteger(policy.ordinaryEventsMs, 'ordinaryEventsMs');
  validateNonNegativeInteger(policy.lifecycleEventsMs, 'lifecycleEventsMs');
  validateNonNegativeInteger(policy.actionEventsMs, 'actionEventsMs');
  validateNonNegativeInteger(policy.securityEventsMs, 'securityEventsMs');
  validateNonNegativeInteger(policy.terminalActionIntentsMs, 'terminalActionIntentsMs');
  return policy;
}

function validateNonNegativeInteger(value: number, name: string, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function deleteBatch(
  db: SqliteDatabase,
  table: 'window_samples' | 'usage_intervals' | 'events' | 'action_intents',
  timestampExpression: string,
  cutoffMs: number,
  predicate: string,
  batchSize: number,
  predicateParameters: readonly string[] = [],
  idColumn: 'id' | 'source_sample_id' = 'id',
): number {
  const result = db
    .prepare(
      `DELETE FROM ${table}
       WHERE ${idColumn} IN (
         SELECT ${idColumn} FROM ${table}
         WHERE ${timestampExpression} < ?
           AND (${predicate})
         ORDER BY ${timestampExpression}, ${idColumn}
         LIMIT ?
       )`,
    )
    .run(cutoffMs, ...predicateParameters, batchSize);
  return result.changes;
}
