import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import type { ProviderAdapter } from '../../src/providers/provider.js';
import { ProviderCleanupWorker } from '../../src/scheduler/provider-cleanup.js';
import { FakeClock } from '../../src/scheduler/clock.js';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories } from '../../src/storage/repositories.js';

const resources: Array<{ db: ReturnType<typeof openDatabase>; dir: string }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (resource.db.open) resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

function setup(adapterOverrides: Partial<ProviderAdapter> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-cleanup-worker-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  const clock = new FakeClock('2026-09-20T08:00:00.000Z');
  const fake = new FakeProvider(clock);
  const adapter: ProviderAdapter = {
    id: fake.id,
    capabilities: () => fake.capabilities(),
    health: (ctx) => fake.health(ctx),
    inspect: (ctx) => fake.inspect(ctx),
    ...adapterOverrides,
  };
  repositories.providers.upsert({
    id: 'codex',
    kind: 'codex',
    enabled: true,
    mode: 'automation',
    pollIntervalSeconds: 30,
    config: {},
    configVersion: 1,
    createdAtMs: clock.now().getTime(),
    updatedAtMs: clock.now().getTime(),
  });
  repositories.providerCleanupJobs.createIfAbsent({
    id: 'cleanup-1',
    providerId: 'codex',
    artifactKind: 'codex_thread',
    externalId: 'synthetic-thread-id',
    state: 'pending',
    attemptCount: 0,
    notBeforeMs: clock.now().getTime(),
    lastErrorCode: null,
    createdAtMs: clock.now().getTime(),
    updatedAtMs: clock.now().getTime(),
  });
  resources.push({ db, dir });
  return {
    db,
    repositories,
    clock,
    adapter,
    worker: (overrides: Partial<ConstructorParameters<typeof ProviderCleanupWorker>[0]> = {}) =>
      new ProviderCleanupWorker({
        clock,
        repositories,
        adapters: new Map([['codex', adapter]]),
        retryBaseMs: 1_000,
        retryMaxMs: 4_000,
        ...overrides,
      }),
  };
}

