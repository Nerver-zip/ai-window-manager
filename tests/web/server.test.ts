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
  kind = 'fake',
): void {
  repositories.providers.upsert(providerRecord({ id: providerId, kind }));
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
  it('renders an empty workspace with useful navigation', async () => {
    const { app } = createApp(() => {});
    const response = await app.inject('/');
    expect(response.body).toContain('No providers are being monitored');
    expect(response.body).toContain('aria-current="page"');
    expect(response.body).toContain('Providers monitored');
  });

  it.each(['/settings', '/schedule', '/history'])(
    'serves %s in the shared shell',
    async (route) => {
      const { app } = createApp((repositories) => seedObservedProvider(repositories));
      const response = await app.inject(route);

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('href="/assets/app.css"');
      expect(response.body).toContain('<script defer src="/assets/app.js"></script>');
      expect(response.body).not.toMatch(/<style|style=|<script>/);
      expect(response.body).toContain('aria-current="page"');
    },
  );

  it('serves static images and favicon safely with cache headers', async () => {
    const { app } = createApp(() => {});
    const logo = await app.inject('/assets/images/logo.png');
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.headers['cache-control']).toContain('public');

    const codex = await app.inject('/assets/images/providers/codex.png');
    expect(codex.statusCode).toBe(200);
    expect(codex.headers['content-type']).toBe('image/png');

    const agy = await app.inject('/assets/images/providers/agy.png');
    expect(agy.statusCode).toBe(200);
    expect(agy.headers['content-type']).toBe('image/png');

    const favicon = await app.inject('/favicon.ico');
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers['content-type']).toBe('image/png');

    const invalidMime = await app.inject('/assets/images/invalid.txt');
    expect(invalidMime.statusCode).toBe(404);

    const dirRequest = await app.inject('/assets/images/providers');
    expect(dirRequest.statusCode).toBe(404);

    const notFound = await app.inject('/assets/images/non-existent.png');
    expect(notFound.statusCode).toBe(404);

    const traversal = await app.inject('/assets/images/../../package.json');
    expect(traversal.statusCode).toBe(404);
  });

  it('renders provider cards with provider logos when available', async () => {
    const { app } = createApp((repositories) => {
      seedObservedProvider(repositories, 'fake', NOW, 'fake');
      seedObservedProvider(repositories, 'codex', NOW, 'codex');
    });
    const page = await app.inject('/');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('/assets/images/providers/codex.png');
    expect(page.body).toContain('Test provider');
    expect(page.body).toContain('Codex');
  });

  it.each(['AUTH_REQUIRED', 'UNAVAILABLE'] as const)(
    'shows a human status for %s without a fabricated zero',
    async (health) => {
      const { app } = createApp((repositories) => {
        seedObservedProvider(repositories);
        const state = repositories.providerState.get('fake');
        if (!state?.observation) throw new Error('missing observation');
        const window = state.observation.windows[0];
        if (!window) throw new Error('missing window');
        delete window.usageRatio;
        delete window.durationSeconds;
        repositories.providerState.upsert({ ...state, health, lastErrorCode: health });
      });
      const page = await app.inject('/');
      expect(page.body).toContain(
        health === 'AUTH_REQUIRED' ? 'Sign-in required' : 'Needs attention',
      );
      expect(page.body).toContain('Usage has not been reported yet');
      expect(page.body).not.toContain('<progress');
    },
  );

  it('presents planned intents with human explanations and disclosure details', async () => {
    const { app } = createApp((repositories) => {
      seedObservedProvider(repositories);
      repositories.providers.upsert(providerRecord({ mode: 'automation' }));
      repositories.events.append({
        providerId: 'fake',
        occurredAtMs: Date.parse(NOW),
        type: 'action_intent_planned',
        severity: 'info',
        reasonCode: 'TARGET_RESET_WINDOW_MATCH',
        data: { explanation: { targetTriggerAt: NOW } },
      });
    });
    const page = await app.inject('/');
    expect(page.body).toContain('Automatic action planned');
    expect(page.body).toContain('The window can start before the target reset.');
    expect(page.body).not.toContain('<summary>Technical details</summary>');
  });

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
    expect(page.body).toContain('href="/assets/app.css"');
    expect(page.body).toContain('<script defer src="/assets/app.js"></script>');
    expect(page.body).not.toMatch(/<style|style=|<script>/);
    expect(page.body).toContain('value="25"');
    expect(page.body).toContain('<progress');
    const css = await app.inject('/assets/app.css');
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.headers['content-security-policy']).not.toContain('unsafe-inline');
    const javascript = await app.inject('/assets/app.js');
    expect(javascript.statusCode).toBe(200);
    expect(javascript.headers['content-type']).toContain('application/javascript');
    expect(javascript.body).toContain('data-chart-point');
    expect(page.body).toContain('Status</dt><dd>Connected');
    expect(page.body).toContain('Remaining');
    expect(page.body).toContain('75%');
    expect(page.body).toContain('Why this time is shown');
    expect(page.body).toContain('Reset in approximately 5 hours');
    expect(page.body).toContain('Reported by provider · Good confidence');
    expect(page.body).not.toContain('official_client_internal');
    expect(page.body).not.toContain('five_hour');
    expect(page.body).not.toContain('<script>persisted text</script>');
    expect(inspected.count).toBe(0);
  });

  it('renders approximate reset timing for future, past, short and long windows', async () => {
    const { app } = createApp((repositories) => {
      const current = observation('coverage');
      const baseWindow = current.windows[0];
      if (!baseWindow?.resetAt) throw new Error('coverage window missing reset fact');
      const baseReset = baseWindow.resetAt;
      const resetWindow = (windowKind: string, value?: string): WindowSnapshot => {
        if (value === undefined) {
          const withoutReset = { ...baseWindow };
          delete withoutReset.resetAt;
          return { ...withoutReset, windowKind };
        }
        return { ...baseWindow, windowKind, resetAt: { ...baseReset, value } };
      };
      current.windows = [
        resetWindow('future-minute', '2026-09-14T11:05:00.000Z'),
        resetWindow('future-second', '2026-09-14T11:00:30.000Z'),
        resetWindow('future-day', '2026-09-16T11:00:00.000Z'),
        resetWindow('past-hour', '2026-09-14T10:00:00.000Z'),
        resetWindow('missing-reset'),
      ];
      const observedAtMs = Date.parse(NOW);
      repositories.providers.upsert(providerRecord({ id: 'coverage' }));
      repositories.providerState.upsert({
        providerId: 'coverage',
        health: 'UP',
        observedAtMs,
        staleAfterMs: current.staleAfterSeconds * 1000,
        observation: current,
        lastSuccessAtMs: observedAtMs,
        lastErrorCode: null,
        updatedAtMs: observedAtMs,
      });
    });

    const page = await app.inject('/');
    expect(page.body).toContain('Reset in approximately 5 minutes');
    expect(page.body).toContain('Reset in approximately 30 seconds');
    expect(page.body).toContain('Reset in approximately 2 days');
    expect(page.body).toContain('Reset approximately 1 hour ago');
    expect(page.body).toContain('Reset</dt><dd><span class="unknown">Not available yet</span>');
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
    expect(page.body).not.toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.body).not.toContain('<script>alert(1)</script>');
    expect(page.body).toContain('The window duration is not reliable enough yet.');
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
    expect(page.body).toContain('Waiting for the first update');
    expect(page.body).toContain('Waiting for first observation');
    expect(page.body).not.toContain('&lt;unsafe-kind&gt;');
    expect(page.body).not.toContain('<unsafe-kind>');
    expect(page.body).toContain('Usage windows will appear after the provider is checked.');
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
      const current = observation();
      const window = current.windows[0];
      if (!window) throw new Error('test observation window missing');
      repositories.windowSamples.insert(window);
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
      for (let index = 1; index <= 21; index += 1) {
        repositories.events.append({
          occurredAtMs: Date.parse(NOW) - index * 1_000,
          providerId: 'fake',
          type: 'scheduler_noop',
          severity: 'info',
          reasonCode: 'TARGET_NOT_DUE',
          data: {},
        });
      }
    });

    expect((await app.inject('/api/v1/providers/fake')).statusCode).toBe(200);
    const history = await app.inject('/api/v1/history?provider=fake&limit=1');
    expect(history.statusCode).toBe(200);
    const historyBody = JSON.parse(history.body) as { events: unknown[] };
    expect(historyBody.events).toHaveLength(1);
    const historyPage = await app.inject('/history?range=24h&provider=fake');
    expect(historyPage.statusCode).toBe(200);
    expect(historyPage.headers['content-type']).toContain('text/html');
    expect(historyPage.body).toContain('Timeline');
    expect(historyPage.body).toContain('Usage');
    expect(historyPage.body).toContain('25%');
    expect(historyPage.body).toContain('page=2');
    const historyPageTwo = await app.inject('/history?range=24h&provider=fake&page=2');
    expect(historyPageTwo.statusCode).toBe(200);
    expect(historyPageTwo.body).toContain('rel="prev"');
    expect(historyPage.body).not.toContain('synthetic-not-a-secret');
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
