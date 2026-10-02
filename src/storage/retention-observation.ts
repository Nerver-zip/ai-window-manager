import fs from 'node:fs';
import type { Clock } from '../scheduler/clock.js';
import type { SqliteDatabase } from './database.js';
import { DEFAULT_RETENTION_POLICY } from './retention.js';

export const RETENTION_BUCKETS = [
  'samples',
  'intervals',
  'ordinary',
  'lifecycle',
  'action',
  'security',
  'intents',
] as const;
export type RetentionBucket = (typeof RETENTION_BUCKETS)[number];
export interface RetentionBacklog {
  count: number;
  capped: boolean;
  oldestAgeSeconds: number;
}
export interface RetentionObservation {
  measuredAtMs: number;
  buckets: Record<RetentionBucket, RetentionBacklog>;
  databaseBytes: number | null;
  walBytes: number | null;
}

/** Called by maintenance, never by a scrape. Counts are bounded lower estimates. */
export function observeRetention(
  db: SqliteDatabase,
  clock: Pick<Clock, 'now'>,
  countCap = 1_000,
): RetentionObservation {
  if (!Number.isSafeInteger(countCap) || countCap < 1 || countCap > 10_000)
    throw new RangeError('retention observation cap must be between 1 and 10000');
  const now = clock.now().getTime();
  if (!Number.isSafeInteger(now)) throw new RangeError('retention observation clock is invalid');
  const policy = DEFAULT_RETENTION_POLICY;
  const measure = (
    table: string,
    timestamp: string,
    cutoff: number,
    predicate = '1 = 1',
    params: readonly (string | number)[] = [],
  ): RetentionBacklog => {
    const rows = db
      .prepare(
        `SELECT ${timestamp} AS time FROM ${table}
       WHERE ${timestamp} < ? AND (${predicate})
       ORDER BY ${timestamp} LIMIT ?`,
      )
      .all(cutoff, ...params, countCap + 1) as Array<{ time: number }>;
    return {
      count: Math.min(countCap, rows.length),
      capped: rows.length > countCap,
      oldestAgeSeconds: rows[0] ? Math.max(0, (now - rows[0].time) / 1000) : 0,
    };
  };
  const checkpoint = db
    .prepare('SELECT last_sample_id AS id FROM usage_aggregation_checkpoint WHERE id = 1')
    .get() as { id: number } | undefined;
  const empty = (): RetentionBacklog => ({ count: 0, capped: false, oldestAgeSeconds: 0 });
  const buckets: Record<RetentionBucket, RetentionBacklog> = {
    samples:
      checkpoint && checkpoint.id > 0
        ? measure('window_samples', 'observed_at_ms', now - policy.windowSamplesMs, 'id <= ?', [
            checkpoint.id,
          ])
        : empty(),
    intervals: measure('usage_intervals', 'to_ms', now - policy.usageIntervalsMs),
    ordinary: measure(
      'events',
      'occurred_at_ms',
      now - policy.ordinaryEventsMs,
      'retention_class = ?',
      ['ordinary'],
    ),
    lifecycle: measure(
      'events',
      'occurred_at_ms',
      now - policy.lifecycleEventsMs,
      'retention_class = ?',
      ['lifecycle'],
    ),
    action: measure(
      'events',
      'occurred_at_ms',
      now - policy.actionEventsMs,
      'retention_class = ?',
      ['action'],
    ),
    security: measure(
      'events',
      'occurred_at_ms',
      now - policy.securityEventsMs,
      'retention_class = ?',
      ['security'],
    ),
    intents: empty(),
  };
  // Separate exact-state index probes avoid scanning/sorting all terminal rows.
  for (const state of ['confirmed', 'skipped', 'canceled', 'failed_terminal', 'resolved_unknown']) {
    const part = measure(
      'action_intents',
      'COALESCE(finished_at_ms, updated_at_ms)',
      now - policy.terminalActionIntentsMs,
      'state = ?',
      [state],
    );
    buckets.intents.capped ||= part.capped || buckets.intents.count + part.count > countCap;
    buckets.intents.count = Math.min(countCap, buckets.intents.count + part.count);
    buckets.intents.oldestAgeSeconds = Math.max(
      buckets.intents.oldestAgeSeconds,
      part.oldestAgeSeconds,
    );
  }
  const fileSize = (filename: string): number | null => {
    try {
      return fs.statSync(filename).size;
    } catch {
      return null;
    }
  };
  return {
    measuredAtMs: now,
    buckets,
    databaseBytes: db.name === ':memory:' ? null : fileSize(db.name),
    walBytes: db.name === ':memory:' ? null : fileSize(`${db.name}-wal`),
  };
}
