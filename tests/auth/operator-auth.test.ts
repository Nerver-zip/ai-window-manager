import { describe, expect, it } from 'vitest';
import { OperatorAuthService, OperatorSessionStore } from '../../src/auth/operator-auth.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { TEST_OPERATOR_PASSWORD_HASH } from '../helpers/operator-auth.js';

const START = '2026-09-25T12:00:00.000Z';

function makeAuth(
  clock: FakeClock,
  verifyPassword: (password: string, hash: string) => Promise<boolean> = () =>
    Promise.resolve(true),
) {
  return new OperatorAuthService({
    username: 'operator',
    passwordHash: TEST_OPERATOR_PASSWORD_HASH,
    sessionTtlMs: 15 * 60 * 1000,
    clock,
    verifyPassword,
  });
}

describe('operator sessions', () => {
  it('creates opaque, expiring sessions and supports individual and bulk invalidation', () => {
    const clock = new FakeClock(START);
    const store = new OperatorSessionStore(clock, 60_000);
    const first = store.create();
    const second = store.create();

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.token).not.toBe(second.token);
    expect(first.expiresAtMs).toBe(Date.parse(START) + 60_000);
    expect(store.has(first.token)).toBe(true);
    expect(store.has('malformed')).toBe(false);
    expect(store.destroy(first.token)).toBe(true);
    expect(store.destroy(first.token)).toBe(false);
    expect(store.has(first.token)).toBe(false);
    expect(store.has(second.token)).toBe(true);

    store.clear();
    expect(store.has(second.token)).toBe(false);
  });

  it('expires old sessions and evicts the oldest session at the bounded capacity', () => {
    const clock = new FakeClock(START);
    const store = new OperatorSessionStore(clock, 60_000);
    const expired = store.create();
    clock.advanceMs(60_000);
    expect(store.has(expired.token)).toBe(false);
    const current = store.create();
    for (let index = 0; index < 16; index += 1) store.create();
    expect(store.has(current.token)).toBe(false);
    expect(store.destroy(undefined)).toBe(false);
  });

  it('rejects invalid lifetime and malformed random token sources', () => {
    const clock = new FakeClock(START);
    expect(() => new OperatorSessionStore(clock, 0)).toThrow(/Invalid operator session lifetime/);
    const invalidRandom = new OperatorSessionStore(clock, 60_000, () => Buffer.from([1]));
    expect(() => invalidRandom.create()).toThrow(/Invalid session token source/);
  });
});

