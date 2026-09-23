import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderObservation, WindowSnapshot } from '../../src/domain/types.js';
import { openDatabase } from '../../src/storage/database.js';
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
