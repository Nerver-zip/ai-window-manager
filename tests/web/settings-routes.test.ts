import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories, type ProviderRecord } from '../../src/storage/repositories.js';
import { buildServer } from '../../src/web/server.js';

const resources: Array<{
  app: ReturnType<typeof buildServer>;
  db: ReturnType<typeof openDatabase>;
  dir: string;
}> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-settings-routes-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  const clock = new FakeClock('2026-09-19T12:00:00.000Z');
  const fake = new FakeProvider(clock);
  const provider: ProviderRecord = {
    id: 'fake',
    kind: 'fake',
    enabled: true,
    mode: 'monitor_only',
    pollIntervalSeconds: 300,
    config: {},
    configVersion: 1,
    createdAtMs: clock.now().getTime(),
    updatedAtMs: clock.now().getTime(),
  };
  repositories.providers.upsert(provider);
  const app = buildServer({
    config: loadConfig({
      AWM_DB_PATH: path.join(dir, 'awm.db'),
      AWM_LOG_LEVEL: 'silent',
      AWM_FAKE_PROVIDER_ENABLED: 'true',
    }),
    db,
    repositories,
    adapters: new Map([['fake', fake]]),
    clock,
  });
  resources.push({ app, db, dir });
  return { app, repositories };
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

describe('settings and schedule pages', () => {
  it('renders forms and persists same-origin CSRF-protected updates', async () => {
    const context = setup();
    const page = await context.app.inject({
      method: 'GET',
      url: '/settings',
      headers: { host: 'localhost:8787' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Check for updates');
    const cookie = headerValue(page.headers['set-cookie']);
    const token = /awm_csrf=([^;]+)/.exec(cookie)?.[1];
    if (!token) throw new Error('csrf token missing');

    const update = await context.app.inject({
      method: 'POST',
      url: '/settings/providers/fake',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrfToken=${token}&enabled=on&mode=monitor_only&refreshIntervalPreset=300`,
    });
    expect(update.statusCode).toBe(303);
    expect(context.repositories.providers.get('fake')).toMatchObject({ pollIntervalSeconds: 300 });

    const customInterval = await context.app.inject({
      method: 'POST',
      url: '/settings/providers/fake',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrfToken=${token}&enabled=on&mode=monitor_only&refreshIntervalPreset=custom&customPollIntervalSeconds=450`,
    });
    expect(customInterval.statusCode).toBe(303);
    expect(context.repositories.providers.get('fake')).toMatchObject({ pollIntervalSeconds: 450 });

    const schedule = await context.app.inject({
      method: 'POST',
      url: '/schedule',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrfToken=${token}&enabled=on&providerId=fake&windowKind=five_hour&targetResetLocalTime=13%3A00&timezone=America%2FSao_Paulo&toleranceSeconds=30`,
    });
    expect(schedule.statusCode).toBe(303);
    expect(context.repositories.schedulePolicies.list('fake')).toHaveLength(1);

    const savedSchedule = await context.app.inject({
      method: 'GET',
      url: '/schedule?updated=schedule',
      headers: { host: 'localhost:8787', cookie },
    });
    expect(savedSchedule.statusCode).toBe(200);
    expect(savedSchedule.body).toContain('Schedule saved.');

    const invalidProvider = await context.app.inject({
      method: 'POST',
      url: '/settings/providers/fake',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrfToken=${token}&mode=invalid&pollIntervalSeconds=1`,
    });
    expect(invalidProvider.statusCode).toBe(400);

    const invalidSchedule = await context.app.inject({
      method: 'POST',
      url: '/schedule',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrfToken=${token}&providerId=fake&windowKind=bad%20kind&targetResetLocalTime=13%3A00&timezone=Not%2FAZone&toleranceSeconds=30`,
    });
    expect(invalidSchedule.statusCode).toBe(400);
  });

  it('rejects settings mutations without the same-origin CSRF proof', async () => {
    const context = setup();
    const response = await context.app.inject({
      method: 'POST',
      url: '/settings/providers/fake',
      headers: { host: 'localhost:8787', origin: 'http://localhost:8787' },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });
  });

  it('saves a friendly timezone choice and a custom IANA timezone through the same protected form', async () => {
    const context = setup();
    const page = await context.app.inject({
      method: 'GET',
      url: '/settings',
      headers: { host: 'localhost:8787' },
    });
    const cookie = headerValue(page.headers['set-cookie']);
    const token = /awm_csrf=([^;]+)/.exec(cookie)?.[1];
    if (!token) throw new Error('csrf token missing');

    const headers = {
      host: 'localhost:8787',
      origin: 'http://localhost:8787',
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
    };
    const preset = await context.app.inject({
      method: 'POST',
      url: '/settings/timezone',
      headers,
      payload: `csrfToken=${token}&timezoneChoice=America%2FNew_York&customTimezone=&source=manual`,
    });
    expect(preset.statusCode).toBe(303);
    expect(context.repositories.settings.get('timezone')?.value).toBe('America/New_York');

    const custom = await context.app.inject({
      method: 'POST',
      url: '/settings/timezone',
      headers,
      payload: `csrfToken=${token}&timezoneChoice=custom&customTimezone=Europe%2FMadrid&source=manual`,
    });
    expect(custom.statusCode).toBe(303);
    expect(context.repositories.settings.get('timezone')?.value).toBe('Europe/Madrid');

    const invalidCustom = await context.app.inject({
      method: 'POST',
      url: '/settings/timezone',
      headers,
      payload: `csrfToken=${token}&timezoneChoice=custom&customTimezone=Not%2FAZone&source=manual`,
    });
    expect(invalidCustom.statusCode).toBe(400);
    expect(context.repositories.settings.get('timezone')?.value).toBe('Europe/Madrid');
  });
});
