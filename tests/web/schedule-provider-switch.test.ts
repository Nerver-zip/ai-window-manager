import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachDefaultTestSession,
  createTestOperatorAuth,
  loadTestConfig,
} from '../helpers/operator-auth.js';
import { parseProviderObservation } from '../../src/domain/schemas.js';
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
  seedObservedWindows(repositories, 'codex', [
    ['codex_primary', 18_000],
    ['codex_secondary', 604_800],
  ]);
  seedObservedWindows(repositories, 'antigravity', [
    ['antigravity_gemini_five_hour', 18_000],
    ['antigravity_gemini_weekly', 604_800],
    ['antigravity_claude_gpt_five_hour', 18_000],
    ['antigravity_claude_gpt_weekly', 604_800],
  ]);
  seedPolicy(repositories, 'codex', 'fixed', {
    windowKind: 'five_hour',
    anchorLocalTime: '17:00',
    toleranceSeconds: 900,
  });
  seedPolicy(repositories, 'antigravity', 'custom_schedule', {
    windowKind: 'antigravity_gemini_weekly',
    times: ['09:30'],
    toleranceSeconds: 600,
  });
  seedPolicy(repositories, 'antigravity', 'fixed', {
    windowKind: 'antigravity_claude_gpt_weekly',
    anchorLocalTime: '20:15',
    toleranceSeconds: 900,
  });
  const operatorAuth = createTestOperatorAuth(clock);
  const app = buildServer({
    config: loadTestConfig({
      AWM_DB_PATH: dbPath,
      AWM_LOG_LEVEL: 'silent',
      AWM_FAKE_PROVIDER_ENABLED: 'false',
    }),
    db,
    repositories,
    adapters: new Map(),
    clock,
    operatorAuth,
    requestReconcile,
  });
  attachDefaultTestSession(app, operatorAuth.sessions.create().token);
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

function seedObservedWindows(
  repositories: StorageRepositories,
  providerId: string,
  windows: readonly (readonly [windowKind: string, durationSeconds: number])[],
): void {
  const observation = parseProviderObservation({
    providerId,
    health: 'UP',
    observedAt: now,
    staleAfterSeconds: 300,
    windows: windows.map(([windowKind, durationSeconds]) => ({
      providerId,
      windowKind,
      observedAt: now,
      phase: { value: 'INACTIVE', source: 'observed', confidence: 'exact', observedAt: now },
      durationSeconds: {
        value: durationSeconds,
        source: 'inferred',
        confidence: 'exact',
        observedAt: now,
      },
      usageRatio: { value: 0, source: 'observed', confidence: 'exact', observedAt: now },
      remainingRatio: { value: 1, source: 'observed', confidence: 'exact', observedAt: now },
    })),
  });
  const observedAtMs = Date.parse(now);
  repositories.providerState.upsert({
    providerId,
    health: 'UP',
    observedAtMs,
    staleAfterMs: observation.staleAfterSeconds * 1000,
    observation,
    lastSuccessAtMs: observedAtMs,
    lastErrorCode: null,
    updatedAtMs: observedAtMs,
  });
}

function seedPolicy(
  repositories: StorageRepositories,
  providerId: string,
  kind: SchedulePolicyRecord['kind'],
  config: unknown,
): void {
  const windowKind =
    typeof config === 'object' && config !== null && !Array.isArray(config)
      ? (config as Record<string, unknown>).windowKind
      : undefined;
  const scope =
    providerId !== 'antigravity'
      ? 'default'
      : typeof windowKind === 'string' && windowKind.startsWith('antigravity_claude_gpt_')
        ? 'claude_gpt'
        : 'gemini';
  repositories.schedulePolicies.upsert({
    id:
      providerId === 'antigravity'
        ? `activation-antigravity-${scope === 'claude_gpt' ? 'claude-gpt' : 'gemini'}`
        : `activation-${providerId}`,
    providerId,
    scope,
    kind,
    enabled: true,
    timezone: 'America/Sao_Paulo',
    config,
    createdAtMs: Date.parse(now),
    updatedAtMs: Date.parse(now),
  });
}

function schedulePolicy(repositories: StorageRepositories, providerId: string, scope = 'default') {
  return repositories.schedulePolicies
    .list(providerId)
    .find((policy) =>
      providerId !== 'antigravity'
        ? policy.id === `activation-${providerId}`
        : policy.scope === scope,
    );
}

