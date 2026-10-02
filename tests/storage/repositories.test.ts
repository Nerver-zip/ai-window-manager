import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderObservation, WindowSnapshot } from '../../src/domain/types.js';
import { openDatabase } from '../../src/storage/database.js';
import { trackWindowCycles } from '../../src/scheduler/window-cycle.js';
import {
  createRepositories,
  withTransaction,
  type ActionIntentRecord,
  type EventRecord,
  type ProviderRecord,
  type ProviderStateRecord,
  type SchedulePolicyRecord,
} from '../../src/storage/repositories.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const observedAt = '2026-09-19T12:00:00.000Z';
const laterObservedAt = '2026-09-19T12:01:00.000Z';
const observedAtMs = Date.parse(observedAt);

function openTestDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-repositories-'));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, 'awm.db'));
  return { db, repositories: createRepositories(db) };
}

function sample(providerId = 'fake', at = observedAt): WindowSnapshot {
  return {
    providerId,
    windowKind: 'five_hour',
    observedAt: at,
    phase: {
      value: 'ACTIVE',
      source: 'observed',
      confidence: 'exact',
      observedAt: at,
    },
    startedAt: {
      value: '2026-09-19T11:00:00.000Z',
      source: 'observed',
      confidence: 'exact',
      observedAt: at,
    },
    durationSeconds: {
      value: 18_000,
      source: 'official_supported',
      confidence: 'high',
      observedAt: at,
    },
    resetAt: {
      value: '2026-09-19T16:00:00.000Z',
      source: 'inferred',
      confidence: 'high',
      observedAt: at,
    },
    usageRatio: {
      value: 0.25,
      source: 'observed',
      confidence: 'exact',
      observedAt: at,
    },
    remainingRatio: {
      value: 0.75,
      source: 'inferred',
      confidence: 'high',
      observedAt: at,
    },
  };
}

function observation(providerId = 'fake'): ProviderObservation {
  return {
    providerId,
    health: 'UP',
    observedAt,
    windows: [sample(providerId)],
    staleAfterSeconds: 60,
    summary: 'sanitized test observation',
  };
}

function provider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'fake',
    kind: 'fake',
    enabled: true,
    mode: 'monitor_only',
    pollIntervalSeconds: 30,
    config: { scenario: 'active' },
    configVersion: 1,
    createdAtMs: observedAtMs,
    updatedAtMs: observedAtMs,
    ...overrides,
  };
}

function state(overrides: Partial<ProviderStateRecord> = {}): ProviderStateRecord {
  return {
    providerId: 'fake',
    health: 'UP',
    observedAtMs,
    staleAfterMs: 60_000,
    observation: observation(),
    lastSuccessAtMs: observedAtMs,
    lastErrorCode: null,
    updatedAtMs: observedAtMs,
    ...overrides,
  };
}

function policy(overrides: Partial<SchedulePolicyRecord> = {}): SchedulePolicyRecord {
  return {
    id: 'policy-1',
    providerId: 'fake',
    kind: 'target_reset',
    enabled: true,
    timezone: 'America/Sao_Paulo',
    config: { target: '08:00' },
    createdAtMs: observedAtMs,
    updatedAtMs: observedAtMs,
    ...overrides,
  };
}

function intent(overrides: Partial<ActionIntentRecord> = {}): ActionIntentRecord {
  return {
    id: 'intent-1',
    providerId: 'fake',
    policyId: 'policy-1',
    actionType: 'trigger_window',
    dedupeKey: 'fake:trigger_window:cycle-1',
    state: 'planned',
    scheduledForMs: observedAtMs,
    notBeforeMs: null,
    expiresAtMs: observedAtMs + 60_000,
    attemptCount: 0,
    confirmationAttemptCount: 0,
    confirmationNotBeforeMs: null,
    reasonCode: 'TARGET_RESET',
    explanation: { target: '2026-09-19T12:00:00.000Z' },
    lastErrorCode: null,
    createdAtMs: observedAtMs,
    startedAtMs: null,
    finishedAtMs: null,
    updatedAtMs: observedAtMs,
    ...overrides,
  };
}

