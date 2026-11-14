import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderObservation, WindowSnapshot } from '../../src/domain/types.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import {
  createRepositories,
  type ActionIntentRecord,
  type ProviderRecord,
  type ProviderStateRecord,
  type SchedulePolicyRecord,
} from '../../src/storage/repositories.js';
import {
  classifyEventType,
  DEFAULT_RETENTION_POLICY,
  runRetentionMaintenance,
  type RetentionPolicy,
} from '../../src/storage/retention.js';
import { RetentionWorker } from '../../src/storage/retention-worker.js';
import { observeRetention } from '../../src/storage/retention-observation.js';

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const dirs: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('event retention classification', () => {
  it('classifies ordinary, lifecycle, action and security event names', () => {
    expect(classifyEventType('usage_sampled')).toBe('ordinary');
    expect(classifyEventType('provider_inspected')).toBe('lifecycle');
    expect(classifyEventType('ACTION_CONFIRMED')).toBe('action');
    expect(classifyEventType('csrf_rejected')).toBe('security');
    expect(classifyEventType('provider_auth_required')).toBe('security');
    expect(classifyEventType('  unclassified_event  ')).toBe('ordinary');
  });
});

describe('retention maintenance', () => {
  it('measures bounded backlog without counting protected samples or uncertain intents', () => {
    const { db, repositories } = openTestDatabase();
    const clock = new FakeClock(new Date(NOW));
    const old = NOW - 366 * DAY_MS;
    for (let index = 0; index < 4; index += 1)
      appendEvent(repositories.events, 'provider_inspected', old + index);
    repositories.windowSamples.insert(sample(old));
    repositories.actionIntents.createIfAbsent(actionIntent('protected', 'uncertain', old));
    repositories.actionIntents.createIfAbsent(actionIntent('terminal', 'confirmed', old));
    const observed = observeRetention(db, clock, 2);
    expect(observed.buckets.lifecycle).toEqual({
      count: 2,
      capped: true,
      oldestAgeSeconds: (366 * DAY_MS) / 1000,
    });
    expect(observed.buckets.samples.count).toBe(0);
    expect(observed.buckets.intents.count).toBe(1);
    expect(observed.databaseBytes).toBeGreaterThan(0);
    expect(observed.walBytes).toBeGreaterThan(0);
    repositories.usageAggregation.advanceCheckpoint(
      repositories.usageAggregation.maxSampleId(),
      NOW,
    );
    expect(observeRetention(db, clock).buckets.samples.count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 4 });
  });

  it('omits unavailable memory-database sizes and validates observation limits and time', () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    const clock = new FakeClock(new Date(NOW));
    expect(observeRetention(db, clock)).toMatchObject({ databaseBytes: null, walBytes: null });
    for (const cap of [0, -1, 1.5, 10_001])
      expect(() => observeRetention(db, clock, cap)).toThrow(RangeError);
    expect(() => observeRetention(db, { now: () => new Date(Number.NaN) })).toThrow(RangeError);
  });

  it('uses indexed event eligibility and the canonical classification without changing history', () => {
    const { db, repositories } = openTestDatabase();
    const names = [
      'usage_sampled',
      'provider_inspected',
      'ACTION_CONFIRMED',
      'csrf_rejected',
      'provider_auth_required',
      '  auth_failed  ',
      'manual_trigger_requested',
      'providerXordinary',
      'inspection_failed',
      'reconcile_finished',
    ];
    for (const name of names) appendEvent(repositories.events, name, NOW);
    expect(db.prepare('SELECT type, retention_class FROM events ORDER BY id').all()).toEqual(
      names.map((type) => ({ type, retention_class: classifyEventType(type) })),
    );
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM events
       WHERE occurred_at_ms < ? AND retention_class = ?
       ORDER BY occurred_at_ms, id LIMIT ?`,
      )
      .all(NOW, 'lifecycle', 500) as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes('idx_events_retention_class_time'))).toBe(
      true,
    );
    expect(plan.some(({ detail }) => /SCAN events|TEMP B-TREE/.test(detail))).toBe(false);
    const intentsPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM action_intents
       WHERE COALESCE(finished_at_ms, updated_at_ms) < ? AND state = ?
       ORDER BY COALESCE(finished_at_ms, updated_at_ms), id LIMIT ?`,
      )
      .all(NOW, 'confirmed', 500) as Array<{ detail: string }>;
    expect(intentsPlan.some(({ detail }) => detail.includes('idx_action_intents_retention'))).toBe(
      true,
    );
    expect(intentsPlan.some(({ detail }) => /SCAN action_intents|TEMP B-TREE/.test(detail))).toBe(
      false,
    );
  });

  it('drains daily expired input above nominal through bounded default worker passes', async () => {
    const { db } = openTestDatabase();
    const clock = new FakeClock(new Date(NOW));
    const deleted: number[] = [];
    const worker = new RetentionWorker({
      clock,
      idleIntervalMs: 86_400_000,
      processBatch: () => {
        const result = runRetentionMaintenance(db, { clock });
        deleted.push(result.eventsDeleted.lifecycle);
        return result;
      },
      onError: (error) => {
        throw error;
      },
      yieldBetweenBatches: () => Promise.resolve(),
    });
    for (let day = 0; day < 3; day += 1) {
      db.prepare(
        `WITH RECURSIVE rows(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 24000
        )
        INSERT INTO events (provider_id, type, occurred_at_ms, data_json)
        SELECT 'fake', 'provider_inspected', ?, '{}' FROM rows`,
      ).run(NOW - 366 * DAY_MS);
      for (let pass = 0; pass < 4; pass += 1) await worker.runPass();
      expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
      clock.advanceMs(DAY_MS);
    }
    expect(deleted.every((count) => count <= 500)).toBe(true);
    await worker.stop();
  });

  it('keeps up with sample input above nominal and resumes remaining SQL rows after worker restart', async () => {
    const { db, repositories } = openTestDatabase();
    const clock = new FakeClock(new Date(NOW));
    const makeWorker = (maxBatchesPerPass?: number) =>
      new RetentionWorker({
        clock,
        idleIntervalMs: 86_400_000,
        ...(maxBatchesPerPass === undefined ? {} : { maxBatchesPerPass }),
        processBatch: () => runRetentionMaintenance(db, { clock }),
        yieldBetweenBatches: () => Promise.resolve(),
        onError: (error) => {
          throw error;
        },
      });
    for (let day = 0; day < 3; day += 1) {
      db.prepare(
        `WITH RECURSIVE rows(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 18000
      ) INSERT INTO window_samples (provider_id, window_kind, observed_at_ms, phase)
        SELECT 'fake', 'five_hour', ?, 'unknown' FROM rows`,
      ).run(NOW - 91 * DAY_MS);
      repositories.usageAggregation.advanceCheckpoint(
        repositories.usageAggregation.maxSampleId(),
        NOW,
      );
      const first = makeWorker(2);
      await first.runPass();
      await first.stop();
      expect(db.prepare('SELECT COUNT(*) AS count FROM window_samples').get()).toEqual({
        count: 17_000,
      });
      // A replacement worker does not need the previous worker's in-memory progress.
      const restarted = makeWorker();
      for (let pass = 0; pass < 2; pass += 1) await restarted.runPass();
      expect(db.prepare('SELECT COUNT(*) AS count FROM window_samples').get()).toEqual({
        count: 0,
      });
      await restarted.stop();
      clock.advanceMs(DAY_MS);
    }
  });

  it('deletes old samples/events and terminal intents while preserving current state and open intents', () => {
    const { db, repositories } = openTestDatabase();
    const oldOrdinary = NOW - 91 * DAY_MS;
    const oldImportant = NOW - 366 * DAY_MS;
    const recent = NOW - DAY_MS;
    repositories.windowSamples.insert(sample(oldOrdinary));
    repositories.windowSamples.insert(sample(recent));
    repositories.usageAggregation.advanceCheckpoint(
      repositories.usageAggregation.maxSampleId(),
      NOW,
    );
    appendEvent(repositories.events, 'usage_sampled', oldOrdinary);
    appendEvent(repositories.events, 'usage_sampled', recent);
    appendEvent(repositories.events, 'provider_inspected', oldImportant);
    appendEvent(repositories.events, 'provider_inspected', recent);
    appendEvent(repositories.events, 'action_confirmed', oldImportant);
    appendEvent(repositories.events, 'action_confirmed', recent);
    appendEvent(repositories.events, 'security_csrf_rejected', oldImportant);
    appendEvent(repositories.events, 'security_csrf_rejected', recent);

    repositories.providerState.upsert(providerState());
    repositories.settings.set('retention', { days: 90 }, oldImportant);
    repositories.schedulePolicies.upsert(schedulePolicy(oldImportant));
    repositories.providers.upsert(provider({ id: 'codex', kind: 'codex' }));
    repositories.providerCleanupJobs.createIfAbsent({
      id: 'old-cleanup-job',
      providerId: 'codex',
      artifactKind: 'codex_thread',
      externalId: 'synthetic-thread-id',
      state: 'pending',
      attemptCount: 0,
      notBeforeMs: oldImportant,
      lastErrorCode: null,
      createdAtMs: oldImportant,
      updatedAtMs: oldImportant,
    });
    for (const state of ['planned', 'executing', 'uncertain', 'failed_retryable'] as const) {
      repositories.actionIntents.createIfAbsent(actionIntent(`open-${state}`, state, oldImportant));
    }
    for (const state of [
      'succeeded',
      'confirmed',
      'skipped',
      'canceled',
      'failed_terminal',
      'resolved_unknown',
    ] as const) {
      repositories.actionIntents.createIfAbsent(
        actionIntent(`old-terminal-${state}`, state, oldImportant, {
          finishedAtMs: state === 'confirmed' ? oldImportant : null,
        }),
      );
    }
    repositories.actionIntents.createIfAbsent(
      actionIntent('recent-terminal', 'failed_terminal', recent, {
        finishedAtMs: recent,
      }),
    );

    const result = runRetentionMaintenance(db, { clock: new FakeClock(new Date(NOW)) });

    expect(result).toMatchObject({
      asOfMs: NOW,
      windowSamplesDeleted: 1,
      eventsDeleted: {
        ordinary: 1,
        lifecycle: 1,
        action: 1,
        security: 1,
      },
      terminalActionIntentsDeleted: 5,
    });
    expect(result.totalDeleted).toBe(10);
    expect(repositories.windowSamples.list('fake')).toHaveLength(1);
    expect(repositories.events.list('fake', { limit: 1000 })).toHaveLength(4);
    expect(repositories.providerState.get('fake')).toEqual(providerState());
    expect(repositories.settings.get('retention')).toEqual({
      key: 'retention',
      value: { days: 90 },
      updatedAtMs: oldImportant,
    });
    expect(repositories.schedulePolicies.get('policy-1')).toEqual(schedulePolicy(oldImportant));
    expect(repositories.providerCleanupJobs.get('old-cleanup-job')).toMatchObject({
      state: 'pending',
      artifactKind: 'codex_thread',
    });
    for (const state of [
      'confirmed',
      'skipped',
      'canceled',
      'failed_terminal',
      'resolved_unknown',
    ] as const) {
      expect(repositories.actionIntents.get(`old-terminal-${state}`)).toBeUndefined();
    }
    expect(repositories.actionIntents.get('old-terminal-succeeded')?.state).toBe('succeeded');
    expect(repositories.actionIntents.get('recent-terminal')).toBeDefined();
    for (const state of ['planned', 'executing', 'uncertain', 'failed_retryable'] as const) {
      expect(repositories.actionIntents.get(`open-${state}`)?.state).toBe(state);
    }
  });

  it('applies a configurable policy and deletes at most one batch per class per run', () => {
    const { db, repositories } = openTestDatabase();
    const old = NOW - 11_000;
    const policy: RetentionPolicy = {
      ...DEFAULT_RETENTION_POLICY,
      windowSamplesMs: 10_000,
      ordinaryEventsMs: 10_000,
      lifecycleEventsMs: 10_000,
      actionEventsMs: 10_000,
      securityEventsMs: 10_000,
      terminalActionIntentsMs: 10_000,
    };
    for (let index = 0; index < 3; index += 1) {
      repositories.windowSamples.insert(sample(old + index));
      appendEvent(repositories.events, 'usage_sampled', old + index);
      appendEvent(repositories.events, 'provider_inspected', old + index);
      appendEvent(repositories.events, 'action_succeeded', old + index);
      appendEvent(repositories.events, 'security_violation', old + index);
      repositories.actionIntents.createIfAbsent(
        actionIntent(`batch-${index}`, 'confirmed', old + index, {
          finishedAtMs: old + index,
        }),
      );
    }
    repositories.usageAggregation.advanceCheckpoint(
      repositories.usageAggregation.maxSampleId(),
      NOW,
    );

    const clock = new FakeClock(new Date(NOW));
    const first = runRetentionMaintenance(db, { clock, policy, batchSize: 2 });
    expect(first.windowSamplesDeleted).toBe(2);
    expect(first.eventsDeleted).toEqual({ ordinary: 2, lifecycle: 2, action: 2, security: 2 });
    expect(first.terminalActionIntentsDeleted).toBe(2);
    expect(first.totalDeleted).toBe(12);

    const second = runRetentionMaintenance(db, { clock, policy, batchSize: 2 });
    expect(second.totalDeleted).toBe(6);
    expect(repositories.windowSamples.list('fake')).toEqual([]);
    expect(repositories.events.list('fake', { limit: 1000 })).toEqual([]);
    expect(repositories.actionIntents.get('batch-2')).toBeUndefined();
  });

  it('uses the FakeClock instant explicitly and keeps rows on the retention boundary', () => {
    const { db, repositories } = openTestDatabase();
    const clock = new FakeClock(new Date(NOW));
    const policy = { ...DEFAULT_RETENTION_POLICY, windowSamplesMs: DAY_MS };
    const boundary = NOW - DAY_MS;
    repositories.windowSamples.insert(sample(boundary));

    expect(runRetentionMaintenance(db, { clock, policy }).windowSamplesDeleted).toBe(0);
    clock.advanceMs(1);
    expect(runRetentionMaintenance(db, { clock, policy }).windowSamplesDeleted).toBe(0);
    repositories.usageAggregation.advanceCheckpoint(
      repositories.usageAggregation.maxSampleId(),
      NOW + 1,
    );
    expect(runRetentionMaintenance(db, { clock, policy }).windowSamplesDeleted).toBe(1);
  });

  it('keeps expired samples until the usage aggregation cursor passes them', () => {
    const { db, repositories } = openTestDatabase();
    repositories.windowSamples.insert(sample(NOW - 91 * DAY_MS));
    const clock = new FakeClock(new Date(NOW));
    expect(runRetentionMaintenance(db, { clock }).windowSamplesDeleted).toBe(0);
    expect(repositories.windowSamples.list('fake')).toHaveLength(1);
    repositories.usageAggregation.advanceCheckpoint(
      repositories.usageAggregation.maxSampleId(),
      NOW,
    );
    expect(runRetentionMaintenance(db, { clock }).windowSamplesDeleted).toBe(1);
  });

  it('retains derived daily usage beyond raw-sample retention for a full year view', () => {
    const { db, repositories } = openTestDatabase();
    const oldTo = NOW - 401 * DAY_MS;
    const recentTo = NOW - 399 * DAY_MS;
    const intervals: Array<[number, number]> = [
      [1, oldTo],
      [2, recentTo],
    ];
    for (const [sourceSampleId, toMs] of intervals) {
      repositories.usageAggregation.insertInterval({
        sourceSampleId,
        providerId: 'fake',
        windowKind: 'weekly',
        fromMs: toMs - 60_000,
        toMs,
        usageDeltaRatio: 0.01,
        quality: 'observed',
        reasonCode: null,
      });
    }

    const result = runRetentionMaintenance(db, { clock: new FakeClock(new Date(NOW)) });
    expect(result.usageIntervalsDeleted).toBe(1);
    expect(result.totalDeleted).toBe(1);
    expect(
      db.prepare('SELECT source_sample_id FROM usage_intervals').all() as Array<{
        source_sample_id: number;
      }>,
    ).toEqual([{ source_sample_id: 2 }]);
  });

  it('expires history even when a provider is paused, disconnected, or hidden from the UI', () => {
    const { db, repositories } = openTestDatabase();
    const oldSampleAt = NOW - 91 * DAY_MS;
    const oldState = providerState();
    repositories.providers.upsert(provider({ enabled: false }));
    repositories.providerState.upsert({
      ...oldState,
      health: 'AUTH_REQUIRED',
      lastErrorCode: 'AUTH_REQUIRED',
    });
    repositories.windowSamples.insert(sample(oldSampleAt));
    repositories.usageAggregation.advanceCheckpoint(
      repositories.usageAggregation.maxSampleId(),
      NOW,
    );
    appendEvent(repositories.events, 'usage_sampled', oldSampleAt);

    const result = runRetentionMaintenance(db, { clock: new FakeClock(new Date(NOW)) });

    expect(result.windowSamplesDeleted).toBe(1);
    expect(result.eventsDeleted.ordinary).toBe(1);
    expect(repositories.windowSamples.list('fake')).toEqual([]);
    expect(repositories.events.list('fake')).toEqual([]);
    expect(repositories.providerState.get('fake')).toMatchObject({
      health: 'AUTH_REQUIRED',
      lastErrorCode: 'AUTH_REQUIRED',
    });
  });

  it('rejects invalid retention configuration before changing rows', () => {
    const { db, repositories } = openTestDatabase();
    repositories.windowSamples.insert(sample(NOW - DAY_MS));
    const clock = new FakeClock(new Date(NOW));

    expect(() =>
      runRetentionMaintenance(db, {
        clock,
        policy: { ordinaryEventsMs: -1 },
      }),
    ).toThrow('ordinaryEventsMs');
    expect(() => runRetentionMaintenance(db, { clock, batchSize: 0 })).toThrow('batchSize');
    expect(repositories.windowSamples.list('fake')).toHaveLength(1);
  });
});

function openTestDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-retention-'));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, 'awm.db'));
  databases.push(db);
  const repositories = createRepositories(db);
  repositories.providers.upsert(provider());
  repositories.schedulePolicies.upsert(schedulePolicy(NOW));
  return { db, repositories };
}

function provider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'fake',
    kind: 'fake',
    enabled: true,
    mode: 'monitor_only',
    pollIntervalSeconds: 30,
    config: {},
    configVersion: 1,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides,
  };
}

function schedulePolicy(updatedAtMs: number): SchedulePolicyRecord {
  return {
    id: 'policy-1',
    providerId: 'fake',
    scope: 'default',
    requiresReview: false,
    kind: 'target_reset',
    kindExplicit: false,
    enabled: true,
    timezone: 'UTC',
    config: { target: '08:00' },
    createdAtMs: NOW,
    updatedAtMs,
  };
}

function providerState(): ProviderStateRecord {
  const observation = providerObservation();
  return {
    providerId: 'fake',
    health: 'UP',
    observedAtMs: NOW,
    staleAfterMs: 90_000,
    observation,
    lastSuccessAtMs: NOW,
    lastErrorCode: null,
    updatedAtMs: NOW,
  };
}

function providerObservation(): ProviderObservation {
  return {
    providerId: 'fake',
    health: 'UP',
    observedAt: new Date(NOW).toISOString(),
    staleAfterSeconds: 90,
    windows: [sample(NOW)],
    summary: 'retention test observation',
  };
}

