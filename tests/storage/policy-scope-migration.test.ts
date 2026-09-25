import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { createRepositories } from '../../src/storage/repositories.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createVersionFiveDatabase(windowKind: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-policy-scope-migration-'));
  directories.push(directory);
  const migrationDirectory = path.join(directory, 'previous-migrations');
  fs.mkdirSync(migrationDirectory);
  for (let version = 1; version <= 5; version += 1) {
    const name = fs
      .readdirSync(path.resolve('migrations'))
      .find((candidate) => candidate.startsWith(`${String(version).padStart(3, '0')}_`));
    if (!name) throw new Error(`missing migration ${version}`);
    fs.copyFileSync(path.resolve('migrations', name), path.join(migrationDirectory, name));
  }

  const file = path.join(directory, 'awm.db');
  const db = openDatabase(file, { migrationsDir: migrationDirectory });
  db.exec(`
    INSERT INTO providers (id, kind, mode, created_at_ms, updated_at_ms)
    VALUES ('antigravity', 'antigravity', 'automation', 1000, 2000);
    INSERT INTO schedule_policies (
      id, provider_id, kind, kind_explicit, enabled, timezone, config_json,
      created_at_ms, updated_at_ms
    ) VALUES (
      'activation-antigravity', 'antigravity', 'auto', 1, 1, 'America/Sao_Paulo',
      '{"windowKind":"${windowKind}"}', 1000, 2000
    );
    INSERT INTO action_intents (
      id, provider_id, policy_id, action_type, dedupe_key, state,
      scheduled_for_ms, reason_code, created_at_ms, updated_at_ms
    ) VALUES (
      'intent-legacy-antigravity', 'antigravity', 'activation-antigravity',
      'trigger_window', 'legacy-intent-key', 'planned', 2000,
      'TARGET_RESET_WINDOW_MATCH', 1000, 2000
    );
    INSERT INTO action_intents (
      id, provider_id, policy_id, action_type, dedupe_key, state,
      scheduled_for_ms, reason_code, created_at_ms, updated_at_ms
    ) VALUES (
      'intent-uncertain-antigravity', 'antigravity', 'activation-antigravity',
      'trigger_window', 'legacy-uncertain-intent-key', 'uncertain', 2000,
      'ACTION_DISPATCH_UNCERTAIN', 1000, 2000
    );
  `);
  db.close();
  return { file };
}

describe('Antigravity policy scope migration', () => {
  it('copies an exact family target into its own review-gated policy and preserves old intent references', () => {
    const { file } = createVersionFiveDatabase('antigravity_gemini_five_hour');

    const db = openDatabase(file);
    const repositories = createRepositories(db);
    expect(repositories.schedulePolicies.get('activation-antigravity-gemini')).toMatchObject({
      scope: 'gemini',
      kind: 'auto',
      enabled: false,
      requiresReview: true,
      config: { windowKind: 'antigravity_gemini_five_hour' },
    });
    expect(repositories.schedulePolicies.get('activation-antigravity-claude-gpt')).toMatchObject({
      scope: 'claude_gpt',
      kind: 'manual',
      enabled: false,
      requiresReview: true,
      config: {},
    });
    expect(repositories.schedulePolicies.get('activation-antigravity')).toMatchObject({
      scope: 'legacy',
      enabled: false,
    });
    expect(repositories.actionIntents.get('intent-legacy-antigravity')?.policyId).toBe(
      'activation-antigravity',
    );
    expect(repositories.actionIntents.get('intent-uncertain-antigravity')).toMatchObject({
      policyId: 'activation-antigravity',
      state: 'uncertain',
      dedupeKey: 'legacy-uncertain-intent-key',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_intents').get()).toEqual({ count: 2 });
    db.close();

    const reopened = openDatabase(file);
    expect(
      reopened
        .prepare(
          "SELECT id FROM schedule_policies WHERE scope IN ('gemini', 'claude_gpt') ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: 'activation-antigravity-claude-gpt' },
      { id: 'activation-antigravity-gemini' },
    ]);
    reopened.close();
  });

  it('does not guess a family from a generic five-hour target', () => {
    const { file } = createVersionFiveDatabase('five_hour');

    const db = openDatabase(file);
    const repositories = createRepositories(db);
    for (const id of ['activation-antigravity-gemini', 'activation-antigravity-claude-gpt']) {
      expect(repositories.schedulePolicies.get(id)).toMatchObject({
        kind: 'manual',
        enabled: false,
        requiresReview: true,
        config: {},
      });
    }
    expect(repositories.schedulePolicies.get('activation-antigravity')?.config).toEqual({
      windowKind: 'five_hour',
    });
    db.close();
  });
});
