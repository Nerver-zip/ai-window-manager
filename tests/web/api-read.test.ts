import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ProviderCapabilities,
  ProviderObservation,
  WindowSnapshot,
} from '../../src/domain/types.js';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import {
  createRepositories,
  type ActionIntentRecord,
  type ProviderRecord,
  type StorageRepositories,
} from '../../src/storage/repositories.js';
import { createReadApi, type ReadApiHandlers } from '../../src/web/api-read.js';

const NOW = '2026-09-19T12:00:00.000Z';
const resources: Array<{ db: SqliteDatabase; dir: string }> = [];

const capabilities: ProviderCapabilities = {
  usageRead: { supported: true, contract: 'official_supported' },
  resetRead: { supported: true, contract: 'official_supported' },
  windowTrigger: { supported: false, contract: 'unknown', consumesQuota: 'unknown' },
};

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

function createApi(
  seed: (repositories: StorageRepositories, clock: FakeClock) => void = () => undefined,
  adapter: ProviderAdapter | undefined = inspectionSpy('fake'),
  fakeProviderEnabled = true,
): { api: ReadApiHandlers; repositories: StorageRepositories; clock: FakeClock } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-api-read-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  resources.push({ db, dir });
  const repositories = createRepositories(db);
  const clock = new FakeClock(NOW);
  seed(repositories, clock);
  return {
    api: createReadApi({
      repositories,
      clock,
      adapters: adapter ? new Map([[adapter.id, adapter]]) : new Map(),
      fakeProviderEnabled,
    }),
    repositories,
    clock,
  };
}

function providerRecord(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'fake',
    kind: 'fake',
    enabled: true,
    mode: 'monitor_only',
    pollIntervalSeconds: 300,
    config: { secretReference: 'must-not-be-returned' },
    configVersion: 1,
    createdAtMs: Date.parse(NOW),
    updatedAtMs: Date.parse(NOW),
    ...overrides,
  };
}

function inspectionSpy(id: string, inspected?: { count: number }): ProviderAdapter {
  return {
    id,
    capabilities: () => capabilities,
    health: () => Promise.resolve('UP'),
    inspect: () => {
      if (inspected) inspected.count += 1;
      throw new Error('read API must not inspect providers');
    },
  };
}

function observation(providerId = 'fake', observedAt = NOW): ProviderObservation {
  const window: WindowSnapshot = {
    providerId,
    windowKind: 'five_hour',
    observedAt,
    phase: {
      value: 'INACTIVE',
      source: 'observed',
      confidence: 'exact',
      observedAt,
    },
    startedAt: {
      value: '2026-09-19T07:00:00.000Z',
      source: 'observed',
      confidence: 'exact',
      observedAt,
    },
    durationSeconds: {
      value: 18_000,
      source: 'official_supported',
      confidence: 'high',
      observedAt,
    },
    resetAt: {
      value: '2026-09-19T16:00:00.000Z',
      source: 'inferred',
      confidence: 'high',
      observedAt,
    },
    usageRatio: {
      value: 0.25,
      source: 'observed',
      confidence: 'exact',
      observedAt,
    },
    remainingRatio: {
      value: 0.75,
      source: 'inferred',
      confidence: 'exact',
      observedAt,
    },
  };
  return {
    providerId,
    health: 'UP',
    observedAt,
    windows: [window],
    staleAfterSeconds: 300,
    summary: 'safe normalized summary',
  };
}

function seedObservedProvider(
  repositories: StorageRepositories,
  providerId = 'fake',
  observedAt = NOW,
): void {
  repositories.providers.upsert(providerRecord({ id: providerId }));
  const current = observation(providerId, observedAt);
  const observedAtMs = Date.parse(observedAt);
  repositories.providerState.upsert({
    providerId,
    health: current.health,
    observedAtMs,
    staleAfterMs: current.staleAfterSeconds * 1000,
    observation: current,
    lastSuccessAtMs: observedAtMs,
    lastErrorCode: null,
    updatedAtMs: observedAtMs,
  });
}

