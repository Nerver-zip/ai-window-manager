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
  type SchedulePolicyRecord,
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
  fakeProviderEnabled = true,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-web-'));
  const dbPath = path.join(dir, 'awm.db');
  const db = openDatabase(dbPath);
  const clock = new FakeClock(NOW);
  const repositories = createRepositories(db);
  seed(repositories, clock);
  const app = buildServer({
    config: loadConfig({
      AWM_DB_PATH: dbPath,
      AWM_LOG_LEVEL: 'silent',
      AWM_FAKE_PROVIDER_ENABLED: String(fakeProviderEnabled),
    }),
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

function seedActivationPolicy(
  repositories: StorageRepositories,
  kind: SchedulePolicyRecord['kind'],
  config: unknown = {},
  enabled = true,
  providerId = 'fake',
): void {
  repositories.schedulePolicies.upsert({
    id: `activation-${providerId}`,
    providerId,
    kind,
    enabled,
    timezone: 'America/Sao_Paulo',
    config,
    createdAtMs: Date.parse(NOW),
    updatedAtMs: Date.parse(NOW),
  });
}

function automationInspectionSpy(id: string): ProviderAdapter {
  return {
    ...inspectionSpy(id),
    capabilities: () => ({
      ...capabilities,
      windowTrigger: { supported: true, contract: 'official_supported', consumesQuota: true },
    }),
  };
}

describe('web server persisted overview', () => {
  it('renders an empty workspace with useful navigation', async () => {
    const { app } = createApp(() => {});
    const response = await app.inject('/');
    expect(response.body).toContain('No providers are set up');
    expect(response.body).toContain('aria-current="page"');
    expect(response.body).not.toContain('Private usage dashboard');
    expect(response.body).not.toContain('PRIVATE WORKSPACE');
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

  it.each([
    {
      name: 'manual',
      kind: 'manual' as const,
      config: {},
      title: 'Only when I ask',
      detail: 'New windows start only when you ask.',
    },
    {
      name: 'automatic',
      kind: 'auto' as const,
      config: { windowKind: 'five_hour' },
      title: 'Whenever possible',
      detail: '5-hour window · Starts after a fresh check confirms availability.',
    },
    {
      name: 'repeating-cycle',
      kind: 'fixed' as const,
      config: { windowKind: 'five_hour', anchorLocalTime: '18:00', toleranceSeconds: 900 },
      title: 'On a repeating cycle',
      detail: '5-hour window · Cycle start at 6:00 PM · São Paulo local time.',
    },
    {
      name: 'chosen-times',
      kind: 'custom_schedule' as const,
      config: {
        windowKind: 'weekly',
        times: ['09:00', '14:30', '20:00', '22:00'],
        toleranceSeconds: 900,
      },
      title: 'At specific times',
      detail:
        'Weekly window · Daily at 9:00 AM, 2:30 PM, 8:00 PM and 1 more · São Paulo local time.',
    },
    {
      name: 'active-hours',
      kind: 'active_hours' as const,
      config: { windowKind: 'five_hour', periods: [{ start: '08:00', end: '18:00' }] },
      title: 'Within active hours',
      detail: '5-hour window · Daily during 8:00 AM–6:00 PM · São Paulo local time.',
    },
  ])('shows the saved $name policy in plain language', async ({ kind, config, title, detail }) => {
    const { app } = createApp((repositories) => {
      seedObservedProvider(repositories);
      seedActivationPolicy(repositories, kind, config);
    });

    const page = await app.inject('/');
    expect(page.body).toContain('aria-label="Selected start policy"');
    expect(page.body).toContain(`<strong>${title}</strong>`);
    expect(page.body).toContain(detail);
    expect(page.body).toContain('href="/schedule?providerId=fake">Change</a>');
    expect(page.body).not.toContain('activation-fake');
    expect(page.body).not.toContain('five_hour');
  });

  it('shows when the selected policy is paused or cannot currently run', async () => {
    const paused = createApp((repositories) => {
      seedObservedProvider(repositories);
      seedActivationPolicy(
        repositories,
        'fixed',
        { windowKind: 'five_hour', anchorLocalTime: '18:00', toleranceSeconds: 900 },
        false,
      );
    });
    const pausedPage = await paused.app.inject('/');
    expect(pausedPage.body).toContain('Paused · this policy will not plan new starts.');

    const settingsDisabled = createApp((repositories) => {
      seedObservedProvider(repositories);
      seedActivationPolicy(repositories, 'auto', { windowKind: 'five_hour' });
    });
    const settingsPage = await settingsDisabled.app.inject('/');
    expect(settingsPage.body).toContain(
      'Saved, but automatic starts are off in provider settings.',
    );

    const unsupported = createApp((repositories) => {
      seedObservedProvider(repositories);
      repositories.providers.upsert(providerRecord({ mode: 'automation' }));
      seedActivationPolicy(repositories, 'auto', { windowKind: 'five_hour' });
    }, inspectionSpy('fake'));
    const unsupportedPage = await unsupported.app.inject('/');
    expect(unsupportedPage.body).toContain(
      'Unavailable because this provider does not support automatic starts.',
    );

    const active = createApp((repositories) => {
      seedObservedProvider(repositories);
      repositories.providers.upsert(providerRecord({ mode: 'automation' }));
      seedActivationPolicy(repositories, 'auto', { windowKind: 'five_hour' });
    }, automationInspectionSpy('fake'));
    const activePage = await active.app.inject('/');
    expect(activePage.body).toContain('Active · each start still requires a fresh provider check.');
  });

  it('asks the user to review an invalid saved policy instead of showing an internal value', async () => {
    const { app } = createApp((repositories) => {
      seedObservedProvider(repositories);
      seedActivationPolicy(repositories, 'custom_schedule', {
        windowKind: 'five_hour',
        times: [],
        toleranceSeconds: 900,
      });
    });

    const page = await app.inject('/');
    expect(page.body).toContain('Saved policy needs attention');
    expect(page.body).toContain('href="/schedule?providerId=fake">Review schedule</a>');
    expect(page.body).not.toContain('activation-fake');
  });

  it('states when provider monitoring is paused while retaining the saved policy', async () => {
    const { app } = createApp((repositories) => {
      seedObservedProvider(repositories);
      repositories.providers.upsert(providerRecord({ enabled: false, mode: 'automation' }));
      seedActivationPolicy(repositories, 'auto', { windowKind: 'five_hour' });
    });

    const page = await app.inject('/');
    expect(page.body).toContain('Whenever possible');
    expect(page.body).toContain('Monitoring is paused for this provider.');
  });

  it('opens Schedule for the provider whose overview card was used', async () => {
    const { app } = createApp((repositories) => {
      seedObservedProvider(repositories);
      seedActivationPolicy(repositories, 'manual');
      seedObservedProvider(repositories, 'codex', NOW, 'codex');
      seedActivationPolicy(
        repositories,
        'fixed',
        { windowKind: 'weekly', anchorLocalTime: '17:00', toleranceSeconds: 900 },
        true,
        'codex',
      );
    });

    const overview = await app.inject('/');
    expect(overview.body).toContain('href="/schedule?providerId=codex">Change</a>');
    const schedule = await app.inject('/schedule?providerId=codex');
    expect(schedule.statusCode).toBe(200);
    expect(schedule.body).toContain('<option value="codex" selected>Codex</option>');
    expect(schedule.body).toContain('value="17:00"');
  });

  it('does not imply automatic starts are active when the saved schedule is manual', async () => {
    const automationAdapter: ProviderAdapter = {
      ...inspectionSpy('fake'),
      capabilities: () => ({
        ...capabilities,
        windowTrigger: { supported: true, contract: 'official_supported', consumesQuota: true },
      }),
    };
    const { app } = createApp((repositories) => {
      seedObservedProvider(repositories);
      repositories.providers.upsert(providerRecord({ mode: 'automation' }));
      seedActivationPolicy(repositories, 'manual');
      repositories.events.append({
        providerId: 'fake',
        occurredAtMs: Date.parse(NOW),
        type: 'scheduler_noop',
        severity: 'info',
        reasonCode: 'MANUAL_POLICY',
        data: {},
      });
    }, automationAdapter);

    const page = await app.inject('/');
    expect(page.body).toContain('Manual starts only');
    expect(page.body).not.toContain('Automatic starts enabled');
    expect(page.body).toContain('Automatic starts are off; you start windows yourself.');
  });

  it('keeps the overview focused on usage and policy, with decisions on Schedule', async () => {
    const { app } = createApp((repositories) => {
      seedObservedProvider(repositories);
      repositories.providers.upsert(providerRecord({ mode: 'automation' }));
      seedActivationPolicy(repositories, 'auto', { windowKind: 'five_hour' });
    }, automationInspectionSpy('fake'));

    const overview = await app.inject('/');
    expect(overview.statusCode).toBe(200);
    expect(overview.body).toContain('Selected start policy');
    expect(overview.body).toContain('Whenever possible');
    expect(overview.body).toContain('5-hour window');
    expect(overview.body).toContain('Resets');
    expect(overview.body).not.toContain('What happens next');
    expect(overview.body).not.toContain('Next opportunity:');
    expect(overview.body).not.toContain('No start planned right now');
    expect(overview.body).not.toContain('decision-panel');

    const schedule = await app.inject('/schedule?providerId=fake');
    expect(schedule.statusCode).toBe(200);
    expect(schedule.body).toContain('What happens next');
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

  it('keeps planned-intent details in the API, not the overview', async () => {
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

    const api = await app.inject('/api/v1/providers');
    expect(api.json()).toMatchObject({
      providers: [
        {
          nextDecision: {
            decision: 'create_intent',
            reasonCode: 'TARGET_RESET_WINDOW_MATCH',
            explanation: { targetTriggerAt: NOW },
          },
        },
      ],
    });

    const page = await app.inject('/');
    expect(page.body).not.toContain('A new window is ready to start');
    expect(page.body).not.toContain('The window can start before the target reset.');
    expect(page.body).not.toContain('What happens next');
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
    expect(page.body).toContain('No start policy selected');
    expect(page.body).toContain('href="/schedule?providerId=fake">Choose policy</a>');
    const css = await app.inject('/assets/app.css');
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.headers['content-security-policy']).not.toContain('unsafe-inline');
    const javascript = await app.inject('/assets/app.js');
    expect(javascript.statusCode).toBe(200);
    expect(javascript.headers['content-type']).toContain('application/javascript');
    expect(javascript.body).toContain('data-chart-point');
    expect(page.body).toContain('Connection</dt><dd>Connected');
    expect(page.body).toContain('left');
    expect(page.body).toContain('75%');
    expect(page.body).toContain('In about 5 hours');
    expect(page.body).toContain('UTC</small>');
    expect(page.body).not.toContain('official_supported');
    expect(page.body).not.toContain('exact confidence');
    expect(page.body).not.toContain('official_client_internal');
    expect(page.body).not.toContain('five_hour');
    expect(page.body).not.toContain('<script>persisted text</script>');
    expect(inspected.count).toBe(0);
  });

  it('omits inferred window phase labels from the overview', async () => {
    const { app } = createApp((repositories) => {
      seedObservedProvider(repositories);
      const state = repositories.providerState.get('fake');
      if (!state?.observation) throw new Error('missing observation');
      const window = state.observation.windows[0];
      if (!window) throw new Error('missing window');
      window.phase = {
        value: 'ACTIVE',
        source: 'inferred',
        confidence: 'high',
        observedAt: NOW,
      };
      repositories.providerState.upsert(state);
    });

    const page = await app.inject('/');
    expect(page.body).not.toContain('Likely in use');
    expect(page.body).toContain('5-hour window');
    expect(page.body).toContain('value="25"');
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
    expect(page.body).toContain('In about 5 minutes');
    expect(page.body).toContain('In about 30 seconds');
    expect(page.body).toContain('In about 2 days');
    expect(page.body).toContain('About 1 hour ago');
    expect(page.body).toContain('Reset time</span><strong class="unknown">Not available yet');
  });

  it('keeps scheduler explanations in JSON, not the overview', async () => {
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
    expect(page.body).not.toContain('The window duration is not reliable enough yet.');
    expect(page.body).not.toContain('What happens next');
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
    expect(page.body).toContain('out of date');
    expect(page.body).toContain('Waiting for the first update');
    expect(page.body).toContain('Waiting for first observation');
    expect(page.body).not.toContain('&lt;unsafe-kind&gt;');
    expect(page.body).not.toContain('<unsafe-kind>');
    expect(page.body).toContain('The first provider update has not arrived yet.');
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
        type: 'schedule_changed',
        severity: 'info',
        reasonCode: null,
        data: { health: 'UP' },
      });
      for (let index = 1; index <= 21; index += 1) {
        repositories.events.append({
          occurredAtMs: Date.parse(NOW) - index * 1_000,
          providerId: 'fake',
          type: 'action_succeeded',
          severity: 'info',
          reasonCode: 'TARGET_NOT_DUE',
          data: {},
        });
      }
      for (let index = 0; index < 30; index += 1) {
        repositories.events.append({
          occurredAtMs: Date.parse(NOW) - index,
          providerId: 'fake',
          type: index % 2 === 0 ? 'provider_inspected' : 'scheduler_noop',
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
    const historyPage = await app.inject(
      '/history?range=24h&provider=fake&chartRange=fake%7Cfive_hour%7C6h',
    );
    expect(historyPage.statusCode).toBe(200);
    expect(historyPage.headers['content-type']).toContain('text/html');
    expect(historyPage.body).toContain('Timeline');
    expect(historyPage.body).not.toContain('data-chart-root');
    expect(historyPage.body).toContain('Timeline range');
    expect(historyPage.body).toContain('page=2');
    expect(historyPage.body).not.toContain('Provider checked');
    expect(historyPage.body).not.toContain('Scheduling update');
    expect(historyPage.body).toContain('Usage charts have moved to');
    expect(historyPage.body).toContain(
      'href="/usage?provider=fake&amp;chartRange=fake%7Cfive_hour%7C6h"',
    );
    const usagePage = await app.inject('/usage?provider=fake&chartRange=fake%7Cfive_hour%7C6h');
    expect(usagePage.statusCode).toBe(200);
    expect(usagePage.body).toContain('<h1>Usage</h1>');
    expect(usagePage.body).toContain('25%');
    expect(usagePage.body).toContain('<option value="fake|five_hour|6h" selected>6h</option>');
    expect(usagePage.body).not.toContain('class="timeline"');
    const changedChartRange = await app.inject(
      '/usage?provider=fake&window=five_hour&chartRange=fake%7Cfive_hour%7C3h',
    );
    expect(changedChartRange.statusCode).toBe(200);
    expect(changedChartRange.body).toContain(
      '<option value="fake|five_hour|3h" selected>3h</option>',
    );
    const usageApi = await app.inject('/api/v1/usage?provider=fake&window=five_hour');
    expect(usageApi.statusCode).toBe(200);
    expect(usageApi.json()).toMatchObject({
      timezone: 'America/Sao_Paulo',
      selectedProviderId: 'fake',
      selectedWindowKind: null,
      days: [],
    });
    const historyPageTwo = await app.inject('/history?range=24h&provider=fake&page=2');
    expect(historyPageTwo.statusCode).toBe(200);
    expect(historyPageTwo.body).toContain('rel="prev"');
    expect(historyPage.body).not.toContain('synthetic-not-a-secret');
    const settings = await app.inject('/api/v1/settings');
    expect(settings.statusCode).toBe(200);
    expect(settings.body).toContain('America/Sao_Paulo');
    expect(settings.body).not.toContain('synthetic-not-a-secret');
  });

  it('serves Usage HTML and JSON strictly from persisted data without provider I/O', async () => {
    const inspected = { count: 0 };
    const { app } = createApp(
      (repositories) => {
        seedObservedProvider(repositories);
        const window = observation().windows[0];
        if (!window) throw new Error('test observation window missing');
        repositories.windowSamples.insert(window);
      },
      inspectionSpy('fake', inspected),
    );

    expect((await app.inject('/usage')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/usage')).statusCode).toBe(200);
    expect(inspected.count).toBe(0);
  });

  it('hides persisted fake provider data from every user-facing read surface when disabled', async () => {
    const { app } = createApp(
      (repositories) => {
        seedObservedProvider(repositories, 'fake', NOW, 'fake');
        seedObservedProvider(repositories, 'codex', NOW, 'codex');
        const fakeWindow = observation('fake').windows[0];
        if (!fakeWindow) throw new Error('fake test window missing');
        repositories.windowSamples.insert(fakeWindow);
        repositories.events.append({
          occurredAtMs: Date.parse(NOW),
          providerId: 'fake',
          type: 'provider_inspected',
          severity: 'info',
          reasonCode: null,
          data: {},
        });
        repositories.events.append({
          occurredAtMs: Date.parse(NOW) - 1,
          providerId: 'codex',
          type: 'provider_inspected',
          severity: 'info',
          reasonCode: null,
          data: {},
        });
        repositories.events.append({
          occurredAtMs: Date.parse(NOW) - 2,
          providerId: null,
          type: 'timezone_updated',
          severity: 'info',
          reasonCode: null,
          data: {},
        });
      },
      inspectionSpy('codex'),
      undefined,
      false,
    );

    const overview = await app.inject('/');
    expect(overview.body).toContain('Codex');
    expect(overview.body).not.toContain('Test provider');
    const settings = await app.inject('/settings');
    expect(settings.body).not.toContain('provider-fake');
    expect(settings.body).not.toContain('Test provider');
    const schedule = await app.inject('/schedule');
    expect(schedule.body).not.toContain('option value="fake"');
    expect(schedule.body).not.toContain('Test provider');
    const historyPage = await app.inject('/history');
    expect(historyPage.body).not.toContain('fake / five_hour');
    expect(historyPage.body).not.toContain('option value="fake"');
    expect((await app.inject('/history?provider=fake')).statusCode).toBe(404);
    const usagePage = await app.inject('/usage');
    expect(usagePage.statusCode).toBe(200);
    expect(usagePage.body).toContain('Codex');
    expect(usagePage.body).not.toContain('Test provider');
    expect(usagePage.body).not.toContain('fake / five_hour');
    expect((await app.inject('/usage?provider=fake')).statusCode).toBe(404);
    const usage = await app.inject('/api/v1/usage');
    expect(usage.statusCode).toBe(200);
    expect(usage.body).toContain('codex');
    expect(usage.body).not.toContain('fake');
    expect((await app.inject('/api/v1/usage?provider=fake')).statusCode).toBe(404);

    const providers = await app.inject('/api/v1/providers');
    expect(providers.json()).toMatchObject({ providers: [{ id: 'codex' }] });
    expect((await app.inject('/api/v1/providers/fake')).statusCode).toBe(404);
    const history = await app.inject('/api/v1/history?limit=50');
    expect(history.body).not.toContain('fake');
    expect(history.body).toContain('codex');
    expect(history.body).toContain('timezone_updated');
    expect((await app.inject('/api/v1/history?provider=fake')).body).not.toContain('fake');
    const scheduling = await app.inject('/api/v1/scheduling');
    expect(scheduling.body).not.toContain('fake');
    expect(scheduling.body).toContain('codex');
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