describe('single-operator login', () => {
  it('creates a session only for the configured username and verified password', async () => {
    const clock = new FakeClock(START);
    let checks = 0;
    const auth = makeAuth(clock, (password, hash) => {
      checks += 1;
      return Promise.resolve(
        password === 'synthetic-correct-password' && hash === TEST_OPERATOR_PASSWORD_HASH,
      );
    });

    const wrongUser = await auth.login('other', 'synthetic-correct-password', '192.0.2.1');
    expect(wrongUser).toEqual({ status: 'invalid_credentials' });
    expect(checks).toBe(1);

    const wrongPassword = await auth.login('operator', 'synthetic-wrong-password', '192.0.2.1');
    expect(wrongPassword).toEqual({ status: 'invalid_credentials' });
    const success = await auth.login('operator', 'synthetic-correct-password', '192.0.2.1');
    expect(success.status).toBe('authenticated');
    if (success.status === 'authenticated') {
      expect(auth.sessions.has(success.session.token)).toBe(true);
      expect(success.session.expiresAtMs).toBe(Date.parse(START) + 15 * 60 * 1000);
    }
    expect(checks).toBe(3);
  });

  it('throttles repeated failures per source, then permits another attempt after the window', async () => {
    const clock = new FakeClock(START);
    const auth = makeAuth(clock, () => Promise.resolve(false));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        auth.login('operator', 'synthetic-wrong-password', '192.0.2.2'),
      ).resolves.toEqual({ status: 'invalid_credentials' });
    }
    await expect(auth.login('operator', 'synthetic-wrong-password', '192.0.2.2')).resolves.toEqual({
      status: 'too_many_attempts',
      retryAfterSeconds: 300,
    });

    clock.advanceMs(5 * 60 * 1000);
    await expect(
      auth.login('operator', 'synthetic-correct-password', '192.0.2.2'),
    ).resolves.toMatchObject({ status: 'invalid_credentials' });
    await expect(
      auth.login('operator', 'synthetic-correct-password', '192.0.2.3'),
    ).resolves.toMatchObject({ status: 'invalid_credentials' });
  });

  it('applies a bounded global failure limit across rotating sources', async () => {
    const clock = new FakeClock(START);
    const auth = makeAuth(clock, (password) =>
      Promise.resolve(password === 'synthetic-correct-password'),
    );

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await expect(
        auth.login('operator', 'synthetic-wrong-password', `192.0.2.${attempt + 1}`),
      ).resolves.toEqual({ status: 'invalid_credentials' });
    }

    await expect(
      auth.login('operator', 'synthetic-correct-password', '198.51.100.1'),
    ).resolves.toEqual({ status: 'too_many_attempts', retryAfterSeconds: 300 });

    clock.advanceMs(5 * 60 * 1000);
    const success = await auth.login('operator', 'synthetic-correct-password', '198.51.100.1');
    expect(success.status).toBe('authenticated');
  });

  it('bounds malformed credentials and maps verifier errors to invalid credentials', async () => {
    const clock = new FakeClock(START);
    let checked = 0;
    const auth = makeAuth(clock, () => {
      checked += 1;
      return Promise.reject(new Error('synthetic verifier failure'));
    });

    await expect(auth.login('bad username', 'synthetic', '')).resolves.toEqual({
      status: 'invalid_credentials',
    });
    await expect(auth.login('x'.repeat(65), 'synthetic', 'x'.repeat(140))).resolves.toEqual({
      status: 'invalid_credentials',
    });
    await expect(auth.login('operator', 'x'.repeat(1025), '192.0.2.20')).resolves.toEqual({
      status: 'invalid_credentials',
    });
    expect(checked).toBe(0);

    await expect(auth.login('operator', 'synthetic', '192.0.2.20')).resolves.toEqual({
      status: 'invalid_credentials',
    });
    expect(checked).toBe(1);
  });

  it('limits concurrent password checks per source and globally', async () => {
    const clock = new FakeClock(START);
    const releases: Array<(valid: boolean) => void> = [];
    const auth = makeAuth(clock, () => new Promise<boolean>((resolve) => releases.push(resolve)));

    const first = auth.login('operator', 'synthetic-password', '192.0.2.10');
    await Promise.resolve();
    await expect(auth.login('operator', 'synthetic-password', '192.0.2.10')).resolves.toEqual({
      status: 'too_many_attempts',
      retryAfterSeconds: 2,
    });
    const second = auth.login('operator', 'synthetic-password', '192.0.2.11');
    await Promise.resolve();
    await expect(auth.login('operator', 'synthetic-password', '192.0.2.12')).resolves.toEqual({
      status: 'too_many_attempts',
      retryAfterSeconds: 2,
    });
    releases[0]?.(true);
    releases[1]?.(true);
    await expect(first).resolves.toMatchObject({ status: 'authenticated' });
    await expect(second).resolves.toMatchObject({ status: 'authenticated' });
  });

  it('clears sessions when requested by process shutdown', async () => {
    const auth = makeAuth(new FakeClock(START));
    const result = await auth.login('operator', 'synthetic-password', 'unknown');
    if (result.status !== 'authenticated') throw new Error('test login did not succeed');
    expect(auth.sessions.has(result.session.token)).toBe(true);
    auth.clearSessions();
    expect(auth.sessions.has(result.session.token)).toBe(false);
  });
});
