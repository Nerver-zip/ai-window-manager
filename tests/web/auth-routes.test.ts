import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  type AuthOutputStream,
  AuthSessionManager,
  type AuthManagedProcess,
  type AuthProviderId,
  type ProviderAuthDriver,
} from '../../src/auth/session-manager.js';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { createRepositories } from '../../src/storage/repositories.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import { buildServer } from '../../src/web/server.js';

const NOW = '2026-09-23T12:00:00.000Z';
const CSRF = 'A'.repeat(43);
const resources: Array<{
  app: ReturnType<typeof buildServer>;
  db: SqliteDatabase;
  dir: string;
  auth: AuthSessionManager;
}> = [];

class TestProcess implements AuthManagedProcess {
  readonly signals: string[] = [];
  readonly inputs: string[] = [];
  private readonly outputListeners = new Set<
    (stream: AuthOutputStream, chunk: string | Buffer) => void
  >();

  onOutput(listener: (stream: AuthOutputStream, chunk: string | Buffer) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onExit(): () => void {
    return () => {};
  }

  writeInput(value: string): void {
    this.inputs.push(value);
  }

  output(stream: AuthOutputStream, chunk: string): void {
    for (const listener of this.outputListeners) listener(stream, chunk);
  }

  signal(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(signal);
  }

  waitForExit(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class TestDriver implements ProviderAuthDriver {
  readonly providerId: AuthProviderId;
  readonly process = new TestProcess();
  launchCount = 0;
  readonly submittedCodes: string[] = [];

  constructor(providerId: AuthProviderId) {
    this.providerId = providerId;
  }

  isAlreadyAuthenticated(): Promise<boolean> {
    return Promise.resolve(false);
  }

  launch(): AuthManagedProcess {
    this.launchCount += 1;
    return this.process;
  }

  parseOutput(_stream: AuthOutputStream, line: string) {
    if (line !== 'auth-prompt') return undefined;
    return {
      awaitingUserAction: true,
      authorizationUrl:
        this.providerId === 'codex'
          ? 'https://auth.openai.com/codex/device'
          : 'https://accounts.google.com/o/oauth2/auth?state=synthetic',
      ...(this.providerId === 'codex' ? { userCode: 'ABCD-EFGH' } : {}),
      requiresCodeSubmission: this.providerId === 'antigravity',
    };
  }

  submitCode(process: AuthManagedProcess, code: string): void {
    this.submittedCodes.push(code);
    process.writeInput(`${code}\r`);
  }

  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createAuthApp(providerId: AuthProviderId = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-auth-web-'));
  const dbPath = path.join(dir, 'awm.db');
  const db = openDatabase(dbPath);
  const clock = new FakeClock(NOW);
  const repositories = createRepositories(db);
  repositories.providers.upsert({
    id: providerId,
    kind: providerId,
    enabled: true,
    mode: 'monitor_only',
    pollIntervalSeconds: 300,
    config: {},
    configVersion: 1,
    createdAtMs: Date.parse(NOW),
    updatedAtMs: Date.parse(NOW),
  });
  repositories.providerState.upsert({
    providerId,
    health: providerId === 'antigravity' ? 'AUTH_REQUIRED' : 'UP',
    observedAtMs: Date.parse(NOW),
    staleAfterMs: 300_000,
    observation: null,
    lastSuccessAtMs: Date.parse(NOW),
    lastErrorCode: null,
    updatedAtMs: Date.parse(NOW),
  });
  const adapter: ProviderAdapter = {
    id: providerId,
    capabilities: () => ({
      usageRead: { supported: true, contract: 'official_supported' },
      resetRead: { supported: true, contract: 'official_supported' },
      windowTrigger: { supported: false, contract: 'unknown', consumesQuota: 'unknown' },
    }),
    health: () => Promise.resolve('UP'),
    inspect: () => Promise.reject(new Error('web auth reads must not inspect a provider')),
    triggerWindow: () =>
      Promise.resolve({
        status: 'rejected',
        occurredAt: NOW,
        errorCode: 'TRIGGER_UNSUPPORTED',
      }),
  };
  const driver = new TestDriver(providerId);
  const auth = new AuthSessionManager({
    clock,
    drivers: new Map([[providerId, driver]]),
    sessionTimeoutMs: 60_000,
    processStopGraceMs: 5,
    onEvent: (event) => {
      repositories.events.append({
        occurredAtMs: clock.now().getTime(),
        providerId: event.providerId,
        type: event.type,
        severity:
          event.type === 'provider_auth_failed' || event.type === 'provider_auth_timed_out'
            ? 'warn'
            : 'info',
        reasonCode: event.reasonCode,
        data: {},
      });
    },
  });
  const app = buildServer({
    config: loadConfig({ AWM_DB_PATH: dbPath, AWM_LOG_LEVEL: 'silent' }),
    db,
    repositories,
    adapters: new Map([[providerId, adapter]]),
    clock,
    authSessions: auth,
  });
  resources.push({ app, db, dir, auth });
  return { app, auth, db, driver };
}

function setProviderHealth(health: 'UP' | 'DEGRADED') {
  const resource = resources.at(-1);
  if (!resource) throw new Error('auth app was not created');
  resource.db
    .prepare('UPDATE provider_state SET health = ? WHERE provider_id = ?')
    .run(health, 'codex');
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.auth.shutdown();
    await resource.app.close();
    resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

describe('provider auth routes', () => {
  it('renders connected state from persisted health and serves the reduced-motion onboarding styles without provider I/O', async () => {
    const { app } = createAuthApp();

    const settings = await app.inject('/settings');
    const status = await app.inject('/api/v1/providers/codex/auth/status');
    const styles = await app.inject('/assets/app.css');

    expect(settings.statusCode).toBe(200);
    expect(settings.body).toContain('Reconnect Codex');
    expect(settings.body).toContain('data-auth-state="SUCCEEDED"');
    expect(settings.body).toContain('Connected');
    expect(status.json()).toMatchObject({ providerId: 'codex', state: 'SUCCEEDED' });
    expect(styles.body).toContain('animation: online-pulse 1.8s ease-out infinite');
    expect(styles.body).toContain('prefers-reduced-motion');
  });

  it('protects auth session mutations with same-origin and CSRF checks', async () => {
    const { app, driver } = createAuthApp();

    for (const action of ['start', 'submit', 'cancel']) {
      const rejected = await app.inject({
        method: 'POST',
        url: `/api/v1/providers/codex/auth/${action}`,
        headers: { origin: 'null', host: '127.0.0.1:8787' },
      });
      const missingCsrf = await app.inject({
        method: 'POST',
        url: `/api/v1/providers/codex/auth/${action}`,
        headers: { origin: 'http://127.0.0.1:8787', host: '127.0.0.1:8787' },
      });

      expect(rejected.statusCode).toBe(403);
      expect(rejected.json()).toMatchObject({ error: { code: 'ORIGIN_REJECTED' } });
      expect(missingCsrf.statusCode).toBe(403);
      expect(missingCsrf.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });
    }
    expect(driver.launchCount).toBe(0);
  });

  it('recognizes a successful partial provider inspection as connected', async () => {
    const { app } = createAuthApp();
    setProviderHealth('DEGRADED');

    const response = await app.inject('/api/v1/providers/codex/auth/status');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ providerId: 'codex', state: 'SUCCEEDED' });
  });

  it('starts the provider-owned login flow only after same-origin CSRF validation', async () => {
    const { app, auth, driver } = createAuthApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/codex/auth/start',
      headers: {
        origin: 'http://127.0.0.1:8787',
        host: '127.0.0.1:8787',
        cookie: `awm_csrf=${CSRF}`,
        'x-csrf-token': CSRF,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ providerId: 'codex', state: 'STARTING' });
    expect(driver.launchCount).toBeLessThanOrEqual(1);
    await auth.shutdown();
  });

  it('forwards a one-time Antigravity code only to the active official process', async () => {
    const { app, auth, db, driver } = createAuthApp('antigravity');
    const headers = {
      origin: 'http://127.0.0.1:8787',
      host: '127.0.0.1:8787',
      cookie: `awm_csrf=${CSRF}`,
      'x-csrf-token': CSRF,
    };

    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/antigravity/auth/start',
      headers,
    });
    await flushMicrotasks();
    driver.process.output('stdout', 'auth-prompt\n');
    const awaiting = await app.inject('/api/v1/providers/antigravity/auth/status');
    const code = '4/0AbC-DEfGh=';
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/antigravity/auth/submit',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { code },
    });

