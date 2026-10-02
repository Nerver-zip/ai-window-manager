import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_SESSION_COOKIE_NAME, OperatorAuthService } from '../../src/auth/operator-auth.js';
import { loadConfig } from '../../src/config.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import { createRepositories } from '../../src/storage/repositories.js';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '../../src/web/security.js';
import { buildServer } from '../../src/web/server.js';

const NOW = '2026-09-25T12:00:00.000Z';
const HOST = 'localhost:8787';
const ORIGIN = `http://${HOST}`;
const OPERATOR_USERNAME = 'route-test-operator';
const OPERATOR_PASSWORD = 'synthetic-only-route-test-password';
const SYNTHETIC_SALT = Buffer.from('synthetic-route-test-salt-01')
  .toString('base64')
  .replace(/=+$/u, '');
const SYNTHETIC_HASH = Buffer.alloc(32, 0x5a).toString('base64').replace(/=+$/u, '');
const OPERATOR_PASSWORD_HASH = `$argon2id$v=19$m=19456,t=2,p=1$${SYNTHETIC_SALT}$${SYNTHETIC_HASH}`;

const resources: Array<{
  app: ReturnType<typeof buildServer>;
  db: SqliteDatabase;
  directory: string;
}> = [];

function createContext(
  trustedProxy = '',
  requestRateLimitForTests?: { maxRequests: number; timeWindowMs: number },
  metricsDigest = '',
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-operator-auth-routes-'));
  const db = openDatabase(path.join(directory, 'window-manager.db'));
  const repositories = createRepositories(db);
  const clock = new FakeClock(NOW);
  const config = loadConfig({
    AWM_DB_PATH: path.join(directory, 'window-manager.db'),
    AWM_LOG_LEVEL: 'silent',
    AWM_AUTH_USERNAME: OPERATOR_USERNAME,
    AWM_AUTH_PASSWORD_HASH: OPERATOR_PASSWORD_HASH,
    AWM_AUTH_SESSION_TTL_SECONDS: '900',
    AWM_TRUST_PROXY: trustedProxy,
    AWM_METRICS_TOKEN_SHA256: metricsDigest,
  });
  const verifyPassword = vi.fn((password: string) =>
    Promise.resolve(password === OPERATOR_PASSWORD),
  );
  const operatorAuth = new OperatorAuthService({
    username: config.AWM_AUTH_USERNAME,
    passwordHash: config.AWM_AUTH_PASSWORD_HASH,
    sessionTtlMs: config.AWM_AUTH_SESSION_TTL_SECONDS * 1000,
    clock,
    verifyPassword,
  });
  const app = buildServer({
    config,
    db,
    repositories,
    adapters: new Map(),
    clock,
    operatorAuth,
    ...(requestRateLimitForTests ? { requestRateLimitForTests } : {}),
  });
  resources.push({ app, db, directory });
  return { app, db, directory, operatorAuth, verifyPassword, clock };
}

function cookieHeaders(value: string | string[] | undefined): string[] {
  if (typeof value === 'string') return [value];
  return value ?? [];
}

function readCookieValue(headers: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const entry = headers.find((header) => header.startsWith(prefix));
  return entry?.slice(prefix.length).split(';', 1)[0];
}