describe('storage repositories', () => {
  it('conditionally binds an unsent cycle without rewriting a side effect or changed intent', () => {
    const { db, repositories } = openTestDatabase();
    repositories.providers.upsert(provider());
    repositories.schedulePolicies.upsert(policy());
    trackWindowCycles(observation(), repositories);
    const original = intent({
      explanation: { windowKind: 'five_hour', reasonCode: 'MANUAL_TRIGGER_REQUESTED' },
    });
    repositories.actionIntents.createIfAbsent(original);
    const cycle = repositories.windowCycles.get('fake', 'five_hour')!;
    expect(
      repositories.actionIntents.bindObservedCycle(
        original,
        'five_hour',
        cycle.cycleAtMs + 1,
        observedAtMs,
      ),
    ).toBeUndefined();
    expect(
      repositories.actionIntents.bindObservedCycle(
        original,
        'weekly',
        cycle.cycleAtMs,
        observedAtMs,
      ),
    ).toBeUndefined();
    const bound = repositories.actionIntents.bindObservedCycle(
      original,
      'five_hour',
      cycle.cycleAtMs,
      observedAtMs,
    )!;
    expect(bound.explanation).toEqual({
      ...(original.explanation as object),
      observedCycleAt: new Date(cycle.cycleAtMs).toISOString(),
    });
    expect(bound.dedupeKey).toBe(original.dedupeKey);
    expect(
      repositories.actionIntents.bindObservedCycle(
        original,
        'five_hour',
        cycle.cycleAtMs,
        observedAtMs,
      ),
    ).toBeUndefined();
    const legacy = intent({
      id: 'legacy',
      dedupeKey: 'legacy-unidentified',
      explanation: { windowKind: 'five_hour' },
      state: 'uncertain',
    });
    repositories.actionIntents.createIfAbsent(legacy);
    expect(
      repositories.actionIntents.bindObservedCycle(
        legacy,
        'five_hour',
        cycle.cycleAtMs,
        observedAtMs,
      ),
    ).toBeUndefined();
    const changed = intent({
      id: 'changed',
      dedupeKey: 'changed',
      explanation: { windowKind: 'five_hour' },
    });
    repositories.actionIntents.createIfAbsent(changed);
    repositories.actionIntents.setState(changed.id, 'planned', observedAtMs + 1);
    expect(
      repositories.actionIntents.bindObservedCycle(
        changed,
        'five_hour',
        cycle.cycleAtMs,
        observedAtMs,
      ),
    ).toBeUndefined();
    expect(() =>
      repositories.actionIntents.bindObservedCycle(original, 'five_hour', NaN, observedAtMs),
    ).toThrow(RangeError);
    db.close();
  });

  it('persists providers and cascades current state/history on delete', () => {
    const { db, repositories } = openTestDatabase();
    repositories.providers.upsert(provider());
    repositories.providers.upsert(provider({ mode: 'automation', updatedAtMs: observedAtMs + 1 }));

    expect(repositories.providers.get('fake')).toMatchObject({ mode: 'automation' });
    expect(repositories.providers.list()).toHaveLength(1);
    expect(repositories.providers.get('missing')).toBeUndefined();

    repositories.providerState.upsert(state());
    const sampleId = repositories.windowSamples.insert(sample());
    repositories.events.append({
      occurredAtMs: observedAtMs,
      providerId: 'fake',
      type: 'usage_sampled',
      severity: 'info',
      reasonCode: null,
      data: { sampleId },
    });
    expect(repositories.providers.delete('fake')).toBe(true);
    expect(repositories.providers.delete('fake')).toBe(false);
    expect(repositories.providerState.get('fake')).toBeUndefined();
    expect(repositories.windowSamples.get(sampleId)).toBeUndefined();
    expect(repositories.events.list('fake')).toHaveLength(0);
    db.close();
  });

  it('preserves validated provider state and rejects invalid observations', () => {
    const { db, repositories } = openTestDatabase();
    repositories.providers.upsert(provider());
    repositories.providerState.upsert(state());
    expect(repositories.providerState.get('fake')).toMatchObject({
      providerId: 'fake',
      observation: observation(),
    });
    repositories.providerState.upsert(
      state({ health: 'DEGRADED', observation: null, lastErrorCode: 'TIMEOUT' }),
    );
    expect(repositories.providerState.get('fake')).toMatchObject({
      health: 'DEGRADED',
      observation: null,
      lastErrorCode: 'TIMEOUT',
    });
    expect(() =>
      repositories.providerState.upsert(
        state({
          observation: { ...observation(), providerId: 'not valid!' },
        }),
      ),
    ).toThrow();
    db.close();
  });

  it('round-trips all evidence-bearing window facts and supports bounded history queries', () => {
    const { db, repositories } = openTestDatabase();
    repositories.providers.upsert(provider());
    const firstId = repositories.windowSamples.insert(sample());
    repositories.windowSamples.insert({
      providerId: 'fake',
      windowKind: 'weekly',
      observedAt: laterObservedAt,
      phase: {
        value: 'INACTIVE',
        source: 'inferred',
        confidence: 'medium',
        observedAt: laterObservedAt,
      },
    });

    expect(repositories.windowSamples.get(firstId)).toEqual(sample());
    expect(repositories.windowSamples.get(999_999)).toBeUndefined();
    expect(repositories.windowSamples.latest('fake', 'five_hour')).toEqual(sample());
    expect(repositories.windowSamples.latest('fake', 'missing')).toBeUndefined();
    expect(repositories.windowSamples.list('fake', { limit: 1 })).toHaveLength(1);
    expect(
      repositories.windowSamples.list('fake', { beforeMs: observedAtMs + 30_000 }),
    ).toHaveLength(1);
    expect(repositories.windowSamples.list('missing')).toEqual([]);
    db.close();
  });

  it('keeps legacy nullable fact metadata unknown and falls back to the sample observation time', () => {
    const { db, repositories } = openTestDatabase();
    repositories.providers.upsert(provider());
    const sampleId = repositories.windowSamples.insert(sample());
    db.prepare(
      `UPDATE window_samples SET
        phase_source = NULL, phase_confidence = NULL, phase_observed_at_ms = NULL,
        started_source = NULL, started_confidence = NULL, started_observed_at_ms = NULL,
        reset_source = NULL, reset_confidence = NULL, reset_observed_at_ms = NULL,
        duration_source = NULL, duration_confidence = NULL, duration_observed_at_ms = NULL,
        usage_source = NULL, usage_confidence = NULL, usage_observed_at_ms = NULL,
        remaining_source = NULL, remaining_confidence = NULL, remaining_observed_at_ms = NULL
       WHERE id = ?`,
    ).run(sampleId);

    const persisted = repositories.windowSamples.get(sampleId);
    expect(persisted).toMatchObject({
      observedAt,
      phase: { value: 'ACTIVE', source: 'unknown', confidence: 'unknown', observedAt },
      startedAt: {
        value: '2026-09-19T11:00:00.000Z',
        source: 'unknown',
        confidence: 'unknown',
        observedAt,
      },
      resetAt: {
        value: '2026-09-19T16:00:00.000Z',
        source: 'unknown',
        confidence: 'unknown',
        observedAt,
      },
      durationSeconds: { value: 18_000, source: 'unknown', confidence: 'unknown', observedAt },
      usageRatio: { value: 0.25, source: 'unknown', confidence: 'unknown', observedAt },
      remainingRatio: { value: 0.75, source: 'unknown', confidence: 'unknown', observedAt },
    });
    db.close();
  });

  it('round-trips events, settings and schedule policies', () => {
    const { db, repositories } = openTestDatabase();
    repositories.providers.upsert(provider());
    repositories.schedulePolicies.upsert(policy());
    repositories.schedulePolicies.upsert(policy({ enabled: false, updatedAtMs: observedAtMs + 1 }));
    repositories.schedulePolicies.upsert(policy({ id: 'policy-2', kind: 'manual' }));

    expect(repositories.schedulePolicies.get('policy-1')).toMatchObject({ enabled: false });
    expect(repositories.schedulePolicies.list()).toHaveLength(2);
    expect(repositories.schedulePolicies.list('fake')).toHaveLength(2);
    expect(repositories.schedulePolicies.list('other')).toEqual([]);
    expect(repositories.schedulePolicies.delete('policy-2')).toBe(true);
    expect(repositories.schedulePolicies.delete('policy-2')).toBe(false);

    repositories.settings.set('timezone', 'America/Sao_Paulo', observedAtMs);
    repositories.settings.set('limits', { polling: 30 }, observedAtMs + 1);
    expect(repositories.settings.get<string>('timezone')).toEqual({
      key: 'timezone',
      value: 'America/Sao_Paulo',
      updatedAtMs: observedAtMs,
    });
    expect(repositories.settings.list()).toHaveLength(2);
    expect(repositories.settings.get('missing')).toBeUndefined();
    expect(repositories.settings.delete('timezone')).toBe(true);
    expect(repositories.settings.delete('timezone')).toBe(false);

    const event: EventRecord = {
      occurredAtMs: observedAtMs,
      providerId: 'fake',
      type: 'inspection_failed',
      severity: 'warn',
      reasonCode: 'TIMEOUT',
      data: { retryable: true },
    };
    const eventId = repositories.events.append(event);
    const systemEventId = repositories.events.append({
      ...event,
      providerId: null,
      type: 'timezone_updated',
      occurredAtMs: observedAtMs + 1,
    });
    expect(repositories.events.list('fake')).toMatchObject([
      { id: eventId, data: { retryable: true } },
    ]);
    expect(repositories.events.list(undefined, { excludeProviderId: 'fake' })).toMatchObject([
      { id: systemEventId, providerId: null },
    ]);
    expect(repositories.events.list(undefined, { excludeTypes: ['inspection_failed'] })).toEqual([
      expect.objectContaining({ id: systemEventId }),
    ]);
    expect(repositories.events.list(undefined, { beforeMs: observedAtMs + 1 })).toHaveLength(1);
    expect(repositories.events.list('fake', { limit: 0 })).toHaveLength(1);
    expect(
      repositories.events.list(undefined, {
        afterMs: observedAtMs,
        beforeMs: observedAtMs + 2,
        limit: 1,
        offset: 1,
      }),
    ).toEqual([expect.objectContaining({ occurredAtMs: observedAtMs })]);
    db.close();
  });

  it('records closure evidence only after a real observed lifecycle boundary for an unresolved intent', () => {
    const { db, repositories } = openTestDatabase();
    repositories.providers.upsert(provider());
    repositories.schedulePolicies.upsert(policy());
    repositories.actionIntents.createIfAbsent(
      intent({
        state: 'uncertain',
        explanation: {
          windowKind: 'five_hour',
          observedCycleAt: observedAt,
        },
      }),
    );
    withTransaction(db, () => trackWindowCycles(observation(), repositories));
    expect(repositories.windowCycles.getClosure('fake', 'five_hour', observedAtMs)).toBeUndefined();
    const next = observation();
    const nextAt = '2026-09-19T17:00:00.000Z';
    next.observedAt = nextAt;
    next.windows = [sample('fake', nextAt)];
    next.windows[0]!.resetAt!.value = '2026-09-19T22:00:00.000Z';
    withTransaction(db, () => trackWindowCycles(next, repositories));
    expect(repositories.windowCycles.getClosure('fake', 'five_hour', observedAtMs)).toEqual({
      providerId: 'fake',
      windowKind: 'five_hour',
      cycleAtMs: observedAtMs,
      endedAtMs: Date.parse('2026-09-19T16:00:00.000Z'),
      observedAtMs: Date.parse(nextAt),
      evidenceKind: 'anchored_boundary',
    });
    db.close();
  });

  it('resolves unknown outcomes conditionally with durable evidence, audit and preserved dedupe', () => {
    const { db, repositories } = openTestDatabase();
    repositories.providers.upsert(provider());
    repositories.schedulePolicies.upsert(policy());
    const original = intent({
      state: 'uncertain',
      attemptCount: 1,
      lastErrorCode: 'UNKNOWN_RESULT',
      explanation: { windowKind: 'five_hour', observedCycleAt: observedAt },
    });
    repositories.actionIntents.createIfAbsent(original);
    expect(
      repositories.actionIntents.resolveUnknownIfUncertain(
        original,
        observedAtMs + 2000,
        observedAtMs + 1000,
      ),
    ).toBe(false);
    const closure = {
      providerId: 'fake',
      windowKind: 'five_hour',
      cycleAtMs: observedAtMs,
      endedAtMs: observedAtMs + 500,
      observedAtMs: observedAtMs + 1000,
      evidenceKind: 'anchored_boundary' as const,
    };
    repositories.windowCycles.recordClosure(closure);
    repositories.windowCycles.recordClosure(closure);
    expect(repositories.windowCycles.getClosure('fake', 'five_hour', observedAtMs)).toEqual(
      closure,
    );
    expect(
      repositories.actionIntents.resolveUnknownIfUncertain(
        original,
        observedAtMs + 2000,
        observedAtMs,
      ),
    ).toBe(false);
    expect(
      repositories.actionIntents.resolveUnknownIfUncertain(
        original,
        observedAtMs + 2000,
        observedAtMs + 1000,
      ),
    ).toBe(true);
    expect(repositories.actionIntents.get(original.id)).toEqual({
      ...original,
      state: 'resolved_unknown',
      finishedAtMs: observedAtMs + 2000,
      updatedAtMs: observedAtMs + 2000,
    });
    expect(repositories.actionIntents.listOpen()).toEqual([]);
    expect(
      repositories.actionIntents.resolveUnknownIfUncertain(
        original,
        observedAtMs + 3000,
        observedAtMs + 1000,
      ),
    ).toBe(false);
    expect(
      repositories.actionIntents.markConfirmedIfSucceededOrUncertain(
        original.id,
        observedAtMs + 3000,
      ),
    ).toBe(false);
    expect(
      repositories.actionIntents.createIfAbsent({ ...original, id: 'duplicate' }).created,
    ).toBe(false);
    expect(repositories.events.list('fake')).toHaveLength(1);
    expect(repositories.events.list('fake')[0]).toMatchObject({
      type: 'action_resolved_unknown',
      reasonCode: 'ACTION_OUTCOME_UNKNOWN',
    });
    const race = { ...original, id: 'race', dedupeKey: 'race-key' };
    repositories.actionIntents.createIfAbsent(race);
    repositories.windowCycles.recordClosure(closure);
    expect(
      repositories.actionIntents.markConfirmedIfSucceededOrUncertain(race.id, observedAtMs + 1500),
    ).toBe(true);
    expect(
      repositories.actionIntents.resolveUnknownIfUncertain(
        race,
        observedAtMs + 2000,
        observedAtMs + 1000,
      ),
    ).toBe(false);
    expect(repositories.actionIntents.get(race.id)?.state).toBe('confirmed');
    expect(() => repositories.actionIntents.resolveUnknownIfUncertain(original, 0, 1)).toThrow(
      RangeError,
    );
    db.prepare('DELETE FROM action_intents').run();
    expect(db.prepare('SELECT COUNT(*) AS count FROM observed_cycle_closures').get()).toEqual({
      count: 0,
    });
    db.close();
  });

  it('creates action intents atomically and enforces dedupe', () => {
    const { db, repositories } = openTestDatabase();
    repositories.providers.upsert(provider());
    repositories.schedulePolicies.upsert(policy());
    const first = repositories.actionIntents.createIfAbsent(intent());
    const duplicate = repositories.actionIntents.createIfAbsent(
      intent({ id: 'intent-2', explanation: { changed: true } }),
    );

    expect(first).toEqual({ created: true, intent: intent() });
    expect(duplicate).toEqual({ created: false, intent: intent() });
    expect(repositories.actionIntents.get('intent-1')).toEqual(intent());
    expect(repositories.actionIntents.getByDedupeKey(intent().dedupeKey)).toEqual(intent());
    expect(repositories.actionIntents.get('missing')).toBeUndefined();
    expect(repositories.actionIntents.listOpen()).toHaveLength(1);
    expect(repositories.actionIntents.listOpen('fake')).toHaveLength(1);
    expect(repositories.actionIntents.listOpen('other')).toEqual([]);

    expect(
      repositories.actionIntents.setState('intent-1', 'uncertain', observedAtMs + 1, {
        attemptCount: 1,
        lastErrorCode: 'UNKNOWN_RESULT',
        startedAtMs: observedAtMs,
      }),
    ).toBe(true);
    expect(repositories.actionIntents.get('intent-1')).toMatchObject({
      state: 'uncertain',
      attemptCount: 1,
      lastErrorCode: 'UNKNOWN_RESULT',
      startedAtMs: observedAtMs,
    });
    expect(
      repositories.actionIntents.setState('intent-1', 'confirmed', observedAtMs + 2, {
        finishedAtMs: observedAtMs + 2,
      }),
    ).toBe(true);
    expect(repositories.actionIntents.setState('missing', 'failed_terminal', observedAtMs)).toBe(
      false,
    );
    expect(repositories.actionIntents.listOpen()).toEqual([]);
    db.close();
  });

  it('runs repository work inside a transaction', () => {
    const { db, repositories } = openTestDatabase();
    repositories.providers.upsert(provider());
    withTransaction(db, () => {
      repositories.settings.set('one', 1, observedAtMs);
      repositories.settings.set('two', 2, observedAtMs);
    });
    expect(repositories.settings.list()).toHaveLength(2);
    db.close();
  });
});