    expect(started.statusCode).toBe(202);
    expect(awaiting.statusCode).toBe(200);
    expect(awaiting.json()).toMatchObject({
      providerId: 'antigravity',
      state: 'AWAITING_USER_ACTION',
      requiresCodeSubmission: true,
    });
    expect(submitted.statusCode).toBe(202);
    expect(submitted.body).not.toContain(code);
    expect(driver.submittedCodes).toEqual([code]);
    expect(driver.process.inputs).toEqual([`${code}\r`]);

    const history = db.prepare('SELECT type, reason_code, data_json FROM events').all();
    expect(JSON.stringify(history)).not.toContain(code);
    await auth.shutdown();
  });

  it('cancels a running provider sign-in through the protected API', async () => {
    const { app, auth, driver } = createAuthApp();
    const headers = {
      origin: 'http://127.0.0.1:8787',
      host: '127.0.0.1:8787',
      cookie: `awm_csrf=${CSRF}`,
      'x-csrf-token': CSRF,
    };
    await app.inject({
      method: 'POST',
      url: '/api/v1/providers/codex/auth/start',
      headers,
    });
    await flushMicrotasks();
    driver.process.output('stderr', 'auth-prompt\n');

    const canceled = await app.inject({
      method: 'POST',
      url: '/api/v1/providers/codex/auth/cancel',
      headers,
    });

    expect(canceled.statusCode).toBe(200);
    expect(canceled.json()).toMatchObject({ providerId: 'codex', state: 'CANCELED' });
    expect(driver.process.signals).toContain('SIGTERM');
    await auth.shutdown();
  });

  it('does not expose auth sessions for providers absent from the runtime registry', async () => {
    const { app } = createAuthApp();
    const response = await app.inject('/api/v1/providers/antigravity/auth/status');
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('secret');
  });
});
