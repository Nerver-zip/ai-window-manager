import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/scheduler/clock.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import { ProviderInspectionCoordinator } from '../../src/providers/inspection-coordinator.js';
import { readBackoffDelay } from '../../src/providers/read-backoff-policy.js';
import {
  ProviderReadBackoff,
  ProviderReadDeferredError,
} from '../../src/storage/provider-read-backoff.js';
import { openDatabase } from '../../src/storage/database.js';
import type { ProviderAdapter } from '../../src/providers/provider.js';

const resources: Array<{ db: ReturnType<typeof openDatabase>; dir: string }> = [];
afterEach(() => {
  for (const { db, dir } of resources.splice(0)) {
    if (db.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-read-backoff-'));
  const file = path.join(dir, 'awm.db');
  const db = openDatabase(file);
  resources.push({ db, dir });
  db.exec(`INSERT INTO providers (id, kind, enabled, mode, poll_interval_seconds, config_json, config_version, created_at_ms, updated_at_ms)
    VALUES ('fake', 'fake', 1, 'monitor_only', 30, '{}', 1, 1, 1)`);
  const clock = new FakeClock('2026-10-02T12:00:00Z');
  const backoff = new ProviderReadBackoff({
    db,
    clock,
    random: () => 0,
    pollIntervalMs: () => 30_000,
  });
  const fake = new FakeProvider(clock);
  return { db, dir, file, clock, backoff, fake };
}

describe('provider read backoff', () => {
  it('calculates exponential capped jitter and validates official retry-after independently', () => {
    const delay = (failures: number, jitter = 0, retryAfterSeconds?: unknown) =>
      readBackoffDelay({
        failures,
        jitter,
        retryAfterSeconds,
        kind: 'unavailable',
        pollIntervalMs: 30_000,
      });
    expect([1, 2, 3, 4, 5, 6].map((n) => delay(n))).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
    expect(delay(1, 1)).toBe(36_000);
    expect(delay(5, 1)).toBe(300_000);
    expect(delay(1, 0, 600)).toBe(600_000);
    expect(delay(1, 0, 1e100)).toBe(3_600_000);
    for (const invalid of [NaN, Infinity, -1, '600', null])
      expect(delay(1, 0, invalid)).toBe(30_000);
    expect(
      readBackoffDelay({ failures: 1, jitter: 0, kind: 'auth_required', pollIntervalMs: 30_000 }),
    ).toBe(900_000);
    expect(
      readBackoffDelay({ failures: 50, jitter: 0, kind: 'auth_required', pollIntervalMs: 30_000 }),
    ).toBe(3_600_000);
    for (const invalid of [
      { failures: 0, jitter: 0 },
      { failures: 1, jitter: 2 },
      { failures: 1, jitter: NaN },
    ])
      expect(() =>
        readBackoffDelay({ ...invalid, kind: 'unavailable', pollIntervalMs: 30_000 }),
      ).toThrow(RangeError);
  });

  it('limits an hour of outage across purposes and bursts without caching success or dispatching', async () => {
    const { clock, backoff, fake } = setup();
    let reads = 0;
    let up = false;
    const adapter: ProviderAdapter = {
      id: 'fake',
      capabilities: () => fake.capabilities(),
      health: (ctx) => fake.health(ctx),
      inspect: (ctx) => {
        reads++;
        if (!up)
          return Promise.reject(
            Object.assign(new Error('synthetic outage'), { code: 'ETIMEDOUT' }),
          );
        return fake.inspect(ctx);
      },
    };
    const coordinator = new ProviderInspectionCoordinator({ backoff });
    for (let seconds = 0; seconds < 3600; seconds += 5) {
      await Promise.allSettled([
        coordinator.inspect(adapter),
        ...Array.from({ length: 10 }, () => coordinator.inspectFresh(adapter, {}, 'confirmation')),
      ]);
      clock.advanceMs(5000);
    }
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThanOrEqual(17);
    expect(backoff.retryAtMs('fake', 'preflight')).toBeGreaterThan(clock.now().getTime());
    up = true;
    clock.advanceMs(backoff.retryAtMs('fake', 'preflight') - clock.now().getTime());
    await coordinator.inspectFresh(adapter, {}, 'confirmation');
    expect(backoff.retryAtMs('fake', 'reconcile')).toBe(0);
    const previous = reads;
    await coordinator.inspect(adapter);
    expect(reads).toBe(previous + 1);
    await coordinator.close();
  });

  it('keeps auth-required conservative while allowing separately bounded explicit login verification', async () => {
    const { clock, backoff, fake } = setup();
    let reads = 0;
    let authenticated = false;
    const adapter: ProviderAdapter = {
      id: 'fake',
      capabilities: () => fake.capabilities(),
      health: (ctx) => fake.health(ctx),
      inspect: async (ctx) => {
        reads++;
        const observation = await fake.inspect(ctx);
        return { ...observation, health: authenticated ? 'UP' : 'AUTH_REQUIRED' };
      },
    };
    const coordinator = new ProviderInspectionCoordinator({ backoff });
    for (let seconds = 0; seconds < 3600; seconds += 5) {
      await coordinator.inspect(adapter).catch(() => undefined);
      clock.advanceMs(5000);
    }
    expect(reads).toBeLessThanOrEqual(3);
    await coordinator.inspectFresh(adapter, {}, 'auth_check');
    await expect(coordinator.inspectFresh(adapter, {}, 'auth_check')).rejects.toBeInstanceOf(
      ProviderReadDeferredError,
    );
    authenticated = true;
    await coordinator.inspectFresh(adapter, {}, 'auth_verify');
    expect(backoff.retryAtMs('fake', 'reconcile')).toBe(0);
    expect(backoff.retryAtMs('fake', 'auth_check')).toBe(0);
    await coordinator.close();
  });

  it('persists gate/streak across reopening and does not count deferred requests as failures', () => {
    const { db, dir, file, clock, backoff } = setup();
    backoff.failed('fake', 'reconcile', 'unavailable');
    const deadline = backoff.retryAtMs('fake', 'confirmation');
    db.close();
    const reopened = openDatabase(file);
    resources.push({ db: reopened, dir });
    const next = new ProviderReadBackoff({
      db: reopened,
      clock,
      random: () => 0,
      pollIntervalMs: () => 30_000,
    });
    for (let n = 0; n < 100; n++)
      expect(() => next.assertAllowed('fake', 'preflight')).toThrow(ProviderReadDeferredError);
    expect(next.retryAtMs('fake', 'resolution')).toBe(deadline);
    clock.advanceMs(30_000);
    next.assertAllowed('fake', 'preflight');
    next.failed('fake', 'confirmation', 'unavailable');
    expect(next.retryAtMs('fake', 'reconcile')).toBe(clock.now().getTime() + 60_000);
    next.succeeded('fake');
    expect(next.retryAtMs('fake', 'confirmation')).toBe(0);
    expect(() => next.retryAtMs('fake', 'injected' as 'preflight')).toThrow();
    next.failed('fake', 'reconcile', 'unavailable');
    reopened.prepare('DELETE FROM providers WHERE id = ?').run('fake');
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM provider_read_backoff').get()).toEqual({
      count: 0,
    });
  });

  it('allows one newly authorized login-phase probe without resetting failed verification history', () => {
    const { backoff } = setup();
    backoff.failed('fake', 'auth_verify', 'auth_required');
    const deadline = backoff.retryAtMs('fake', 'auth_verify');
    backoff.authorizeAuthenticationProbe('fake', 'auth_verify');
    backoff.assertAllowed('fake', 'auth_verify');
    expect(backoff.retryAtMs('fake', 'auth_verify')).toBe(deadline);
    expect(() => backoff.assertAllowed('fake', 'auth_verify')).toThrow(ProviderReadDeferredError);
    backoff.authorizeAuthenticationProbe('fake', 'auth_check');
    backoff.failed('fake', 'auth_check', 'auth_required');
    backoff.revokeAuthenticationProbes('fake');
    expect(() => backoff.assertAllowed('fake', 'auth_check')).toThrow(ProviderReadDeferredError);
    expect(() => backoff.authorizeAuthenticationProbe('unknown', 'auth_verify')).toThrow();
    expect(() =>
      backoff.authorizeAuthenticationProbe('fake', 'reconcile' as 'auth_verify'),
    ).toThrow();
  });

  it('does not use an old in-flight read to verify changed credentials', async () => {
    const { backoff, fake } = setup();
    const coordinator = new ProviderInspectionCoordinator({ backoff });
    let authenticated = false;
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter: ProviderAdapter = {
      id: 'fake',
      capabilities: () => fake.capabilities(),
      health: (ctx) => fake.health(ctx),
      inspect: async (ctx) => {
        reads++;
        const observation = await fake.inspect(ctx);
        const health = authenticated ? 'UP' : 'AUTH_REQUIRED';
        if (reads === 1) await barrier;
        return { ...observation, health };
      },
    };
    const old = coordinator.inspect(adapter);
    for (let n = 0; n < 5; n++) await Promise.resolve();
    const queued = coordinator.inspectFresh(adapter, {}, 'confirmation');
    authenticated = true;
    coordinator.markAuthenticationVerification('fake');
    backoff.authorizeAuthenticationProbe('fake', 'auth_verify');
    const verified = coordinator.inspectFresh(adapter, {}, 'auth_verify');
    release();
    expect((await old).health).toBe('AUTH_REQUIRED');
    expect((await verified).health).toBe('UP');
    await queued;
    expect(reads).toBe(2);
    expect(backoff.retryAtMs('fake', 'confirmation')).toBe(0);
    await coordinator.close();
  });

  it.each(['stale', 'future', 'wrong-provider'])(
    'does not reset protection on a %s observation',
    async (variant) => {
      const { clock, backoff, fake } = setup();
      const coordinator = new ProviderInspectionCoordinator({ backoff });
      const adapter: ProviderAdapter = {
        id: 'fake',
        capabilities: () => fake.capabilities(),
        health: (ctx) => fake.health(ctx),
        inspect: async (ctx) => {
          const observation = await fake.inspect(ctx);
          return {
            ...observation,
            providerId: variant === 'wrong-provider' ? 'unexpected' : 'fake',
            observedAt: new Date(
              clock.now().getTime() +
                (variant === 'stale'
                  ? -(observation.staleAfterSeconds * 1000 + 1)
                  : variant === 'future'
                    ? 1000
                    : 0),
            ).toISOString(),
          };
        },
      };
      await expect(coordinator.inspect(adapter)).rejects.toThrow('invalid provider observation');
      expect(coordinator.isDeferred('fake')).toBe(true);
      await expect(coordinator.inspect(adapter)).rejects.toBeInstanceOf(ProviderReadDeferredError);
      await coordinator.close();
    },
  );
});
