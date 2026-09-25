import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { seedBootstrapProviderDefaults } from '../../src/bootstrap/provider-defaults.js';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-provider-bootstrap-'));
  const db = openDatabase(path.join(dir, 'awm.db'));
  const repositories = createRepositories(db);
  resources.push({ db, dir, repositories });
  return { db, dir, repositories };
}

function seed(
  repositories: StorageRepositories,
  triggerEnabled: boolean,
  providerId = 'antigravity',
  kind = 'antigravity',
): void {
  seedBootstrapProviderDefaults({
    repositories,
    provider: {
      id: providerId,
      kind,
      config: kind === 'antigravity' ? { home: '/agy-state' } : { codexHome: '/codex-state' },
    },
    nowMs: 1_000,
    pollIntervalSeconds: 30,
    timezone: 'America/Sao_Paulo',
    triggerEnabled,
  });
}

function reopen(fixture: ReturnType<typeof openFixture>): StorageRepositories {
  fixture.db.close();
  const db = openDatabase(path.join(fixture.dir, 'awm.db'));
  const repositories = createRepositories(db);
  resources[0]!.db = db;
  resources[0]!.repositories = repositories;
  return repositories;
}

describe('bootstrap provider defaults', () => {
  it.each([
    { providerId: 'codex', kind: 'codex' },
    { providerId: 'antigravity', kind: 'antigravity' },
  ])(
    'defaults $providerId to automation when its trigger gate is enabled',
    ({ providerId, kind }) => {
      const { repositories } = openFixture();

      seed(repositories, true, providerId, kind);

      expect(repositories.providers.get(providerId)?.mode).toBe('automation');
      const policies = repositories.schedulePolicies.list(providerId);
      expect(policies).toMatchObject(
        providerId === 'antigravity'
          ? [
              {
                id: 'activation-antigravity-claude-gpt',
                scope: 'claude_gpt',
                kind: 'auto',
                enabled: true,
                config: {},
              },
              {
                id: 'activation-antigravity-gemini',
                scope: 'gemini',
                kind: 'auto',
                enabled: true,
                config: {},
              },
            ]
          : [{ id: `activation-${providerId}`, scope: 'default', kind: 'auto', enabled: true }],
      );
    },
  );

  it('defaults to monitor-only and manual when the provider trigger gate is disabled', () => {
    const { repositories } = openFixture();

    seed(repositories, false);

    expect(repositories.providers.get('antigravity')?.mode).toBe('monitor_only');
    expect(repositories.schedulePolicies.list('antigravity')).toMatchObject([
      {
        id: 'activation-antigravity-claude-gpt',
        scope: 'claude_gpt',
        kind: 'manual',
        kindExplicit: false,
        enabled: true,
        config: {},
      },
      {
        id: 'activation-antigravity-gemini',
        scope: 'gemini',
        kind: 'manual',
        kindExplicit: false,
        enabled: true,
        config: {},
      },
    ]);
  });

  it('upgrades untouched legacy defaults to automation when the trigger gate is enabled', () => {
    const { repositories } = openFixture();
    seed(repositories, false);

    seed(repositories, true);

    expect(repositories.providers.get('antigravity')).toMatchObject({
      mode: 'automation',
      modeExplicit: false,
    });
    expect(repositories.schedulePolicies.get('activation-antigravity-gemini')).toMatchObject({
      scope: 'gemini',
      kind: 'auto',
      kindExplicit: false,
    });
    expect(repositories.schedulePolicies.get('activation-antigravity-claude-gpt')).toMatchObject({
      scope: 'claude_gpt',
      kind: 'auto',
      kindExplicit: false,
    });
  });

  it('keeps explicit provider and schedule opt-outs after bootstrap', () => {
    const { repositories } = openFixture();
    seed(repositories, true);
    const provider = repositories.providers.get('antigravity');
    const policy = repositories.schedulePolicies.get('activation-antigravity-gemini');
    if (!provider || !policy) throw new Error('bootstrap defaults were not created');
    repositories.providers.upsert({
      ...provider,
      mode: 'monitor_only',
      modeExplicit: true,
      updatedAtMs: 2_000,
    });
    repositories.schedulePolicies.upsert({
      ...policy,
      kind: 'manual',
      kindExplicit: true,
      updatedAtMs: 2_000,
    });

    seed(repositories, true);

    expect(repositories.providers.get('antigravity')).toMatchObject({
      mode: 'monitor_only',
      modeExplicit: true,
    });
    expect(repositories.schedulePolicies.get('activation-antigravity-gemini')).toMatchObject({
      kind: 'manual',
      kindExplicit: true,
    });
    expect(repositories.schedulePolicies.get('activation-antigravity-claude-gpt')).toMatchObject({
      kind: 'auto',
      kindExplicit: false,
    });
  });

  it('does not reset a saved automation preference when the gate is temporarily disabled', () => {
    const fixture = openFixture();
    seed(fixture.repositories, true);
    const repositories = reopen(fixture);

    seed(repositories, false);

    expect(repositories.providers.get('antigravity')?.mode).toBe('automation');
    expect(repositories.schedulePolicies.list('antigravity')).toMatchObject([
      { id: 'activation-antigravity-claude-gpt', kind: 'auto' },
      { id: 'activation-antigravity-gemini', kind: 'auto' },
    ]);
  });

  it('preserves an explicit monitor-only choice and manual policy after restart', () => {
    const fixture = openFixture();
    seed(fixture.repositories, true);
    const provider = fixture.repositories.providers.get('antigravity');
    const policy = fixture.repositories.schedulePolicies.get('activation-antigravity-gemini');
    if (!provider || !policy) throw new Error('bootstrap defaults were not created');
    fixture.repositories.providers.upsert({
      ...provider,
      mode: 'monitor_only',
      modeExplicit: true,
      updatedAtMs: 2_000,
    });
    fixture.repositories.schedulePolicies.upsert({
      ...policy,
      kind: 'manual',
      kindExplicit: true,
      updatedAtMs: 2_000,
    });
    const repositories = reopen(fixture);

    seed(repositories, true);

    expect(repositories.providers.get('antigravity')?.mode).toBe('monitor_only');
    expect(repositories.schedulePolicies.list('antigravity')).toMatchObject([
      { id: 'activation-antigravity-claude-gpt', kind: 'auto' },
      { id: 'activation-antigravity-gemini', kind: 'manual' },
    ]);
  });
});
