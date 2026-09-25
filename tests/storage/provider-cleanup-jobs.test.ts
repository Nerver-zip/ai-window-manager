import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories, type StorageRepositories } from '../../src/storage/repositories.js';

const resources: Array<{
  db: ReturnType<typeof openDatabase>;
  dir: string;
  repositories: StorageRepositories;
}> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    if (resource.db.open) resource.db.close();
    fs.rmSync(resource.dir, { recursive: true, force: true });
  }
});

function openFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-cleanup-jobs-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  repositories.providers.upsert({
    id: 'codex',
    kind: 'codex',
    enabled: true,
    mode: 'automation',
    pollIntervalSeconds: 30,
    config: {},
    configVersion: 1,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  });
  const fixture = { db, dir, repositories };
  resources.push(fixture);
  return fixture;
}

function reopen(fixture: ReturnType<typeof openFixture>) {
  fixture.db.close();
  fixture.db = openDatabase(path.join(fixture.dir, 'awm.db'));
  fixture.repositories = createRepositories(fixture.db);
  return fixture.repositories;
}

function job(
  overrides: Partial<
    Parameters<StorageRepositories['providerCleanupJobs']['createIfAbsent']>[0]
  > = {},
) {
  return {
    id: 'cleanup-1',
    providerId: 'codex',
    artifactKind: 'codex_thread' as const,
    externalId: 'synthetic-thread-id',
    state: 'pending' as const,
    attemptCount: 0,
    notBeforeMs: 1_000,
    lastErrorCode: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    ...overrides,
  };
}

describe('provider cleanup job repository', () => {
  it('persists a bounded provider artifact obligation and deduplicates its identifier', () => {
    const { repositories } = openFixture();
    const first = repositories.providerCleanupJobs.createIfAbsent(job());
    expect(repositories.providerCleanupJobs.hasOpenForProvider('codex')).toBe(true);
    expect(repositories.providerCleanupJobs.hasOpenForProvider('antigravity')).toBe(false);
    const duplicate = repositories.providerCleanupJobs.createIfAbsent(
      job({ id: 'cleanup-duplicate', createdAtMs: 2_000, updatedAtMs: 2_000 }),
    );

    expect(first).toMatchObject({
      created: true,
      job: { id: 'cleanup-1', externalId: 'synthetic-thread-id' },
    });
    expect(duplicate).toMatchObject({ created: false, job: { id: 'cleanup-1', attemptCount: 0 } });
    expect(repositories.providerCleanupJobs.get('missing')).toBeUndefined();
  });

  it('claims due jobs once, retries with a bounded code, and recovers executing jobs after restart', () => {
    const fixture = openFixture();
    let repositories = fixture.repositories;
    repositories.providerCleanupJobs.createIfAbsent(job());
    repositories.providerCleanupJobs.createIfAbsent(
      job({ id: 'cleanup-future', externalId: 'future-thread-id', notBeforeMs: 2_000 }),
    );

    expect(repositories.providerCleanupJobs.listDue(999)).toEqual([]);
    expect(repositories.providerCleanupJobs.listDue(1_000)).toHaveLength(1);
    expect(repositories.providerCleanupJobs.claim('cleanup-1', 1_000)).toMatchObject({
      state: 'executing',
      attemptCount: 1,
    });
    expect(repositories.providerCleanupJobs.claim('cleanup-1', 1_000)).toBeUndefined();
    expect(
      repositories.providerCleanupJobs.markRetryable('cleanup-1', 1_100, 2_000, 'CLEANUP_TIMEOUT'),
    ).toBe(true);
    expect(repositories.providerCleanupJobs.listDue(1_999)).toHaveLength(0);
    expect(repositories.providerCleanupJobs.listDue(2_000)).toHaveLength(2);
    expect(() =>
      repositories.providerCleanupJobs.markRetryable(
        'cleanup-1',
        2_000,
        3_000,
        'raw provider error',
      ),
    ).toThrow('provider cleanup error code is invalid');

    expect(repositories.providerCleanupJobs.claim('cleanup-1', 2_000)).toMatchObject({
      state: 'executing',
      attemptCount: 2,
    });
    repositories = reopen(fixture);
    expect(repositories.providerCleanupJobs.recoverExecuting(2_100)).toBe(1);
    expect(repositories.providerCleanupJobs.get('cleanup-1')).toMatchObject({
      state: 'retryable',
      notBeforeMs: 2_100,
      lastErrorCode: 'CLEANUP_INTERRUPTED',
    });
  });

  it('deletes a completed job and prevents provider deletion while a cleanup obligation remains', () => {
    const { repositories } = openFixture();
    repositories.providerCleanupJobs.createIfAbsent(job());

    expect(() => repositories.providers.delete('codex')).toThrow();
    expect(repositories.providerCleanupJobs.delete('cleanup-1')).toBe(true);
    expect(repositories.providerCleanupJobs.hasOpenForProvider('codex')).toBe(false);
    expect(repositories.providerCleanupJobs.delete('cleanup-1')).toBe(false);
    expect(repositories.providers.delete('codex')).toBe(true);
  });

  it.each([
    ['cross-provider Codex ID', { providerId: 'antigravity' }],
    ['empty external ID', { externalId: '' }],
    ['overlong external ID', { externalId: 'x'.repeat(257) }],
    ['control character', { externalId: 'thread\nforged' }],
    ['delete control character', { externalId: 'thread\u007fforged' }],
    ['unknown artifact kind', { artifactKind: 'provider_database_row' as never }],
  ])('rejects %s before persistence', (_label, override) => {
    const { repositories } = openFixture();

    expect(() => repositories.providerCleanupJobs.createIfAbsent(job(override))).toThrow(
      'provider cleanup artifact is invalid',
    );
    expect(repositories.providerCleanupJobs.listDue(10_000)).toEqual([]);
  });
});