function sample(observedAtMs: number): WindowSnapshot {
  const observedAt = new Date(observedAtMs).toISOString();
  return {
    providerId: 'fake',
    windowKind: 'five_hour',
    observedAt,
    phase: {
      value: 'INACTIVE',
      source: 'observed',
      confidence: 'exact',
      observedAt,
    },
  };
}

function appendEvent(
  events: ReturnType<typeof createRepositories>['events'],
  type: string,
  occurredAtMs: number,
): void {
  events.append({
    occurredAtMs,
    providerId: 'fake',
    type,
    severity: 'info',
    reasonCode: null,
    data: {},
  });
}

function actionIntent(
  id: string,
  state: ActionIntentRecord['state'],
  timestampMs: number,
  overrides: Partial<ActionIntentRecord> = {},
): ActionIntentRecord {
  return {
    id,
    providerId: 'fake',
    policyId: 'policy-1',
    actionType: 'trigger_window',
    dedupeKey: `retention:${id}`,
    state,
    scheduledForMs: timestampMs,
    notBeforeMs: null,
    expiresAtMs: timestampMs + DAY_MS,
    attemptCount: 0,
    confirmationAttemptCount: 0,
    confirmationNotBeforeMs: null,
    reasonCode: 'TEST',
    explanation: { test: true },
    lastErrorCode: null,
    createdAtMs: timestampMs,
    startedAtMs: null,
    finishedAtMs: state === 'confirmed' || state === 'failed_terminal' ? timestampMs : null,
    updatedAtMs: timestampMs,
    ...overrides,
  };
}