describe('schedule provider switching', () => {
  it('loads each provider policy via a read-only GET without JavaScript', async () => {
    let reconcileRequests = 0;
    const { app, repositories } = createScheduleApp(() => {
      reconcileRequests += 1;
    });
    const beforeCodex = schedulePolicy(repositories, 'codex');
    const beforeAntigravityGemini = schedulePolicy(repositories, 'antigravity', 'gemini');
    const beforeAntigravityClaude = schedulePolicy(repositories, 'antigravity', 'claude_gpt');

    const codexPage = await app.inject('/schedule?providerId=codex');
    expect(codexPage.statusCode).toBe(200);
    expect(
      [...codexPage.body.matchAll(/data-awm-region="([^"]+)"/g)].map((match) => match[1]),
    ).toEqual(['app-content', 'schedule-workspace']);
    expect(codexPage.body).toContain('data-awm-region="schedule-workspace"');
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
    expect(antigravityPage.body).toContain('name="scope" value="gemini"');
    expect(antigravityPage.body).toContain(
      'href="/schedule?providerId=antigravity&amp;scope=claude_gpt"',
    );
    expect(antigravityPage.body).not.toContain('value="antigravity_claude_gpt_weekly"');

    const selector = antigravityPage.body.match(
      /<form class="schedule-provider-selection"[\s\S]*?<\/form>/,
    )?.[0];
    expect(selector).toContain(
      'method="get" action="/schedule" data-provider-picker-auto-submit data-awm-enhance="navigation" data-awm-target="schedule-workspace"',
    );
    expect(selector).toContain(
      '<noscript><div class="form-actions"><button type="submit">View provider schedule</button>',
    );
    expect(selector).toMatch(/<select[^>]*name="providerId"|type="radio"[^>]*name="providerId"/);
    expect(selector).toContain('name="providerId"');
    const saveForm = antigravityPage.body.match(
      /<form method="post" action="\/schedule"[\s\S]*?<\/form>/,
    )?.[0];
    expect(saveForm).toContain('data-awm-enhance="mutation"');
    expect(saveForm).toContain('data-awm-target="schedule-workspace"');
    expect(saveForm).toContain('name="csrfToken"');
    expect(saveForm).toContain('data-awm-pending-label="Saving schedule…"');
    expect(saveForm).toContain('type="hidden" name="providerId" value="antigravity"');
    expect(saveForm).not.toContain('class="provider-picker-input"');
    const familyLink = antigravityPage.body.match(
      /<a[^>]*href="\/schedule\?providerId=antigravity&amp;scope=claude_gpt"[^>]*>/,
    )?.[0];
    expect(familyLink).toContain('data-awm-soft-nav');
    expect(familyLink).toContain('data-awm-target="schedule-workspace"');
    expect(antigravityPage.body).toContain(
      'Choose a provider to load its saved schedule. This does not save changes.',
    );
    expect(schedulePolicy(repositories, 'codex')).toEqual(beforeCodex);
    expect(schedulePolicy(repositories, 'antigravity', 'gemini')).toEqual(beforeAntigravityGemini);
    expect(schedulePolicy(repositories, 'antigravity', 'claude_gpt')).toEqual(
      beforeAntigravityClaude,
    );
    expect(reconcileRequests).toBe(0);
  });

  it('saves only the selected provider policy and leaves the other provider unchanged', async () => {
    let reconcileRequests = 0;
    const { app, repositories } = createScheduleApp(() => {
      reconcileRequests += 1;
    });
    const migratedClaudePolicy = schedulePolicy(repositories, 'antigravity', 'claude_gpt');
    if (!migratedClaudePolicy) throw new Error('expected Claude and GPT policy');
    repositories.schedulePolicies.upsert({ ...migratedClaudePolicy, requiresReview: true });
    const codexBefore = schedulePolicy(repositories, 'codex');
    const page = await app.inject({
      method: 'GET',
      url: '/schedule?providerId=antigravity&scope=claude_gpt',
      headers: { host: 'localhost:8787' },
    });
    expect(page.body).toContain(
      'Review and save this family schedule before automatic starts can resume.',
    );
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
        scope: 'claude_gpt',
        policyKind: 'fixed',
        enabled: 'true',
        timezone: 'America/Sao_Paulo',
        windowKind: 'antigravity_claude_gpt_weekly',
        anchorLocalTime: '10:30',
        toleranceSeconds: '900',
      }).toString(),
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      '/schedule?updated=schedule&providerId=antigravity&scope=claude_gpt',
    );
    expect(schedulePolicy(repositories, 'codex')).toEqual(codexBefore);
    expect(schedulePolicy(repositories, 'antigravity', 'gemini')?.kind).toBe('custom_schedule');
    expect(schedulePolicy(repositories, 'antigravity', 'gemini')?.config).toMatchObject({
      windowKind: 'antigravity_gemini_weekly',
      times: ['09:30'],
    });
    expect(schedulePolicy(repositories, 'antigravity', 'claude_gpt')?.kind).toBe('fixed');
    expect(schedulePolicy(repositories, 'antigravity', 'claude_gpt')?.config).toMatchObject({
      windowKind: 'antigravity_claude_gpt_weekly',
      anchorLocalTime: '10:30',
    });
    expect(repositories.schedulePolicies.list('antigravity')).toHaveLength(2);
    expect(schedulePolicy(repositories, 'antigravity', 'claude_gpt')?.id).toBe(
      'activation-antigravity-claude-gpt',
    );
    expect(schedulePolicy(repositories, 'antigravity', 'claude_gpt')?.requiresReview).toBe(false);
    expect(reconcileRequests).toBe(1);

    const savedPage = await app.inject({
      method: 'GET',
      url: '/schedule?updated=schedule&providerId=antigravity&scope=claude_gpt',
      headers: { host: 'localhost:8787' },
    });
    expect(savedPage.statusCode).toBe(200);
    expect(savedPage.body).toContain('Schedule saved.');
    expect(savedPage.body).toContain('data-awm-announcement="Schedule saved."');
    expect(savedPage.body).toContain('data-awm-region="schedule-workspace"');
    expect(savedPage.body).toContain('name="policyKind" value="fixed" checked');
    expect(savedPage.body).toContain('name="anchorLocalTime" type="time" value="10:30"');
    expect(savedPage.body).toContain('value="antigravity_claude_gpt_weekly" selected');
    expect(savedPage.body).toContain('name="scope" value="claude_gpt"');
  });

  it('submits provider radios on change without auto-submitting unrelated filters', () => {
    let providerChange: (() => void) | undefined;
    let windowChange: (() => void) | undefined;
    let submitted = 0;
    let providerListenerCount = 0;
    const providerChoice = {
      addEventListener: (event: string, listener: () => void) => {
        if (event === 'change') {
          providerChange = listener;
          providerListenerCount += 1;
        }
      },
    };
    const windowChoice = {
      addEventListener: (event: string, listener: () => void) => {
        if (event === 'change') windowChange = listener;
      },
    };
    const form = {
      querySelectorAll: (selector: string) =>
        selector === '.provider-picker-input' ? [providerChoice] : [windowChoice],
      requestSubmit: () => {
        submitted += 1;
      },
    };
    const documentListeners = new Map<string, (event: { detail?: { root?: unknown } }) => void>();
    const document = {
      querySelectorAll: (selector: string) =>
        selector === '[data-provider-picker-auto-submit]' ? [form] : [],
      addEventListener: (
        event: string,
        listener: (event: { detail?: { root?: unknown } }) => void,
      ) => documentListeners.set(event, listener),
    };

    new Script(APP_JS).runInNewContext({ document, window: {} });
    documentListeners.get('awm:enhance')?.({ detail: { root: document } });
    providerChange?.();
    windowChange?.();

    expect(submitted).toBe(1);
    expect(providerListenerCount).toBe(1);
  });

  it('automatically applies usage-window changes on the Usage page', () => {
    let changed:
      ((event: { target: { matches: (selector: string) => boolean } }) => void) | undefined;
    let submitted = 0;
    const form = {
      addEventListener: (event: string, listener: typeof changed) => {
        if (event === 'change') changed = listener;
      },
      requestSubmit: () => {
        submitted += 1;
      },
    };
    const document = {
      querySelectorAll: (selector: string) =>
        selector === '[data-usage-filter-auto-submit]' ? [form] : [],
    };

    new Script(APP_JS).runInNewContext({ document, window: {} });
    changed?.({ target: { matches: (selector) => selector === 'select[name="window"]' } });
    changed?.({ target: { matches: () => false } });

    expect(submitted).toBe(1);
  });
});
