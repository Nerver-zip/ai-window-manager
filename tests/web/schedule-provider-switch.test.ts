import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import {
  createRepositories,
  type ProviderRecord,
  type SchedulePolicyRecord,
  type StorageRepositories,
} from '../../src/storage/repositories.js';
import { APP_JS } from '../../src/web/ui/chart-interactions.js';
import { buildServer } from '../../src/web/server.js';

const now = '2026-09-24T12:00:00.000Z';
const resources: Array<{
  app: ReturnType<typeof buildServer>;
  db: SqliteDatabase;
  directory: string;
}> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    resource.db.close();
    fs.rmSync(resource.directory, { recursive: true, force: true });
  }
});

function createScheduleApp(requestReconcile: () => void = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-provider-switch-'));
  const dbPath = path.join(directory, 'awm.db');
  const db = openDatabase(dbPath);
  const repositories = createRepositories(db);
  const clock = new FakeClock(now);
  seedProvider(repositories, 'codex', 'codex');
  seedProvider(repositories, 'antigravity', 'antigravity');
  seedPolicy(repositories, 'codex', 'fixed', {
    windowKind: 'five_hour',
    anchorLocalTime: '17:00',
    toleranceSeconds: 900,
  });
  seedPolicy(repositories, 'antigravity', 'custom_schedule', {
    windowKind: 'weekly',
    times: ['09:30'],
    toleranceSeconds: 600,
  });
  const app = buildServer({
    config: loadConfig({
      AWM_DB_PATH: dbPath,
      AWM_LOG_LEVEL: 'silent',
      AWM_FAKE_PROVIDER_ENABLED: 'false',
    }),
    db,
    repositories,
    adapters: new Map(),
    clock,
    requestReconcile,
  });
  resources.push({ app, db, directory });
  return { app, repositories };
}

function seedProvider(repositories: StorageRepositories, id: string, kind: string): void {
  repositories.providers.upsert({
    id,
    kind,
    enabled: true,
    mode: 'monitor_only',
    pollIntervalSeconds: 300,
    config: {},
    configVersion: 1,
    createdAtMs: Date.parse(now),
    updatedAtMs: Date.parse(now),
  } satisfies ProviderRecord);
}

function seedPolicy(
  repositories: StorageRepositories,
  providerId: string,
  kind: SchedulePolicyRecord['kind'],
  config: unknown,
): void {
  repositories.schedulePolicies.upsert({
    id: `activation-${providerId}`,
    providerId,
    kind,
    enabled: true,
    timezone: 'America/Sao_Paulo',
    config,
    createdAtMs: Date.parse(now),
    updatedAtMs: Date.parse(now),
  });
}

function schedulePolicy(repositories: StorageRepositories, providerId: string) {
  return repositories.schedulePolicies
    .list(providerId)
    .find((policy) => policy.id === `activation-${providerId}`);
}

describe('schedule provider switching', () => {
  it('loads each provider policy via a read-only GET without JavaScript', async () => {
    let reconcileRequests = 0;
    const { app, repositories } = createScheduleApp(() => {
      reconcileRequests += 1;
    });
    const beforeCodex = schedulePolicy(repositories, 'codex');
    const beforeAntigravity = schedulePolicy(repositories, 'antigravity');

    const codexPage = await app.inject('/schedule?providerId=codex');
    expect(codexPage.statusCode).toBe(200);
    expect(codexPage.body).toMatch(
      /name="providerId" value="codex" checked|<option value="codex" selected>/,
    );
    expect(codexPage.body).toContain('name="policyKind" value="fixed" checked');
    expect(codexPage.body).toContain('name="anchorLocalTime" type="time" value="17:00"');

    const antigravityPage = await app.inject('/schedule?providerId=antigravity');
    expect(antigravityPage.statusCode).toBe(200);
    expect(antigravityPage.body).toMatch(
      /name="providerId" value="antigravity" checked|<option value="antigravity" selected>/,
    );
    expect(antigravityPage.body).toContain('name="policyKind" value="custom_schedule" checked');
    expect(antigravityPage.body).toContain('value="09:30"');

    const selector = antigravityPage.body.match(
      /<form class="schedule-provider-selection"[\s\S]*?<\/form>/,
    )?.[0];
    expect(selector).toContain('method="get" action="/schedule"');
    expect(selector).toContain(
      '<noscript><div class="form-actions"><button type="submit">View provider schedule</button>',
    );
    expect(selector).toMatch(/<select[^>]*name="providerId"|type="radio"[^>]*name="providerId"/);
    expect(selector).toContain('name="providerId"');
    const saveForm = antigravityPage.body.match(
      /<form method="post" action="\/schedule"[\s\S]*?<\/form>/,
    )?.[0];
    expect(saveForm).toContain('type="hidden" name="providerId" value="antigravity"');
    expect(saveForm).not.toContain('class="provider-picker-input"');
    expect(antigravityPage.body).toContain(
      'Choose a provider to load its saved schedule. This does not save changes.',
    );
    expect(schedulePolicy(repositories, 'codex')).toEqual(beforeCodex);
    expect(schedulePolicy(repositories, 'antigravity')).toEqual(beforeAntigravity);
    expect(reconcileRequests).toBe(0);
  });

  it('saves only the selected provider policy and leaves the other provider unchanged', async () => {
    let reconcileRequests = 0;
    const { app, repositories } = createScheduleApp(() => {
      reconcileRequests += 1;
    });
    const codexBefore = schedulePolicy(repositories, 'codex');
    const page = await app.inject({
      method: 'GET',
      url: '/schedule?providerId=antigravity',
      headers: { host: 'localhost:8787' },
    });
    const setCookie = page.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
    const csrfToken = page.body.match(/name="csrfToken" value="([^"]+)"/)?.[1];
    expect(cookie).toContain('awm_csrf=');
    expect(csrfToken).toBeTruthy();

    const response = await app.inject({
      method: 'POST',
      url: '/schedule',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        csrfToken: csrfToken ?? '',
        providerId: 'antigravity',
        policyKind: 'fixed',
        enabled: 'true',
        timezone: 'America/Sao_Paulo',
        windowKind: 'weekly',
        anchorLocalTime: '10:30',
        toleranceSeconds: '900',
      }).toString(),
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/schedule?updated=schedule&providerId=antigravity');
    expect(schedulePolicy(repositories, 'codex')).toEqual(codexBefore);
    expect(schedulePolicy(repositories, 'antigravity')?.kind).toBe('fixed');
    expect(schedulePolicy(repositories, 'antigravity')?.config).toMatchObject({
      windowKind: 'weekly',
      anchorLocalTime: '10:30',
    });
    expect(reconcileRequests).toBe(1);
  });

  it('submits the GET selector on the native radio change event used by pointer or keyboard', () => {
    let onChange: (() => void) | undefined;
    let submitted = 0;
    const providerChoice = {
      addEventListener: (event: string, listener: () => void) => {
        if (event === 'change') onChange = listener;
      },
    };
    const form = {
      querySelectorAll: (selector: string) =>
        selector === 'select, .provider-picker-input' ? [providerChoice] : [],
      requestSubmit: () => {
        submitted += 1;
      },
    };
    const document = {
      querySelectorAll: (selector: string) =>
        selector === '[data-provider-picker-auto-submit]' ? [form] : [],
    };

    new Script(APP_JS).runInNewContext({ document, window: {} });
    onChange?.();

    expect(submitted).toBe(1);
  });
});
