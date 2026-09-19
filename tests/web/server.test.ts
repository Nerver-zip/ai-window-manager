import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
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
  type ProviderRecord,
  type StorageRepositories,
} from '../../src/storage/repositories.js';
import { buildServer } from '../../src/web/server.js';

const resources: Array<{
  app: ReturnType<typeof buildServer>;
  db: SqliteDatabase;
  dir: string;
}> = [];

const NOW = '2026-09-14T11:00:00.000Z';

const capabilities: ProviderCapabilities = {
  usageRead: { supported: true, contract: 'official_client_internal' },
  resetRead: { supported: true, contract: 'official_client_internal' },
  windowTrigger: { supported: false, contract: 'unknown', consumesQuota: 'unknown' },
};

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

function createApp(
  seed: (repositories: StorageRepositories, clock: FakeClock) => void,
  adapter: ProviderAdapter | undefined = inspectionSpy('fake'),
  requestReconcile?: () => void,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-web-'));
  const dbPath = path.join(dir, 'awm.db');
  const db = openDatabase(dbPath);
  const clock = new FakeClock(NOW);
  const repositories = createRepositories(db);
  seed(repositories, clock);
  const app = buildServer({
    config: loadConfig({ AWM_DB_PATH: dbPath, AWM_LOG_LEVEL: 'silent' }),
    db,
    repositories,
    adapters: adapter ? new Map([[adapter.id, adapter]]) : new Map(),
    clock,
    ...(requestReconcile ? { requestReconcile } : {}),
  });
  resources.push({ app, db, dir });
  return { app, clock, repositories };
}

