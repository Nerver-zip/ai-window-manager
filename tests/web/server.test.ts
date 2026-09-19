import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { ProviderCapabilities, ProviderObservation } from '../../src/domain/types.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import { buildServer } from '../../src/web/server.js';

const resources: Array<{
  app: ReturnType<typeof buildServer>;
  db: SqliteDatabase;
  dir: string;
}> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

function createApp(providers: ProviderAdapter[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-web-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const app = buildServer({
    config: loadConfig({ AWM_DB_PATH: path.join(dir, 'awm.db'), AWM_LOG_LEVEL: 'silent' }),
    db,
    providers,
  });
  resources.push({ app, db, dir });
  return app;
}

const capabilities: ProviderCapabilities = {
  usageRead: { supported: true, contract: 'observed' },
  resetRead: { supported: false, contract: 'unknown' },
  windowTrigger: { supported: false, contract: 'unknown' },
};

describe('web server', () => {
  it('serves health, metrics, provider JSON, and escaped HTML', async () => {
    const provider = new FakeProvider(new FakeClock('2026-09-14T11:00:00Z'), {
      id: `&<>'"`,
    });
    const app = createApp([provider]);

    const health = await app.inject('/healthz');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['content-security-policy']).toContain("default-src 'self'");

    const api = await app.inject('/api/v1/providers');
    expect(api.statusCode).toBe(200);
    expect(api.json()).toMatchObject({
      providers: [
        {
          observation: { health: 'UP', windows: [{ phase: 'INACTIVE' }] },
          capabilities: { windowTrigger: { supported: true } },
        },
      ],
    });

    const metrics = await app.inject('/metrics');
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toContain('ai_window_provider_up');

    const page = await app.inject('/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('&amp;&lt;&gt;&#39;&quot;');
    expect(page.body).toContain('Remaining: 100%');
    expect(page.body).toContain('Reset: unknown');
  });

  it('renders an active fake window and exports its optional reset metrics', async () => {
    const provider = new FakeProvider(new FakeClock('2026-09-14T11:00:00Z'));
    const app = createApp([provider]);
    await provider.triggerWindow({}, { intentId: 'i1', dedupeKey: 'd1', reasonCode: 'test' });

    const api = await app.inject('/api/v1/providers');
    expect(api.json()).toMatchObject({
      providers: [{ observation: { windows: [{ phase: 'ACTIVE' }] } }],
    });

    const page = await app.inject('/');
    expect(page.body).toContain('Remaining: 99%');
    expect(page.body).not.toContain('Reset: unknown');

    const metrics = await app.inject('/metrics');
    expect(metrics.body).toContain('ai_window_usage_ratio');
    expect(metrics.body).toContain('ai_window_remaining_ratio');
  });

  it('represents degraded providers and missing optional window values safely', async () => {
    const observation: ProviderObservation = {
      providerId: `&<>'"`,
      health: 'DEGRADED',
      observedAt: '2026-09-14T11:00:00.000Z',
      staleAfterSeconds: 10,
      windows: [
        {
          providerId: `&<>'"`,
          windowKind: 'five_hour',
          phase: 'UNKNOWN',
          observedAt: '2026-09-14T11:00:00.000Z',
        },
      ],
    };
    const provider: ProviderAdapter = {
      id: `&<>'"`,
      capabilities: () => capabilities,
      health: () => Promise.resolve('DEGRADED'),
      inspect: () => Promise.resolve(observation),
    };
    const app = createApp([provider]);

    const api = await app.inject('/api/v1/providers');
    expect(api.json()).toMatchObject({
      providers: [{ observation: { health: 'DEGRADED', windows: [{ phase: 'UNKNOWN' }] } }],
    });

    const page = await app.inject('/');
    expect(page.body).toContain('Remaining: unknown');
    expect(page.body).toContain('Reset: unknown');
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
      providers: [],
    });

    const response = await app.inject('/healthz');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error' });
    await app.close();
  });
});