function formPayload(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    resource.db.close();
    fs.rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('operator authentication route protection', () => {
  it('restricts the technical credential to metrics, supports restart and revocation', async () => {
    const token = 'synthetic-route-metrics-'.padEnd(43, 'x');
    const digest = createHash('sha256').update(token).digest('hex');
    const headers = { authorization: `Bearer ${token}` };
    const first = createContext('', undefined, digest);
    const oldSession = first.operatorAuth.sessions.create().token;
    for (const context of [first, createContext('', undefined, digest)]) {
      expect((await context.app.inject({ url: '/metrics', headers })).statusCode).toBe(200);
      const head = await context.app.inject({ method: 'HEAD', url: '/metrics', headers });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe('');
      for (const url of ['/metrics?token=' + token, '/api/v1/diagnostics', '/api/v1/providers']) {
        expect((await context.app.inject({ url, headers })).statusCode, url).toBe(401);
      }
      expect(
        (await context.app.inject({ method: 'POST', url: '/metrics', headers })).statusCode,
      ).toBe(401);
      for (const url of ['/', '/logs', '/logout', '/metrics/', '/%6Detrics']) {
        expect((await context.app.inject({ url, headers })).statusCode, url).not.toBe(200);
      }
      const login = await context.app.inject({ url: '/login', headers });
      expect(login.body).not.toContain(token);
      expect(login.body).not.toContain(digest);
    }
    const restarted = createContext('', undefined, digest);
    expect(
      (
        await restarted.app.inject({
          url: '/metrics',
          headers: { cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${oldSession}` },
        })
      ).statusCode,
    ).toBe(401);
    for (const context of [createContext(), createContext('', undefined, 'a'.repeat(64))]) {
      expect((await context.app.inject({ url: '/metrics', headers })).statusCode).toBe(401);
      const session = context.operatorAuth.sessions.create().token;
      expect(
        (
          await context.app.inject({
            url: '/metrics',
            headers: { cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${session}` },
          })
        ).statusCode,
      ).toBe(200);
    }
    expect(
      (
        await first.app.inject({
          url: '/metrics',
          headers: {
            cookie: `provider_token=${token}`,
            'x-forwarded-authorization': headers.authorization,
          },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await first.app.inject({ method: 'POST', url: '/metrics', payload: { token } })).statusCode,
    ).toBe(401);
  });
  it('keeps only health, assets, and login public while protecting app, API, and metrics routes', async () => {
    const { app } = createContext();

    const health = await app.inject({ url: '/healthz', headers: { host: HOST } });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    for (const route of [
      '/assets/app.css',
      '/assets/app.js',
      '/assets/images/logo.png',
      '/assets/images/providers/codex.png',
      '/favicon.ico',
      '/login',
    ]) {
      const response = await app.inject({ url: route, headers: { host: HOST } });
      expect(response.statusCode, route).toBe(200);
    }
    const unknownAsset = await app.inject({
      url: '/assets/images/not-bundled.svg',
      headers: { host: HOST },
    });
    expect(unknownAsset.statusCode).toBe(404);

    for (const route of [
      '/',
      '/usage',
      '/schedule',
      '/schedule/preview',
      '/history',
      '/logs',
      '/settings',
      '/logout',
    ]) {
      const response = await app.inject({ url: route, headers: { host: HOST } });
      expect(response.statusCode, route).toBe(303);
      expect(response.headers.location).toContain('/login?next=');
    }

    for (const route of [
      '/api/v1/providers',
      '/api/v1/settings',
      '/api/v1/scheduling',
      '/api/v1/usage',
      '/api/v1/history',
      '/api/v1/providers/codex',
      '/api/v1/providers/codex/auth/status',
      '/metrics',
    ]) {
      const response = await app.inject({ url: route, headers: { host: HOST } });
      expect(response.statusCode, route).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    }

    const anonymousMutation = await app.inject({
      method: 'POST',
      url: '/settings/timezone',
      headers: { host: HOST, origin: ORIGIN },
      payload: '',
    });
    expect(anonymousMutation.statusCode).toBe(401);
    expect(anonymousMutation.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });

    for (const route of [
      '/logout',
      '/api/v1/providers/codex/auth/start',
      '/api/v1/providers/codex/auth/submit',
      '/api/v1/providers/codex/auth/cancel',
      '/api/v1/providers/codex/inspect',
      '/api/v1/providers/codex/trigger',
      '/providers/codex/trigger',
    ]) {
      const response = await app.inject({ method: 'POST', url: route, headers: { host: HOST } });
      expect(response.statusCode, route).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
    }
  });

  it('limits requests per resolved client, expires the window, and leaves health polling usable', async () => {
    const start = new Date();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    try {
      const { app } = createContext('', { maxRequests: 2, timeWindowMs: 60_000 });
      const health = (remoteAddress: string, forwardedFor?: string) =>
        app.inject({
          url: '/healthz',
          remoteAddress,
          headers: {
            host: HOST,
            ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
          },
        });

      expect((await health('192.0.2.41')).statusCode).toBe(200);
      expect((await health('192.0.2.41', '198.51.100.81')).statusCode).toBe(200);
      const blocked = await health('192.0.2.41');
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBeDefined();
      expect(blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });

      expect((await health('192.0.2.42')).statusCode).toBe(200);

      vi.setSystemTime(new Date(start.getTime() + 60_001));
      expect((await health('192.0.2.41')).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the stricter provider-client operation limit', async () => {
    const { app, operatorAuth } = createContext();
    const token = operatorAuth.sessions.create().token;
    const csrfToken = 'a'.repeat(43);
    const request = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/provider-clients/codex/check',
        headers: {
          host: HOST,
          origin: ORIGIN,
          cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${token}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
          [CSRF_HEADER_NAME]: csrfToken,
        },
      });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await request();
      expect(response.statusCode, response.body).toBe(503);
    }
    const blocked = await request();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('bounds provider sign-in operations separately from ordinary requests', async () => {
    const { app, operatorAuth } = createContext();
    const token = operatorAuth.sessions.create().token;
    const csrfToken = 'b'.repeat(43);
    const request = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/providers/codex/auth/submit',
        headers: {
          host: HOST,
          origin: ORIGIN,
          cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${token}; ${CSRF_COOKIE_NAME}=${csrfToken}`,
          [CSRF_HEADER_NAME]: csrfToken,
        },
        payload: { code: 'synthetic-code' },
      });

    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect((await request()).statusCode).toBe(404);
    }
    const blocked = await request();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('authenticates a same-origin form and grants private reads', async () => {
    const { app, operatorAuth, verifyPassword } = createContext();
    const loginPage = await app.inject({
      url: '/login?next=%2Fschedule',
      headers: { host: HOST, 'x-forwarded-proto': 'https' },
    });
    const initialCookies = cookieHeaders(loginPage.headers['set-cookie']);
    const csrfToken = readCookieValue(initialCookies, CSRF_COOKIE_NAME);

    expect(loginPage.statusCode).toBe(200);
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(initialCookies.join('; ')).not.toContain('Secure');

    const login = await app.inject({
      method: 'POST',
      url: '/login',
      headers: {
        host: HOST,
        'x-forwarded-proto': 'https',
        origin: ORIGIN,
        cookie: `${CSRF_COOKIE_NAME}=${csrfToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formPayload({
        username: OPERATOR_USERNAME,
        password: OPERATOR_PASSWORD,
        csrfToken: csrfToken!,
        next: '/schedule',
      }),
    });
    const loginCookies = cookieHeaders(login.headers['set-cookie']);
    const sessionCookie = loginCookies.find((cookie) => cookie.startsWith('awm_session='));
    const sessionToken = readCookieValue(loginCookies, 'awm_session');
    const authenticatedCsrf = readCookieValue(loginCookies, CSRF_COOKIE_NAME);

    expect(login.statusCode).toBe(303);
    expect(login.headers.location).toBe('/schedule');
    expect(login.headers['cache-control']).toContain('no-store');
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict');
    expect(sessionCookie).not.toContain('Secure');
    expect(sessionCookie).not.toMatch(/Domain=/iu);
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(authenticatedCsrf).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(operatorAuth.sessions.has(sessionToken)).toBe(true);
    expect(verifyPassword).toHaveBeenCalledTimes(1);

    const cookie = `awm_session=${sessionToken}; ${CSRF_COOKIE_NAME}=${authenticatedCsrf}`;
    for (const route of ['/', '/schedule']) {
      const response = await app.inject({ url: route, headers: { host: HOST, cookie } });
      expect(response.statusCode, route).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
    }
    for (const route of ['/api/v1/providers', '/api/v1/settings', '/metrics']) {
      const response = await app.inject({ url: route, headers: { host: HOST, cookie } });
      expect(response.statusCode, route).toBe(200);
      expect(response.headers['cache-control']).toContain('no-store');
    }

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/settings/timezone',
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'timezone=UTC',
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });
  });

  it('sets Secure cookies for HTTPS reported by an explicitly trusted proxy', async () => {
    const { app } = createContext('127.0.0.1');
    const loginPage = await app.inject({
      url: '/login',
      headers: { host: HOST, 'x-forwarded-proto': 'https' },
    });
    const loginPageCookies = cookieHeaders(loginPage.headers['set-cookie']);
    const csrfToken = readCookieValue(loginPageCookies, CSRF_COOKIE_NAME);

    expect(loginPageCookies.join('; ')).toContain('Secure');

    const login = await app.inject({
      method: 'POST',
      url: '/login',
      headers: {
        host: HOST,
        'x-forwarded-proto': 'https',
        origin: `https://${HOST}`,
        cookie: `${CSRF_COOKIE_NAME}=${csrfToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formPayload({
        username: OPERATOR_USERNAME,
        password: OPERATOR_PASSWORD,
        csrfToken: csrfToken!,
      }),
    });

    expect(login.statusCode).toBe(303);
    expect(
      cookieHeaders(login.headers['set-cookie']).every((value) => value.includes('Secure')),
    ).toBe(true);
  });

  it('expires old sessions and accepts only safe internal return paths', async () => {
    const { app, operatorAuth, clock } = createContext();
    const session = operatorAuth.sessions.create();
    clock.advanceMs(900_000);

    const expired = await app.inject({
      url: '/usage',
      headers: { host: HOST, cookie: `awm_session=${session.token}` },
    });
    expect(expired.statusCode).toBe(303);
    expect(expired.headers.location).toContain('reason=session_expired');
    expect(expired.headers.location).toContain('next=%2Fusage');
    expect(operatorAuth.sessions.has(session.token)).toBe(false);

    const freshSession = operatorAuth.sessions.create();
    const accepted = await app.inject({
      url: '/login?next=%2Fusage%3Fprovider%3Dcodex',
      headers: { host: HOST, cookie: `awm_session=${freshSession.token}` },
    });
    expect(accepted.statusCode).toBe(303);
    expect(accepted.headers.location).toBe('/usage?provider=codex');

    for (const target of [
      'https://evil.example/',
      '//evil.example/',
      '///evil.example/',
      'javascript:alert(1)',
      '\\evil.example',
      '/usage\nforged-header',
    ]) {
      const response = await app.inject({
        url: `/login?next=${encodeURIComponent(target)}`,
        headers: { host: HOST, cookie: `awm_session=${freshSession.token}` },
      });
      expect(response.statusCode, target).toBe(303);
      expect(response.headers.location, target).toBe('/');
    }
  });

  it('rejects login without CSRF or with a cross-origin Origin before verifying credentials', async () => {
    const { app, verifyPassword } = createContext();
    const loginPage = await app.inject({ url: '/login', headers: { host: HOST } });
    const csrfToken = readCookieValue(
      cookieHeaders(loginPage.headers['set-cookie']),
      CSRF_COOKIE_NAME,
    );
    const payload = formPayload({
      username: OPERATOR_USERNAME,
      password: OPERATOR_PASSWORD,
      csrfToken: csrfToken!,
    });

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/login',
      headers: {
        host: HOST,
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload,
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });

    const crossOrigin = await app.inject({
      method: 'POST',
      url: '/login',
      headers: {
        host: HOST,
        origin: 'https://untrusted.example',
        cookie: `${CSRF_COOKIE_NAME}=${csrfToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload,
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toMatchObject({ error: { code: 'ORIGIN_REJECTED' } });
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('uses indistinguishable login failures and never echoes submitted credentials', async () => {
    const { app } = createContext();
    const loginPage = await app.inject({ url: '/login', headers: { host: HOST } });
    const csrfToken = readCookieValue(
      cookieHeaders(loginPage.headers['set-cookie']),
      CSRF_COOKIE_NAME,
    );
    const attempt = async (username: string, password: string) =>
      app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          host: HOST,
          origin: ORIGIN,
          cookie: `${CSRF_COOKIE_NAME}=${csrfToken}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: formPayload({ username, password, csrfToken: csrfToken! }),
      });

    const wrongUsername = await attempt('unknown-operator', OPERATOR_PASSWORD);
    const wrongPassword = await attempt(OPERATOR_USERNAME, 'synthetic-wrong-password');

    expect(wrongUsername.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongUsername.body).toBe(wrongPassword.body);
    expect(wrongUsername.body).toContain('Invalid username or password.');
    expect(wrongUsername.body).not.toContain('unknown-operator');
    expect(wrongUsername.body).not.toContain(OPERATOR_PASSWORD);
    expect(wrongPassword.body).not.toContain('synthetic-wrong-password');
  });

  it('keeps attacker-controlled login redirect and reason values inert in HTML', async () => {
    const { app } = createContext();
    const target = '/?notice="%3E%3Csvg/onload=alert(1)%3E';
    const reason = '<img src=x onerror=awm_xss_probe>';
    const loginPage = await app.inject({
      url: `/login?next=${encodeURIComponent(target)}&reason=${encodeURIComponent(reason)}`,
      headers: { host: HOST },
    });
    const csrfToken = readCookieValue(
      cookieHeaders(loginPage.headers['set-cookie']),
      CSRF_COOKIE_NAME,
    );
    const failedLogin = await app.inject({
      method: 'POST',
      url: '/login',
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: `${CSRF_COOKIE_NAME}=${csrfToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formPayload({
        username: 'unknown-operator',
        password: 'synthetic-invalid-password',
        csrfToken: csrfToken!,
        next: target,
      }),
    });

    expect(loginPage.statusCode).toBe(200);
    expect(failedLogin.statusCode).toBe(401);
    for (const response of [loginPage, failedLogin]) {
      expect(response.body.toLowerCase()).not.toContain('<svg');
      expect(response.body.toLowerCase()).not.toContain('<img src=x onerror=awm_xss_probe>');
      expect(response.body).not.toContain('awm_xss_probe');
    }
    expect(failedLogin.body).toContain('Invalid username or password.');
  });

  it('returns a bounded 429 with Retry-After after five failures from one source', async () => {
    const { app, clock } = createContext();
    const loginPage = await app.inject({ url: '/login', headers: { host: HOST } });
    const csrfToken = readCookieValue(
      cookieHeaders(loginPage.headers['set-cookie']),
      CSRF_COOKIE_NAME,
    );
    const attempt = (password: string) =>
      app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          host: HOST,
          origin: ORIGIN,
          cookie: `${CSRF_COOKIE_NAME}=${csrfToken}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: formPayload({ username: OPERATOR_USERNAME, password, csrfToken: csrfToken! }),
      });

    for (let index = 0; index < 5; index += 1) {
      expect((await attempt('synthetic-wrong-password')).statusCode).toBe(401);
    }
    const blocked = await attempt(OPERATOR_PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('300');
    expect(blocked.body).toContain('Too many sign-in attempts. Try again shortly.');

    clock.advanceMs(5 * 60 * 1000);
    expect((await attempt(OPERATOR_PASSWORD)).statusCode).toBe(303);
  });

  it('requires an authenticated session for logout, then uses same-origin CSRF and invalidates it', async () => {
    const { app, operatorAuth } = createContext();
    const session = operatorAuth.sessions.create();
    const logoutPage = await app.inject({
      url: '/logout',
      headers: { host: HOST, cookie: `awm_session=${session.token}` },
    });
    const csrfToken = readCookieValue(
      cookieHeaders(logoutPage.headers['set-cookie']),
      CSRF_COOKIE_NAME,
    );
    const cookie = `awm_session=${session.token}; ${CSRF_COOKIE_NAME}=${csrfToken}`;

    expect(logoutPage.statusCode).toBe(200);
    expect(operatorAuth.sessions.has(session.token)).toBe(true);
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const rejectedOrigin = await app.inject({
      method: 'POST',
      url: '/logout',
      headers: {
        host: HOST,
        origin: 'https://untrusted.example',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formPayload({ csrfToken: csrfToken! }),
    });
    expect(rejectedOrigin.statusCode).toBe(403);
    expect(rejectedOrigin.json()).toMatchObject({ error: { code: 'ORIGIN_REJECTED' } });
    expect(operatorAuth.sessions.has(session.token)).toBe(true);

    const logout = await app.inject({
      method: 'POST',
      url: '/logout',
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: formPayload({ csrfToken: csrfToken! }),
    });
    const clearedCookies = cookieHeaders(logout.headers['set-cookie']);

    expect(logout.statusCode).toBe(303);
    expect(logout.headers.location).toBe('/login');
    expect(operatorAuth.sessions.has(session.token)).toBe(false);
    expect(
      clearedCookies.some(
        (value) => value.startsWith('awm_session=') && value.includes('Max-Age=0'),
      ),
    ).toBe(true);
  });
});
