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
      terminalActionIntentsDeleted: 4,
    });
    expect(result.totalDeleted).toBe(9);
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
    for (const state of ['confirmed', 'skipped', 'canceled', 'failed_terminal'] as const) {
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