describe('ProviderCleanupWorker', () => {
  it('deletes a completed cleanup obligation without returning or logging identifiers', async () => {
    let deleted: string | undefined;
    const context = setup({
      cleanupArtifact: (_ctx, artifact) => {
        deleted = artifact.externalId;
        return Promise.resolve();
      },
    });

    const worker = context.worker();
    const report = await worker.runDue();

    expect(deleted).toBe('synthetic-thread-id');
    expect(report).toEqual({
      skipped: false,
      recovered: 0,
      attempted: 1,
      deleted: 1,
      retryable: 0,
    });
    expect(JSON.stringify(report)).not.toContain('synthetic-thread-id');
    expect(context.repositories.providerCleanupJobs.get('cleanup-1')).toBeUndefined();
    await expect(worker.runDue()).resolves.toMatchObject({ skipped: false, recovered: 0 });
  });

  it('retries idempotent cleanup with bounded backoff and never dispatches an action', async () => {
    let cleanupAttempts = 0;
    let triggerAttempts = 0;
    const context = setup({
      cleanupArtifact: () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1)
          return Promise.reject(Object.assign(new Error('private detail'), { code: 'TIMEOUT' }));
        return Promise.resolve();
      },
      triggerWindow: () => {
        triggerAttempts += 1;
        return Promise.reject(new Error('cleanup must not dispatch a trigger'));
      },
    });

    const first = await context.worker().runDue();
    expect(first).toMatchObject({ attempted: 1, deleted: 0, retryable: 1 });
    expect(context.repositories.providerCleanupJobs.get('cleanup-1')).toMatchObject({
      state: 'retryable',
      attemptCount: 1,
      notBeforeMs: context.clock.now().getTime() + 1_000,
      lastErrorCode: 'CLEANUP_TIMEOUT',
    });

    context.clock.advanceMs(999);
    expect(await context.worker().runDue()).toMatchObject({ attempted: 0 });
    context.clock.advanceMs(1);
    expect(await context.worker().runDue()).toMatchObject({ attempted: 1, deleted: 1 });
    expect(cleanupAttempts).toBe(2);
    expect(triggerAttempts).toBe(0);
  });

  it('treats unavailable cleanup support as retryable rather than dropping the obligation', async () => {
    const context = setup();

    const report = await context.worker().runDue();

    expect(report).toMatchObject({ attempted: 1, retryable: 1 });
    expect(context.repositories.providerCleanupJobs.get('cleanup-1')).toMatchObject({
      state: 'retryable',
      lastErrorCode: 'CLEANUP_UNAVAILABLE',
    });
  });

  it('recovers interrupted cleanup after restart and treats provider not-found as success', async () => {
    const context = setup({ cleanupArtifact: () => Promise.resolve() });
    context.repositories.providerCleanupJobs.claim('cleanup-1', context.clock.now().getTime());

    const report = await context.worker().runDue();

    expect(report).toMatchObject({ recovered: 1, attempted: 1, deleted: 1 });
    expect(context.repositories.providerCleanupJobs.get('cleanup-1')).toBeUndefined();
  });

  it('coalesces overlapping runs while a deletion is in progress', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = setup({ cleanupArtifact: () => gate });
    const worker = context.worker();
    const firstRun = worker.runDue();
    expect(await worker.runDue()).toMatchObject({ skipped: true });

    release();
    await firstRun;
    expect(context.repositories.providerCleanupJobs.get('cleanup-1')).toBeUndefined();
  });

  it('validates configured batch and retry bounds', () => {
    const context = setup();

    for (const options of [
      { batchSize: 1.5 },
      { batchSize: 0 },
      { batchSize: 101 },
      { retryBaseMs: 86_400_001 },
      { retryMaxMs: 999 },
    ]) {
      expect(() => context.worker(options)).toThrow(RangeError);
    }
  });

  it('uses bounded defaults when no retry limits are configured', async () => {
    const context = setup({ cleanupArtifact: () => Promise.resolve() });
    const worker = new ProviderCleanupWorker({
      clock: context.clock,
      repositories: context.repositories,
      adapters: new Map([['codex', context.adapter]]),
    });

    await expect(worker.runDue()).resolves.toMatchObject({ attempted: 1, deleted: 1 });
  });

  it('rejects an invalid injected clock before querying due jobs', async () => {
    const context = setup();
    const worker = context.worker({ clock: { now: () => new Date(Number.NaN) } });

    await expect(worker.runDue()).rejects.toThrow('cleanup clock must return a valid instant');
  });

  it.each([
    ['an unstructured error', new Error('private detail')],
    ['a non-string code', Object.assign(new Error('private detail'), { code: 42 })],
    ['an invalid code', Object.assign(new Error('private detail'), { code: 'lower-case' })],
  ])('stores a bounded fallback code for %s', async (_label, error) => {
    const failedCleanup = new Promise<void>((_resolve, reject) => reject(error));
    const context = setup({ cleanupArtifact: () => failedCleanup });

    await context.worker().runDue();

    expect(context.repositories.providerCleanupJobs.get('cleanup-1')).toMatchObject({
      state: 'retryable',
      lastErrorCode: 'CLEANUP_FAILED',
    });
  });

  it('does not count an obligation deleted concurrently as worker deletion success', async () => {
    const context = setup({
      cleanupArtifact: () => {
        context.repositories.providerCleanupJobs.delete('cleanup-1');
        return Promise.resolve();
      },
    });

    await expect(context.worker().runDue()).resolves.toMatchObject({
      attempted: 1,
      deleted: 0,
      retryable: 0,
    });
  });

  it('skips a due item that another worker has already claimed', async () => {
    const context = setup();
    vi.spyOn(context.repositories.providerCleanupJobs, 'claim').mockReturnValue(undefined);

    await expect(context.worker().runDue()).resolves.toMatchObject({
      attempted: 0,
      deleted: 0,
      retryable: 0,
    });
  });
});