function intent(overrides: Partial<ActionIntentRecord> = {}): ActionIntentRecord {
  const at = Date.parse(NOW);
  return {
    id: 'intent-1',
    providerId: 'fake',
    policyId: 'policy-1',
    actionType: 'trigger_window',
    dedupeKey: 'fake:trigger_window:cycle-1',
    state: 'planned',
    scheduledForMs: at,
    notBeforeMs: null,
    expiresAtMs: at + 30_000,
    attemptCount: 0,
    confirmationAttemptCount: 0,
    confirmationNotBeforeMs: null,
    reasonCode: 'TARGET_RESET_WINDOW_MATCH',
    explanation: {
      decision: 'create_intent',
      reasonCode: 'TARGET_RESET_WINDOW_MATCH',
      providerId: 'fake',
      policyId: 'policy-1',
      targetTriggerAt: NOW,
      ignored: 'not exposed',
    },
    lastErrorCode: null,
    createdAtMs: at,
    startedAtMs: null,
    finishedAtMs: null,
    updatedAtMs: at,
    ...overrides,
  };
}

describe('read API handlers', () => {
  it('omits persisted fake provider state and events when disabled by configuration', () => {
    const { api } = createApi(
      (repositories) => {
        seedObservedProvider(repositories, 'fake');
        seedObservedProvider(repositories, 'codex', NOW);
        for (const [providerId, type] of [
          ['fake', 'fake_activity'],
          ['codex', 'codex_activity'],
          [null, 'system_activity'],
        ] as const) {
          repositories.events.append({
            occurredAtMs: Date.parse(NOW),
            providerId,
            type,
            severity: 'info',
            reasonCode: null,
            data: {},
          });
        }
      },
      inspectionSpy('fake'),
      false,
    );

    expect(api.getProviders().body.providers.map((provider) => provider.id)).toEqual(['codex']);
    expect(api.getProvider('fake').statusCode).toBe(404);
    const history = api.getHistory({ limit: '10' });
    expect(history.statusCode).toBe(200);
    if (history.statusCode === 200) {
      expect(history.body.events.map((event) => event.type)).toEqual([
        'system_activity',
        'codex_activity',
      ]);
    }
    const fakeHistory = api.getHistory({ provider: 'fake' });
    expect(fakeHistory.statusCode).toBe(200);
    if (fakeHistory.statusCode === 200) expect(fakeHistory.body.events).toEqual([]);
  });

  it('projects provider list and detail from persisted state without inspection', () => {
    const inspected = { count: 0 };
    const { api, repositories } = createApi(
      (repository) => {
        seedObservedProvider(repository);
        repository.providers.upsert(providerRecord({ id: 'missing', kind: 'unknown' }));
        repository.schedulePolicies.upsert({
          id: 'policy-1',
          providerId: 'fake',
          kind: 'target_reset',
          enabled: true,
          timezone: 'America/Sao_Paulo',
          config: {},
          createdAtMs: Date.parse(NOW),
          updatedAtMs: Date.parse(NOW),
        });
        repository.actionIntents.createIfAbsent(intent());
        repository.events.append({
          occurredAtMs: Date.parse(NOW),
          providerId: 'fake',
          type: 'action_intent_planned',
          severity: 'info',
          reasonCode: 'TARGET_RESET_WINDOW_MATCH',
          data: {
            intentId: 'intent-1',
            explanation: {
              decision: 'create_intent',
              reasonCode: 'TARGET_RESET_WINDOW_MATCH',
              targetTriggerAt: NOW,
              ignoredSecret: 'never returned',
            },
          },
        });
      },
      inspectionSpy('fake', inspected),
    );

    const list = api.getProviders();
    expect(list.statusCode).toBe(200);
    expect(list.body.providers).toHaveLength(2);
    const firstProvider = list.body.providers[0];
    expect(firstProvider).toBeDefined();
    if (!firstProvider) throw new Error('expected fake provider');
    expect(firstProvider).toMatchObject({
      id: 'fake',
      health: 'UP',
      windows: [{ windowKind: 'five_hour', phase: { value: 'INACTIVE' } }],
      freshness: { ageSeconds: 0, stale: false },
      capabilities: { usageRead: { supported: true } },
      nextDecision: {
        decision: 'create_intent',
        reasonCode: 'TARGET_RESET_WINDOW_MATCH',
        actionIntent: { id: 'intent-1', state: 'planned' },
      },
    });
    expect(firstProvider.windows[0]?.durationSeconds).toMatchObject({ value: 18_000 });
    expect(JSON.stringify(list.body)).not.toContain('must-not-be-returned');
    expect(JSON.stringify(list.body)).not.toContain('ignoredSecret');

    const detail = api.getProvider('fake');
    expect(detail.statusCode).toBe(200);
    if (detail.statusCode === 200) {
      expect(detail.body.provider.openActionIntents).toHaveLength(1);
      expect(detail.body.provider.openActionIntents[0]).toMatchObject({
        id: 'intent-1',
        scheduledFor: NOW,
        notBefore: null,
        expiresAt: '2026-09-19T12:00:30.000Z',
      });
    }
    expect(inspected.count).toBe(0);
    expect(repositories.providers.get('fake')).toBeDefined();
  });

  it('returns explicit errors for invalid and unknown provider ids', () => {
    const { api } = createApi((repositories) => seedObservedProvider(repositories));

    expect(api.getProvider('not valid').statusCode).toBe(400);
    expect(api.getProvider('missing').statusCode).toBe(404);
    expect(api.getProvider(42).statusCode).toBe(400);
  });

  it('renders unknown provider state and tolerates invalid adapter capabilities', () => {
    const { api } = createApi(
      (repositories) => {
        repositories.providers.upsert(providerRecord({ id: 'fake' }));
      },
      {
        id: 'fake',
        capabilities: () => ({}) as ProviderCapabilities,
        health: () => Promise.resolve('UP'),
        inspect: () => Promise.resolve(observation()),
      },
    );

    const list = api.getProviders();
    const firstProvider = list.body.providers[0];
    expect(firstProvider).toBeDefined();
    if (!firstProvider) throw new Error('expected fake provider');
    expect(firstProvider).toMatchObject({
      health: 'UNKNOWN',
      observation: null,
      windows: [],
      freshness: { observedAt: null, ageSeconds: null, staleAfterSeconds: null, stale: true },
      nextDecision: null,
    });
    expect(firstProvider.capabilities).toBeUndefined();
  });

  it('filters bounded history and strips untrusted event data', () => {
    const { api } = createApi((repositories) => {
      seedObservedProvider(repositories);
      repositories.events.append({
        occurredAtMs: Date.parse('2026-09-19T10:00:00.000Z'),
        providerId: 'fake',
        type: 'provider_inspected',
        severity: 'info',
        reasonCode: null,
        data: { health: 'UP', windowKinds: ['five_hour'], secret: 'do not expose' },
      });
      repositories.providers.upsert(providerRecord({ id: 'other', kind: 'other' }));
      repositories.events.append({
        occurredAtMs: Date.parse('2026-09-19T11:00:00.000Z'),
        providerId: 'fake',
        type: 'scheduler_noop',
        severity: 'warn',
        reasonCode: 'WINDOW_NOT_INACTIVE',
        data: {
          explanation: { reasonCode: 'WINDOW_NOT_INACTIVE', phase: 'ACTIVE' },
          password: 'do not expose',
        },
      });
      repositories.events.append({
        occurredAtMs: Date.parse('2026-09-19T12:00:00.000Z'),
        providerId: 'other',
        type: 'scheduler_noop',
        severity: 'info',
        reasonCode: null,
        data: {},
      });
    });

    const filtered = api.getHistory({
      provider: 'fake',
      type: 'scheduler_noop',
      from: '2026-09-19T11:00:00.000Z',
      to: '2026-09-19T11:00:00.000Z',
      limit: '1',
    });
    expect(filtered.statusCode).toBe(200);
    if (filtered.statusCode === 200) {
      expect(filtered.body.limit).toBe(1);
      expect(filtered.body.events).toMatchObject([
        {
          providerId: 'fake',
          type: 'scheduler_noop',
          occurredAt: '2026-09-19T11:00:00.000Z',
          data: { explanation: { reasonCode: 'WINDOW_NOT_INACTIVE', phase: 'ACTIVE' } },
        },
      ]);
      expect(JSON.stringify(filtered.body)).not.toContain('password');
    }

    const all = api.getHistory({});
    expect(all.statusCode).toBe(200);
    if (all.statusCode === 200) expect(all.body.events).toHaveLength(3);
  });

  it('rejects invalid history filters and enforces the maximum limit', () => {
    const { api } = createApi((repositories) => seedObservedProvider(repositories));

    expect(api.getHistory({ limit: '0' }).statusCode).toBe(400);
    expect(api.getHistory({ limit: '501' }).statusCode).toBe(400);
    expect(api.getHistory({ limit: 'NaN' }).statusCode).toBe(400);
    expect(api.getHistory({ unknown: 'field' }).statusCode).toBe(400);
    expect(
      api.getHistory({
        from: '2026-09-20T00:00:00.000Z',
        to: '2026-09-19T00:00:00.000Z',
      }).statusCode,
    ).toBe(400);

    const result = api.getHistory({ limit: '500' });
    expect(result.statusCode).toBe(200);
    if (result.statusCode === 200) expect(result.body.limit).toBe(500);
  });

  it('returns only allowlisted, validated runtime settings', () => {
    const { api, repositories } = createApi((repository) => {
      repository.settings.set('timezone', 'America/Sao_Paulo', Date.parse(NOW));
      repository.settings.set('retention_window_samples_days', 90, Date.parse(NOW) + 1);
      repository.settings.set('secret_token', 'synthetic-not-a-secret', Date.parse(NOW) + 2);
      repository.settings.set('timezone', 'not/a-timezone', Date.parse(NOW) + 3);
      repository.settings.set('arbitrary_object', { token: 'do not expose' }, Date.parse(NOW) + 4);
    });

    const result = api.getSettings();
    expect(result.statusCode).toBe(200);
    expect(result.body.settings).toEqual([
      {
        key: 'retention_window_samples_days',
        value: 90,
        updatedAt: '2026-09-19T12:00:00.001Z',
      },
    ]);
    expect(JSON.stringify(result.body)).not.toContain('synthetic-not-a-secret');

    repositories.settings.set('timezone', 'America/Sao_Paulo', Date.parse(NOW) + 5);
    const restored = api.getSettings();
    expect(restored.body.settings).toEqual([
      {
        key: 'retention_window_samples_days',
        value: 90,
        updatedAt: '2026-09-19T12:00:00.001Z',
      },
      {
        key: 'timezone',
        value: 'America/Sao_Paulo',
        updatedAt: '2026-09-19T12:00:00.005Z',
      },
    ]);
  });

  it('projects the fallback decision from a durable open intent', () => {
    const { api } = createApi((repositories) => {
      seedObservedProvider(repositories);
      repositories.schedulePolicies.upsert({
        id: 'policy-1',
        providerId: 'fake',
        kind: 'target_reset',
        enabled: true,
        timezone: 'America/Sao_Paulo',
        config: {},
        createdAtMs: Date.parse(NOW),
        updatedAtMs: Date.parse(NOW),
      });
      repositories.actionIntents.createIfAbsent(intent());
    });

    const result = api.getProviders();
    expect(result.body.providers[0]?.nextDecision).toMatchObject({
      decision: 'create_intent',
      eventType: 'action_intent',
      reasonCode: 'TARGET_RESET_WINDOW_MATCH',
    });
  });
});
