import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthSessionManager, type ProviderAuthDriver } from '../../src/auth/session-manager.js';
import {
  attachDefaultTestSession,
  createTestOperatorAuth,
  loadTestConfig,
} from '../helpers/operator-auth.js';
import { parseProviderObservation } from '../../src/domain/schemas.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import { seedBootstrapProviderDefaults } from '../../src/bootstrap/provider-defaults.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories, type ProviderRecord } from '../../src/storage/repositories.js';
import { buildServer } from '../../src/web/server.js';
import type { ProviderClientUpdateWebControls } from '../../src/provider-clients/web-controls.js';
import type { ProviderClientUpdateStatus } from '../../src/provider-clients/update-service.js';

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

function setup(
  options: {
    providerClientUpdates?: (
      repositories: ReturnType<typeof createRepositories>,
    ) => ProviderClientUpdateWebControls;
    extraProviders?: ProviderRecord[];
    extraAdapterIds?: string[];
    authSessions?: AuthSessionManager;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-settings-routes-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  const clock = new FakeClock('2026-09-19T12:00:00.000Z');
  const operatorAuth = createTestOperatorAuth(clock);
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
  for (const extraProvider of options.extraProviders ?? []) {
    repositories.providers.upsert(extraProvider);
  }
  const adapters = new Map<string, ProviderAdapter>([['fake', fake]]);
  for (const adapterId of options.extraAdapterIds ?? []) adapters.set(adapterId, fake);
  const app = buildServer({
    config: loadTestConfig({
      AWM_DB_PATH: path.join(dir, 'awm.db'),
      AWM_LOG_LEVEL: 'silent',
      AWM_FAKE_PROVIDER_ENABLED: 'true',
    }),
    db,
    repositories,
    adapters,
    clock,
    operatorAuth,
    ...(options.authSessions ? { authSessions: options.authSessions } : {}),
    ...(options.providerClientUpdates
      ? { providerClientUpdates: options.providerClientUpdates(repositories) }
      : {}),
  });
  attachDefaultTestSession(app, operatorAuth.sessions.create().token);
  resources.push({ app, db, dir });
  return { app, db, dir, repositories, fake, clock, operatorAuth };
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function updateStatus(providerId: 'codex' | 'antigravity'): ProviderClientUpdateStatus {
  return {
    providerId,
    packagedVersion: '1.0.0',
    activeVersion: '1.0.0',
    previousVersion: null,
    availableVersion: null,
    updateAvailable: false,
    status: 'current',
    lastCheckedAt: '2026-09-19T12:00:00.000Z',
    lastUpdatedAt: null,
    lastErrorCode: null,
  };
}

function providerUpdateControls(
  repositories: ReturnType<typeof createRepositories>,
  runtimeChanging = false,
) {
  const actions = {
    check: vi.fn(() => true),
    update: vi.fn(() => true),
    rollback: vi.fn(() => true),
  };
  const controls: ProviderClientUpdateWebControls = {
    getStatus: updateStatus,
    isRuntimeChanging: (providerId) => runtimeChanging && providerId === 'antigravity',
    autoUpdateEnabled: (providerId) =>
      repositories.settings.get<boolean>(`provider-client-auto-update:${providerId}`)?.value ===
      true,
    setAutoUpdateEnabled: (providerId, enabled) =>
      repositories.settings.set(
        `provider-client-auto-update:${providerId}`,
        enabled,
        Date.parse('2026-09-19T12:00:00.000Z'),
      ),
    startCheck: actions.check,
    startUpdate: actions.update,
    startRollback: actions.rollback,
  };
  return { controls, actions };
}

async function persistObservedWindow(
  context: ReturnType<typeof setup>,
  windowKind: 'five_hour' | 'weekly',
): Promise<void> {
  const original = await context.fake.inspect({});
  const sourceWindow = original.windows[0]!;
  const window = parseProviderObservation({
    ...original,
    windows: [
      {
        ...sourceWindow,
        windowKind,
        ...(windowKind === 'weekly' && sourceWindow.durationSeconds
          ? {
              durationSeconds: {
                ...sourceWindow.durationSeconds,
                value: 604_800,
              },
            }
          : {}),
      },
    ],
  });
  const observedAtMs = Date.parse(window.observedAt);
  context.repositories.providerState.upsert({
    providerId: window.providerId,
    health: window.health,
    observedAtMs,
    staleAfterMs: window.staleAfterSeconds * 1000,
    observation: window,
    lastSuccessAtMs: observedAtMs,
    lastErrorCode: null,
    updatedAtMs: observedAtMs,
  });
}

describe('settings and schedule pages', () => {
  it('persists an explicit Antigravity automatic-start choice across SQLite reopen and bootstrap', async () => {
    const nowMs = Date.parse('2026-09-19T12:00:00.000Z');
    const antigravity: ProviderRecord = {
      id: 'antigravity',
      kind: 'antigravity',
      enabled: true,
      mode: 'monitor_only',
      modeExplicit: false,
      pollIntervalSeconds: 300,
      config: {},
      configVersion: 1,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    const context = setup({ extraProviders: [antigravity], extraAdapterIds: ['antigravity'] });
    const page = await context.app.inject({
      method: 'GET',
      url: '/settings',
      headers: { host: 'localhost:8787' },
    });
    const cookie = headerValue(page.headers['set-cookie']);
    const token = /awm_csrf=([^;]+)/.exec(cookie)?.[1];
    if (!token) throw new Error('csrf token missing');

    const response = await context.app.inject({
      method: 'POST',
      url: '/settings/providers/antigravity',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrfToken=${token}&enabled=on&mode=automation&refreshIntervalPreset=300`,
    });
    expect(response.statusCode).toBe(303);
    expect(context.repositories.providers.get('antigravity')).toMatchObject({
      mode: 'automation',
      modeExplicit: true,
    });

    const tracked = resources.find((resource) => resource.app === context.app);
    if (!tracked) throw new Error('settings test resources were not registered');
    await context.app.close();
    context.db.close();

    const reopenedDb = openDatabase(path.join(context.dir, 'awm.db'));
    const reopenedRepositories = createRepositories(reopenedDb);
    seedBootstrapProviderDefaults({
      repositories: reopenedRepositories,
      provider: { id: 'antigravity', kind: 'antigravity', config: {} },
      nowMs: nowMs + 30_000,
      pollIntervalSeconds: 300,
      timezone: 'America/Sao_Paulo',
      triggerEnabled: true,
    });
    expect(reopenedRepositories.providers.get('antigravity')).toMatchObject({
      mode: 'automation',
      modeExplicit: true,
    });

    const restartedApp = buildServer({
      config: loadTestConfig({
        AWM_DB_PATH: path.join(context.dir, 'awm.db'),
        AWM_LOG_LEVEL: 'silent',
        AWM_FAKE_PROVIDER_ENABLED: 'true',
      }),
      db: reopenedDb,
      repositories: reopenedRepositories,
      adapters: new Map([
        ['fake', context.fake],
        ['antigravity', context.fake],
      ]),
      clock: context.clock,
      operatorAuth: context.operatorAuth,
    });
    tracked.app = restartedApp;
    tracked.db = reopenedDb;
    attachDefaultTestSession(restartedApp, context.operatorAuth.sessions.create().token);
    const restartedPage = await restartedApp.inject({
      method: 'GET',
      url: '/settings',
      headers: { host: 'localhost:8787' },
    });
    expect(restartedPage.statusCode).toBe(200);
    expect(restartedPage.body).toContain('value="automation" selected');
  });

  it('blocks provider sign-in while the provider executable is being replaced', async () => {
    const driver: ProviderAuthDriver = {
      providerId: 'antigravity',
      isAlreadyAuthenticated: () => Promise.resolve(false),
      launch: () => {
        throw new Error('provider sign-in must not launch during an update');
      },
      parseOutput: () => undefined,
      submitCode: () => undefined,
      verify: () => Promise.resolve(false),
    };
    const authSessions = new AuthSessionManager({
      clock: new FakeClock('2026-09-19T12:00:00.000Z'),
      drivers: new Map([['antigravity', driver]]),
    });
    const context = setup({
      authSessions,
      extraAdapterIds: ['antigravity'],
      providerClientUpdates: (repositories) => providerUpdateControls(repositories, true).controls,
    });
    const page = await context.app.inject({
      method: 'GET',
      url: '/settings',
      headers: { host: 'localhost:8787' },
    });
    const cookie = headerValue(page.headers['set-cookie']);
    const token = /awm_csrf=([^;]+)/.exec(cookie)?.[1];
    if (!token) throw new Error('csrf token missing');

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/providers/antigravity/auth/start',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'content-type': 'application/json',
        'x-csrf-token': token,
      },
      payload: '{}',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'PROVIDER_CLIENT_UPDATE_IN_PROGRESS' },
    });
    expect(authSessions.status('antigravity').state).toBe('IDLE');
  });

  it('protects provider-client update controls and exposes only safe status fields', async () => {
    const clientProvider: ProviderRecord = {
      id: 'codex',
      kind: 'codex',
      enabled: true,
      mode: 'automation',
      pollIntervalSeconds: 300,
      config: {},
      configVersion: 1,
      createdAtMs: Date.parse('2026-09-19T12:00:00.000Z'),
      updatedAtMs: Date.parse('2026-09-19T12:00:00.000Z'),
    };
    let actions: ReturnType<typeof providerUpdateControls>['actions'] | undefined;
    const context = setup({
      extraProviders: [clientProvider],
      providerClientUpdates: (repositories) => {
        const updateControls = providerUpdateControls(repositories);
        actions = updateControls.actions;
        return updateControls.controls;
      },
    });
    const actionSpies = actions!;

    const page = await context.app.inject({
      method: 'GET',
      url: '/settings',
      headers: { host: 'localhost:8787' },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Provider app updates');
    expect(page.body).toContain('Active version');
    expect(page.body).toContain('Automatically install stable updates');
    const cookie = headerValue(page.headers['set-cookie']);
    const token = /awm_csrf=([^;]+)/.exec(cookie)?.[1];
    if (!token) throw new Error('csrf token missing');

    const action = await context.app.inject({
      method: 'POST',
      url: '/settings/provider-clients/codex/check',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrfToken=${token}`,
    });
    expect(action.statusCode).toBe(303);
    expect(actionSpies.check).toHaveBeenCalledExactlyOnceWith('codex');

    const apiRead = await context.app.inject({ method: 'GET', url: '/api/v1/provider-clients' });
    expect(apiRead.statusCode).toBe(200);
    expect(apiRead.body).toContain('"providerId":"codex"');
    expect(apiRead.body).toContain('"activeVersion":"1.0.0"');
    expect(apiRead.body).toContain('"autoUpdate":false');
    expect(apiRead.body).not.toMatch(/executablePath|sha256|https?:/i);

    const apiUpdate = await context.app.inject({
      method: 'POST',
      url: '/api/v1/provider-clients/codex/update',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'x-csrf-token': token,
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    expect(apiUpdate.statusCode).toBe(202);
    expect(actionSpies.update).toHaveBeenCalledExactlyOnceWith('codex');

    const rejected = await context.app.inject({
      method: 'POST',
      url: '/settings/provider-clients/codex/rollback',
      headers: {
        host: 'localhost:8787',
        origin: 'https://attacker.invalid',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrfToken=${token}`,
    });
    expect(rejected.statusCode).toBe(403);
    expect(actionSpies.rollback).not.toHaveBeenCalled();

    const invalid = await context.app.inject({
      method: 'POST',
      url: '/api/v1/provider-clients/fake/update',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'x-csrf-token': token,
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    expect(invalid.statusCode).toBe(404);
  });

  it('previews an edited schedule from persisted state without inspecting or saving', async () => {
    const context = setup();
    const inspect = vi.spyOn(context.fake, 'inspect');
    const response = await context.app.inject({
      method: 'GET',
      url: '/schedule/preview?policyKind=custom_schedule&providerId=fake&enabled=on&timezone=America%2FSao_Paulo&windowKind=five_hour&times=09%3A00&times=14%3A00&toleranceSeconds=900',
      headers: { host: 'localhost:8787' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('schedule-horizon');
    expect(response.body).toContain('Scheduled start opportunity');
    expect(inspect).not.toHaveBeenCalled();
    expect(context.repositories.schedulePolicies.list('fake')).toHaveLength(0);
  });

  it('previews paired active-hour fields and rejects incomplete preview input safely', async () => {
    const context = setup();
    const valid = await context.app.inject({
      method: 'GET',
      url: '/schedule/preview?policyKind=active_hours&providerId=fake&enabled=on&timezone=UTC&windowKind=five_hour&periodStarts=08%3A00&periodEnds=18%3A00',
      headers: { host: 'localhost:8787' },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.body).toContain('Scheduled start opportunity');

    const invalid = await context.app.inject({
      method: 'GET',
      url: '/schedule/preview?policyKind=custom_schedule&providerId=fake&timezone=Not%2FAZone&windowKind=five_hour&times=09%3A00',
      headers: { host: 'localhost:8787' },
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.body).toContain('Complete the selected schedule');
    expect(context.repositories.schedulePolicies.list('fake')).toHaveLength(0);
  });

  it('uses a saved timezone for an edited preview and fails closed on invalid policy semantics', async () => {
    const context = setup();
    const missingTimezone = await context.app.inject({
      method: 'GET',
      url: '/schedule/preview?policyKind=custom_schedule&providerId=fake&enabled=on&windowKind=five_hour&times=09%3A00&toleranceSeconds=900',
      headers: { host: 'localhost:8787' },
    });
    expect(missingTimezone.statusCode).toBe(200);
    expect(missingTimezone.body).toContain('Choose a time zone in Settings');

    context.repositories.settings.set('timezone', 'America/Sao_Paulo', 1);
    context.repositories.settings.set('timezone_source', 'manual', 1);
    const withSavedTimezone = await context.app.inject({
      method: 'GET',
      url: '/schedule/preview?policyKind=custom_schedule&providerId=fake&enabled=on&windowKind=five_hour&times=09%3A00&toleranceSeconds=900',
      headers: { host: 'localhost:8787' },
    });
    expect(withSavedTimezone.statusCode).toBe(200);
    expect(withSavedTimezone.body).toContain('Scheduled start opportunity');

    const duplicateTimes = await context.app.inject({
      method: 'GET',
      url: '/schedule/preview?policyKind=custom_schedule&providerId=fake&enabled=on&timezone=UTC&windowKind=five_hour&times=09%3A00&times=09%3A00',
      headers: { host: 'localhost:8787' },
    });
    expect(duplicateTimes.statusCode).toBe(200);
    expect(duplicateTimes.body).toContain('Complete the selected schedule');

    const missingKind = await context.app.inject({
      method: 'GET',
      url: '/schedule/preview?providerId=fake&timezone=UTC',
      headers: { host: 'localhost:8787' },
    });
    expect(missingKind.statusCode).toBe(200);
    expect(missingKind.body).toContain('Complete the selected schedule');
    expect(context.repositories.schedulePolicies.list('fake')).toHaveLength(0);
  });

  it('saves the new paired active-hours controls through the existing policy contract', async () => {
    const context = setup();
    await persistObservedWindow(context, 'five_hour');
    const page = await context.app.inject({
      method: 'GET',
      url: '/schedule',
      headers: { host: 'localhost:8787' },
    });
    const cookie = headerValue(page.headers['set-cookie']);
    const token = /awm_csrf=([^;]+)/.exec(cookie)?.[1];
    if (!token) throw new Error('csrf token missing');

    const response = await context.app.inject({
      method: 'POST',
      url: '/schedule',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrfToken=${token}&policyKind=active_hours&providerId=fake&enabled=on&timezone=America%2FSao_Paulo&windowKind=five_hour&periodStarts=08%3A00&periodEnds=18%3A00`,
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/schedule?updated=schedule&providerId=fake');
    expect(context.repositories.schedulePolicies.list('fake')[0]?.config).toMatchObject({
      periods: [{ start: '08:00', end: '18:00' }],
    });
  });

  it('preserves the selected usage window in an automatic-start policy', async () => {
    const context = setup();
    await persistObservedWindow(context, 'weekly');
    const page = await context.app.inject({
      method: 'GET',
      url: '/schedule',
      headers: { host: 'localhost:8787' },
    });
    const cookie = headerValue(page.headers['set-cookie']);
    const token = /awm_csrf=([^;]+)/.exec(cookie)?.[1];
    if (!token) throw new Error('csrf token missing');

    const response = await context.app.inject({
      method: 'POST',
      url: '/schedule',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrfToken=${token}&policyKind=auto&providerId=fake&enabled=on&timezone=UTC&windowKind=weekly`,
    });
    expect(response.statusCode).toBe(303);
    expect(context.repositories.schedulePolicies.list('fake')[0]?.config).toMatchObject({
      windowKind: 'weekly',
    });
  });

  it('preserves the selected usage window in a manual policy', async () => {
    const context = setup();
    await persistObservedWindow(context, 'five_hour');
    const page = await context.app.inject({
      method: 'GET',
      url: '/schedule',
      headers: { host: 'localhost:8787' },
    });
    const cookie = headerValue(page.headers['set-cookie']);
    const token = /awm_csrf=([^;]+)/.exec(cookie)?.[1];
    if (!token) throw new Error('csrf token missing');

    const response = await context.app.inject({
      method: 'POST',
      url: '/schedule',
      headers: {
        host: 'localhost:8787',
        origin: 'http://localhost:8787',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `csrfToken=${token}&policyKind=manual&providerId=fake&enabled=on&timezone=UTC&windowKind=five_hour`,
    });
    expect(response.statusCode).toBe(303);
    expect(context.repositories.schedulePolicies.list('fake')[0]?.config).toMatchObject({
      windowKind: 'five_hour',
    });
  });

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
      payload: `csrfToken=${token}&enabled=on&mode=automation&refreshIntervalPreset=300`,
    });
    expect(update.statusCode).toBe(303);
    expect(context.repositories.providers.get('fake')).toMatchObject({
      mode: 'automation',
      modeExplicit: true,
      pollIntervalSeconds: 300,
    });

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
    expect(context.repositories.providers.get('fake')).toMatchObject({
      mode: 'monitor_only',
      modeExplicit: true,
      pollIntervalSeconds: 450,
    });

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