function providerRecord(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'fake',
    kind: 'fake',
    enabled: true,
    mode: 'monitor_only',
    pollIntervalSeconds: 300,
    config: { syntheticSecret: 'not-a-real-secret' },
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
      return Promise.reject(new Error('HTTP handlers must not inspect providers'));
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
    durationSeconds: {
      value: 18_000,
      source: 'official_client_internal',
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
      source: 'observed',
      confidence: 'exact',
      observedAt,
    },
    resetAt: {
      value: '2026-09-14T16:00:00.000Z',
      source: 'inferred',
      confidence: 'high',
      observedAt,
    },
  };
  return {
    providerId,
    health: 'UP',
    observedAt,
    staleAfterSeconds: 300,
    summary: '<script>persisted text</script>',
    windows: [window],
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

describe('web server persisted overview', () => {
  it('serves persisted API and HTML without provider inspection', async () => {
    const inspected = { count: 0 };
    const { app } = createApp(
      (repositories) => seedObservedProvider(repositories),
      inspectionSpy('fake', inspected),
    );

    const api = await app.inject('/api/v1/providers');
    expect(api.statusCode).toBe(200);
    expect(api.json()).toMatchObject({
      providers: [
        {
          id: 'fake',
          kind: 'fake',
          enabled: true,
          mode: 'monitor_only',
          health: 'UP',
          observation: { health: 'UP', windows: [{ phase: { value: 'INACTIVE' } }] },
          windows: [{ windowKind: 'five_hour' }],
          freshness: { ageSeconds: 0, stale: false },
          capabilities: { usageRead: { supported: true } },
        },
      ],
    });
    expect(api.body).not.toContain('syntheticSecret');
    expect(api.body).not.toContain('not-a-real-secret');

    const page = await app.inject('/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Health</dt><dd>UP');
    expect(page.body).toContain('Remaining');
    expect(page.body).toContain('75%');
    expect(page.body).toContain('~2026-09-14T16:00:00.000Z');
    expect(page.body).toContain('official_client_internal · high');
    expect(page.body).not.toContain('<script>persisted text</script>');
    expect(inspected.count).toBe(0);
  });

  it('renders the persisted scheduler explanation and escapes its text', async () => {
    const { app } = createApp((repository) => {
      seedObservedProvider(repository);
      repository.events.append({
        occurredAtMs: Date.parse(NOW),
        providerId: 'fake',
        type: 'scheduler_noop',
        severity: 'info',
        reasonCode: 'WINDOW_DURATION_CONFIDENCE_TOO_LOW',
        data: {
          explanation: {
            decision: 'noop',
            reasonCode: 'WINDOW_DURATION_CONFIDENCE_TOO_LOW',
            providerId: 'fake',
            policyId: 'policy-1',
            desiredResetLocal: '<script>alert(1)</script>',
          },
          ignoredSecret: 'must not be surfaced',
        },
      });
    });

    const api = await app.inject('/api/v1/providers');
    expect(api.json()).toMatchObject({
      providers: [
        {
          nextDecision: {
            decision: 'noop',
            reasonCode: 'WINDOW_DURATION_CONFIDENCE_TOO_LOW',
            explanation: {
              desiredResetLocal: '<script>alert(1)</script>',
            },
          },
        },
      ],
    });
    expect(api.body).not.toContain('ignoredSecret');

    const page = await app.inject('/');
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.body).not.toContain('<script>alert(1)</script>');
    expect(page.body).toContain('WINDOW_DURATION_CONFIDENCE_TOO_LOW');
  });

  it('shows explicit stale and unknown values for missing or old state', async () => {
    const { app } = createApp((repositories) => {
      repositories.providers.upsert(providerRecord({ id: 'missing', kind: '<unsafe-kind>' }));
      seedObservedProvider(repositories, 'fake', '2026-09-14T10:00:00.000Z');
    });

    const api = await app.inject('/api/v1/providers');
    expect(api.json()).toMatchObject({
      providers: [
        { id: 'fake', freshness: { ageSeconds: 3600, stale: true } },
        {
          id: 'missing',
          health: 'UNKNOWN',
          observation: null,
          windows: [],
          freshness: { ageSeconds: null, stale: true },
          nextDecision: null,
        },
      ],
    });

    const page = await app.inject('/');
    expect(page.body).toContain('STALE');
    expect(page.body).toContain('STALE · never observed');
    expect(page.body).toContain('Window: unknown');
    expect(page.body).toContain('Health</dt><dd>UNKNOWN');
    expect(page.body).toContain('&lt;unsafe-kind&gt;');
    expect(page.body).not.toContain('<unsafe-kind>');
    expect(page.body).toContain('unknown');
  });

  it('keeps health and metrics side-effect free', async () => {
    const inspected = { count: 0 };
    const { app } = createApp(
      (repositories) => seedObservedProvider(repositories),
      inspectionSpy('fake', inspected),
    );

    const health = await app.inject('/healthz');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['content-security-policy']).toContain("default-src 'self'");

    const metrics = await app.inject('/metrics');
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toContain('ai_window_process_');
    expect(inspected.count).toBe(0);
  });

  it('returns service unavailable when the database health query fails', async () => {
    const db = {
      prepare: () => {
        throw new Error('database unavailable');
      },
    } as unknown as SqliteDatabase;
    const app = buildServer({
      config: loadConfig({ AWM_LOG_LEVEL: 'silent' }),
      db,
      repositories: createRepositories(db),
      adapters: new Map(),
      clock: new FakeClock(NOW),
    });

    const response = await app.inject('/healthz');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error' });
    await app.close();
  });

  it('serves provider detail, bounded history and allowlisted settings from SQLite', async () => {
    const { app } = createApp((repositories) => {
      seedObservedProvider(repositories);
      repositories.settings.set('timezone', 'America/Sao_Paulo', Date.parse(NOW));
      repositories.settings.set('secret_token', 'synthetic-not-a-secret', Date.parse(NOW));
      repositories.events.append({
        occurredAtMs: Date.parse(NOW),
        providerId: 'fake',
        type: 'provider_inspected',
        severity: 'info',
        reasonCode: null,
        data: { health: 'UP' },
      });
    });

    expect((await app.inject('/api/v1/providers/fake')).statusCode).toBe(200);
    const history = await app.inject('/api/v1/history?provider=fake&limit=1');
    expect(history.statusCode).toBe(200);
    const historyBody = JSON.parse(history.body) as { events: unknown[] };
    expect(historyBody.events).toHaveLength(1);
    const settings = await app.inject('/api/v1/settings');
    expect(settings.statusCode).toBe(200);
    expect(settings.body).toContain('America/Sao_Paulo');
    expect(settings.body).not.toContain('synthetic-not-a-secret');
  });

  it('protects inspect and trigger commands with Origin and CSRF without provider I/O in handlers', async () => {
    const inspected = { count: 0 };
    const triggered = { count: 0 };
    let reconcileRequested = 0;
    const commandAdapter: ProviderAdapter = {
      id: 'fake',
      capabilities: () => ({
        ...capabilities,
        windowTrigger: { supported: true, contract: 'official_supported', consumesQuota: false },
      }),
      health: () => Promise.resolve('UP'),
      inspect: () => {
        inspected.count += 1;
        return Promise.reject(new Error('handler must not inspect'));
      },
      triggerWindow: () => {
        triggered.count += 1;
        return Promise.reject(new Error('handler must not trigger'));
      },
    };
    const { app } = createApp(
      (repositories) => {
        seedObservedProvider(repositories);
        const provider = repositories.providers.get('fake');
        if (!provider) throw new Error('provider missing');
        repositories.providers.upsert({ ...provider, mode: 'automation' });
      },
      commandAdapter,
      () => {
        reconcileRequested += 1;
      },
    );

    const page = await app.inject({ method: 'GET', url: '/', headers: { host: 'localhost:8787' } });
    const setCookie = page.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
    const token = cookie?.split('=')[1];
    expect(cookie).toContain('awm_csrf=');
    expect(token).toBeTruthy();

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/fake/inspect',
      headers: { host: 'localhost:8787', origin: 'https://evil.example', cookie },
    });
    expect(missing.statusCode).toBe(403);

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/fake/inspect',
      headers: { host: 'localhost:8787', origin: 'http://localhost:8787', cookie },
    });
    expect(missingCsrf.statusCode).toBe(403);

    const inspect = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/fake/inspect',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'x-csrf-token': token,
      },
    });
    expect(inspect.statusCode).toBe(202);
    expect(reconcileRequested).toBe(1);
    expect(inspected.count).toBe(0);

    const trigger = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/fake/trigger',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'x-csrf-token': token,
        'content-type': 'application/json',
      },
      payload: { idempotencyKey: 'server-test' },
    });
    expect(trigger.statusCode).toBe(202);
    expect(triggered.count).toBe(0);
  });
});
