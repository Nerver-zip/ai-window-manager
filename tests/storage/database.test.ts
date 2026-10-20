import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../../src/storage/database.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('upgrades schema 11 with open legacy intents and cleanup without fabricating read history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-read-backoff-migration-'));
    dirs.push(dir);
    const migrationsDir = path.join(dir, 'v11');
    fs.mkdirSync(migrationsDir);
    for (const name of fs
      .readdirSync('migrations')
      .filter((name) => Number(name.split('_')[0]) <= 11))
      fs.copyFileSync(path.join('migrations', name), path.join(migrationsDir, name));
    const file = path.join(dir, 'awm.db');
    const old = openDatabase(file, { migrationsDir });
    old.exec(`INSERT INTO providers (id, kind, enabled, mode, poll_interval_seconds, config_json, config_version, created_at_ms, updated_at_ms)
      VALUES ('codex', 'codex', 1, 'automation', 30, '{}', 1, 1, 1);
      INSERT INTO action_intents (id, provider_id, action_type, dedupe_key, state, scheduled_for_ms, attempt_count, reason_code, explanation_json, created_at_ms, updated_at_ms)
      VALUES ('legacy', 'codex', 'trigger_window', 'synthetic-legacy-dedupe', 'uncertain', 1, 1, 'ACTION_DISPATCH_UNCERTAIN', '{}', 1, 1);
      INSERT INTO provider_cleanup_jobs (id, provider_id, artifact_kind, external_id, state, not_before_ms, created_at_ms, updated_at_ms)
      VALUES ('cleanup', 'codex', 'codex_thread', 'synthetic-thread', 'pending', 1, 1, 1);
      INSERT INTO settings (key, value_json, updated_at_ms) VALUES ('operator-preference', 'false', 1);`);
    const intent = old.prepare('SELECT * FROM action_intents').get();
    const cleanup = old.prepare('SELECT * FROM provider_cleanup_jobs').get();
    const preference = old.prepare('SELECT * FROM settings').get();
    old.close();
    const upgraded = openDatabase(file);
    expect(upgraded.prepare('SELECT * FROM action_intents').get()).toEqual(intent);
    expect(upgraded.prepare('SELECT * FROM provider_cleanup_jobs').get()).toEqual(cleanup);
    expect(upgraded.prepare('SELECT * FROM settings').get()).toEqual(preference);
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM provider_read_backoff').get()).toEqual({
      count: 0,
    });
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    upgraded.close();
  });

  it('upgrades schema 9 retention indexes without changing intents, cleanup, preferences or event data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-retention-migration-'));
    dirs.push(dir);
    const migrationsDir = path.join(dir, 'v9');
    fs.mkdirSync(migrationsDir);
    for (const name of fs.readdirSync('migrations').filter((name) => /^00[1-9]_/.test(name))) {
      fs.copyFileSync(path.join('migrations', name), path.join(migrationsDir, name));
    }
    const file = path.join(dir, 'awm.db');
    const old = openDatabase(file, { migrationsDir });
    old.exec(`
      INSERT INTO providers (id, kind, enabled, mode, poll_interval_seconds, config_json, config_version, created_at_ms, updated_at_ms)
      VALUES ('codex', 'codex', 1, 'automation', 30, '{}', 1, 1, 1);
      INSERT INTO action_intents (id, provider_id, action_type, dedupe_key, state, scheduled_for_ms, attempt_count, reason_code, explanation_json, created_at_ms, updated_at_ms)
      VALUES ('pending', 'codex', 'trigger_window', 'original-dedupe', 'uncertain', 1, 1, 'ACTION_DISPATCH_UNCERTAIN', '{}', 1, 1);
      INSERT INTO events (provider_id, type, occurred_at_ms, data_json)
      VALUES ('codex', 'provider_inspected', 1, '{"synthetic":true}');
      INSERT INTO settings (key, value_json, updated_at_ms)
      VALUES ('operator-preference', '{"enabled":false}', 1);
      INSERT INTO provider_cleanup_jobs (id, provider_id, artifact_kind, external_id, state, not_before_ms, created_at_ms, updated_at_ms)
      VALUES ('pending-cleanup', 'codex', 'codex_thread', 'synthetic-artifact', 'pending', 1, 1, 1);
    `);
    const intent = old.prepare('SELECT * FROM action_intents').get();
    const cleanup = old.prepare('SELECT * FROM provider_cleanup_jobs').get();
    const preference = old.prepare('SELECT * FROM settings').get();
    const event = old
      .prepare('SELECT id, provider_id, type, occurred_at_ms, data_json FROM events')
      .get();
    old.close();
    const upgraded = openDatabase(file);
    expect(upgraded.prepare('SELECT * FROM action_intents').get()).toEqual(intent);
    expect(upgraded.prepare('SELECT * FROM provider_cleanup_jobs').get()).toEqual(cleanup);
    expect(upgraded.prepare('SELECT * FROM settings').get()).toEqual(preference);
    expect(
      upgraded.prepare('SELECT id, provider_id, type, occurred_at_ms, data_json FROM events').get(),
    ).toEqual(event);
    expect(upgraded.prepare('SELECT retention_class FROM events').get()).toEqual({
      retention_class: 'lifecycle',
    });
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    upgraded.close();
    const reopened = openDatabase(file);
    expect(
      reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 10').get(),
    ).toEqual({ count: 1 });
    expect(reopened.prepare('SELECT * FROM action_intents').get()).toEqual(intent);
    reopened.close();
  });

  it('adds durable confirmation backoff to a v8 database without changing unresolved intents', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-confirmation-migration-'));
    dirs.push(dir);
    const migrationsDir = path.join(dir, 'v8');
    fs.mkdirSync(migrationsDir);
    for (const name of fs.readdirSync('migrations').filter((name) => /^00[1-8]_/.test(name))) {
      fs.copyFileSync(path.join('migrations', name), path.join(migrationsDir, name));
    }
    const file = path.join(dir, 'awm.db');
    const old = openDatabase(file, { migrationsDir });
    old
      .prepare(
        `INSERT INTO providers (id, kind, enabled, mode, poll_interval_seconds, config_json, config_version, created_at_ms, updated_at_ms)
         VALUES ('codex', 'codex', 1, 'automation', 30, '{}', 1, 1, 1)`,
      )
      .run();
    old
      .prepare(
        `INSERT INTO action_intents (id, provider_id, action_type, dedupe_key, state, scheduled_for_ms, attempt_count, reason_code, explanation_json, created_at_ms, updated_at_ms)
         VALUES ('old-intent', 'codex', 'trigger_window', 'uncertain-cycle-key', 'uncertain', 1, 1, 'ACTION_DISPATCH_UNCERTAIN', '{}', 1, 1)`,
      )
      .run();
    old.close();

    const upgraded = openDatabase(file);
    expect(
      upgraded
        .prepare(
          `SELECT state, dedupe_key, confirmation_attempt_count, confirmation_not_before_ms
           FROM action_intents WHERE id = 'old-intent'`,
        )
        .get(),
    ).toEqual({
      state: 'uncertain',
      dedupe_key: 'uncertain-cycle-key',
      confirmation_attempt_count: 0,
      confirmation_not_before_ms: null,
    });
    expect(upgraded.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual(
      {
        version: 14,
      },
    );
    upgraded.close();
  });

  it('adds durable cycles to schema v7 without rewriting existing intent dedupe/history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-cycle-migration-'));
    dirs.push(dir);
    const migrationsDir = path.join(dir, 'v7');
    fs.mkdirSync(migrationsDir);
    for (const name of fs.readdirSync('migrations').filter((name) => /^00[1-7]_/.test(name))) {
      fs.copyFileSync(path.join('migrations', name), path.join(migrationsDir, name));
    }
    const file = path.join(dir, 'awm.db');
    const old = openDatabase(file, { migrationsDir });
    old
      .prepare(
        `INSERT INTO providers (id, kind, enabled, mode, poll_interval_seconds, config_json, config_version, created_at_ms, updated_at_ms)
      VALUES ('codex', 'codex', 1, 'automation', 30, '{}', 1, 1, 1)`,
      )
      .run();
    old
      .prepare(
        `INSERT INTO action_intents (id, provider_id, action_type, dedupe_key, state, scheduled_for_ms, attempt_count, reason_code, explanation_json, created_at_ms, updated_at_ms)
      VALUES ('old-intent', 'codex', 'trigger_window', 'legacy-cycle-key', 'uncertain', 1, 1, 'ACTION_DISPATCH_UNCERTAIN', '{}', 1, 1)`,
      )
      .run();
    old.close();
    const upgraded = openDatabase(file);
    expect(upgraded.prepare('SELECT state, dedupe_key FROM action_intents').get()).toEqual({
      state: 'uncertain',
      dedupe_key: 'legacy-cycle-key',
    });
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM observed_window_cycles').get()).toEqual({
      count: 0,
    });
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    upgraded.close();
    const reopened = openDatabase(file);
    expect(
      reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9').get(),
    ).toEqual({ count: 1 });
    reopened.close();
  });
  it('opens an in-memory database without creating a filesystem directory', () => {
    const db = openDatabase(':memory:');
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
      version: 14,
    });
    db.close();
  });

  it('adds rolling resolution evidence to a version-12 database on reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-rolling-migration-'));
    dirs.push(dir);
    const migrationsDir = path.join(dir, 'v12');
    fs.mkdirSync(migrationsDir);
    for (const name of fs
      .readdirSync('migrations')
      .filter((name) => /^0(0[1-9]|1[0-2])_/.test(name))) {
      fs.copyFileSync(path.join('migrations', name), path.join(migrationsDir, name));
    }
    const file = path.join(dir, 'awm.db');
    openDatabase(file, { migrationsDir }).close();
    const upgraded = openDatabase(file);
    expect(upgraded.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual(
      { version: 14 },
    );
    expect(
      upgraded
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rolling_inactive_resolution_evidence'",
        )
        .get(),
    ).toEqual({ name: 'rolling_inactive_resolution_evidence' });
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    upgraded.close();
  });

  it('widens policy scopes from schema 13 without changing policies, intents, history, cleanup or foreign keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-argon-policy-scope-migration-'));
    dirs.push(dir);
    const migrationsDir = path.join(dir, 'v13');
    fs.mkdirSync(migrationsDir);
    for (let version = 1; version <= 13; version += 1) {
      const name = fs
        .readdirSync('migrations')
        .find((candidate) => candidate.startsWith(`${String(version).padStart(3, '0')}_`));
      if (!name) throw new Error(`missing migration ${version}`);
      fs.copyFileSync(path.join('migrations', name), path.join(migrationsDir, name));
    }

    const file = path.join(dir, 'awm.db');
    const previous = openDatabase(file, { migrationsDir });
    previous.exec(`
      INSERT INTO providers (id, kind, mode, created_at_ms, updated_at_ms)
      VALUES ('antigravity', 'antigravity', 'automation', 1, 1),
             ('codex', 'codex', 'monitor_only', 1, 1);
      INSERT INTO schedule_policies (
        id, provider_id, scope, requires_review, kind, kind_explicit, enabled,
        timezone, config_json, created_at_ms, updated_at_ms
      ) VALUES
        ('activation-antigravity', 'antigravity', 'legacy', 0, 'manual', 0, 0, 'UTC', '{}', 1, 1),
        ('activation-antigravity-gemini', 'antigravity', 'gemini', 1, 'auto', 1, 0, 'UTC', '{"windowKind":"antigravity_gemini_weekly"}', 2, 2),
        ('activation-antigravity-claude-gpt', 'antigravity', 'claude_gpt', 1, 'manual', 0, 0, 'UTC', '{}', 3, 3),
        ('activation-codex', 'codex', 'default', 0, 'auto', 1, 1, 'UTC', '{}', 4, 4);
      INSERT INTO action_intents (
        id, provider_id, policy_id, action_type, dedupe_key, state,
        scheduled_for_ms, attempt_count, reason_code, explanation_json, created_at_ms, updated_at_ms
      ) VALUES
        ('legacy-intent', 'antigravity', 'activation-antigravity', 'trigger_window', 'legacy-dedupe', 'uncertain', 10, 1, 'ACTION_DISPATCH_UNCERTAIN', '{"legacy":true}', 5, 6),
        ('family-intent', 'antigravity', 'activation-antigravity-gemini', 'trigger_window', 'family-dedupe', 'uncertain', 11, 2, 'ACTION_DISPATCH_UNCERTAIN', '{"family":true}', 7, 8);
      INSERT INTO action_intents (
        id, provider_id, policy_id, action_type, dedupe_key, state,
        scheduled_for_ms, attempt_count, reason_code, explanation_json,
        started_at_ms, finished_at_ms, last_error_code, created_at_ms, updated_at_ms
      ) VALUES
        ('planned-intent', 'antigravity', 'activation-antigravity-claude-gpt', 'trigger_window', 'planned-dedupe', 'planned', 18, 0, 'MANUAL_TRIGGER_REQUESTED', '{"state":"planned"}', NULL, NULL, NULL, 18, 18),
        ('executing-intent', 'antigravity', 'activation-antigravity-gemini', 'trigger_window', 'executing-dedupe', 'executing', 19, 1, 'MANUAL_TRIGGER_REQUESTED', '{"state":"executing"}', 19, NULL, NULL, 19, 20),
        ('succeeded-intent', 'antigravity', 'activation-antigravity-claude-gpt', 'trigger_window', 'succeeded-dedupe', 'succeeded', 20, 1, 'MANUAL_TRIGGER_REQUESTED', '{"state":"succeeded"}', 20, 21, NULL, 20, 21),
        ('retryable-intent', 'antigravity', 'activation-antigravity', 'trigger_window', 'retryable-dedupe', 'failed_retryable', 22, 2, 'ACTION_DISPATCH_FAILED', '{"state":"failed_retryable"}', 22, NULL, 'EAGAIN', 22, 23);
      INSERT INTO action_resolution_requests (intent_id, generation, state, reason_code, requested_at_ms, checked_at_ms)
      VALUES ('legacy-intent', 2, 'checked', 'ACTION_RESOLUTION_EVIDENCE_MISSING', 12, 13);
      INSERT INTO observed_cycle_closures (intent_id, provider_id, window_kind, cycle_at_ms, ended_at_ms, observed_at_ms, evidence_kind)
      VALUES ('legacy-intent', 'antigravity', 'antigravity_gemini_weekly', 10, 11, 12, 'anchored_boundary');
      INSERT INTO rolling_inactive_resolution_evidence (
        intent_id, provider_id, window_kind, cycle_at_ms, outcome_recorded_at_ms,
        first_observed_at_ms, first_reset_at_ms, last_observed_at_ms, last_reset_at_ms,
        duration_ms, verified_at_ms
      ) VALUES ('family-intent', 'antigravity', 'antigravity_gemini_weekly', 10, 11, 12, 100, 13, 200, 18000000, 14);
      INSERT INTO events (provider_id, type, occurred_at_ms, data_json)
      VALUES ('antigravity', 'action_uncertain', 15, '{"intentId":"legacy-intent"}');
      INSERT INTO settings (key, value_json, updated_at_ms)
      VALUES ('operator-preference', '{"enabled":false}', 16);
      INSERT INTO provider_cleanup_jobs (
        id, provider_id, artifact_kind, external_id, state, not_before_ms, created_at_ms, updated_at_ms
      ) VALUES ('cleanup', 'antigravity', 'antigravity_conversation', 'synthetic-conversation-id', 'pending', 17, 17, 17);
    `);
    previous
      .prepare(
        `INSERT INTO provider_state (
          provider_id, health, observed_at_ms, stale_after_ms, observation_json,
          last_success_at_ms, last_error_code, updated_at_ms
        ) VALUES ('antigravity', 'connected', 19, 30019,
          '{"providerId":"antigravity","observedAt":"1970-01-01T00:00:00.019Z","windows":[]}',
          19, NULL, 19)`,
      )
      .run();
    const sample = previous
      .prepare(
        `INSERT INTO window_samples (
          provider_id, window_kind, observed_at_ms, phase,
          phase_source, phase_confidence, phase_observed_at_ms,
          usage_ratio, usage_source, usage_confidence, usage_observed_at_ms
        ) VALUES ('antigravity', 'antigravity_gemini_weekly', 21, 'INACTIVE',
          'observed', 'exact', 21, 0.25, 'observed', 'exact', 21)`,
      )
      .run();
    const sampleId = Number(sample.lastInsertRowid);
    previous
      .prepare(
        `INSERT INTO usage_intervals (
          source_sample_id, provider_id, window_kind, from_ms, to_ms,
          usage_delta_ratio, quality, reason_code
        ) VALUES (?, 'antigravity', 'antigravity_gemini_weekly', 20, 21, 0.25, 'observed', NULL)`,
      )
      .run(sampleId);
    previous
      .prepare(
        'UPDATE usage_aggregation_checkpoint SET last_sample_id = ?, updated_at_ms = 22 WHERE id = 1',
      )
      .run(sampleId);
    previous
      .prepare(
        'INSERT INTO usage_series_state(provider_id, window_kind, state_json, updated_at_ms) VALUES (?, ?, ?, ?)',
      )
      .run('antigravity', 'antigravity_gemini_weekly', '{"usageRatio":0.25}', 22);

    const readPreservedRows = (db: typeof previous) => ({
      policies: db.prepare('SELECT * FROM schedule_policies ORDER BY id').all(),
      intents: db.prepare('SELECT * FROM action_intents ORDER BY id').all(),
      requests: db.prepare('SELECT * FROM action_resolution_requests ORDER BY intent_id').all(),
      closures: db.prepare('SELECT * FROM observed_cycle_closures ORDER BY intent_id').all(),
      rollingEvidence: db
        .prepare('SELECT * FROM rolling_inactive_resolution_evidence ORDER BY intent_id')
        .all(),
      events: db.prepare('SELECT * FROM events ORDER BY id').all(),
      settings: db.prepare('SELECT * FROM settings ORDER BY key').all(),
      cleanup: db.prepare('SELECT * FROM provider_cleanup_jobs ORDER BY id').all(),
      providerState: db.prepare('SELECT * FROM provider_state ORDER BY provider_id').all(),
      windowSamples: db.prepare('SELECT * FROM window_samples ORDER BY id').all(),
      usageIntervals: db.prepare('SELECT * FROM usage_intervals ORDER BY source_sample_id').all(),
      usageCheckpoint: db.prepare('SELECT * FROM usage_aggregation_checkpoint ORDER BY id').all(),
      usageSeriesState: db
        .prepare('SELECT * FROM usage_series_state ORDER BY provider_id, window_kind')
        .all(),
    });
    const before = readPreservedRows(previous);
    expect(
      previous
        .prepare("SELECT COUNT(*) AS count FROM schedule_policies WHERE scope = 'argon'")
        .get(),
    ).toEqual({ count: 0 });
    previous.close();

    const upgraded = openDatabase(file);
    expect(upgraded.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual(
      {
        version: 14,
      },
    );
    expect(readPreservedRows(upgraded)).toEqual(before);
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM action_intents').get()).toEqual({
      count: 6,
    });
    expect(
      upgraded.prepare('SELECT DISTINCT state FROM action_intents ORDER BY state').all(),
    ).toEqual([
      { state: 'executing' },
      { state: 'failed_retryable' },
      { state: 'planned' },
      { state: 'succeeded' },
      { state: 'uncertain' },
    ]);
    expect(
      upgraded
        .prepare("SELECT COUNT(*) AS count FROM schedule_policies WHERE scope = 'argon'")
        .get(),
    ).toEqual({ count: 0 });
    expect(upgraded.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    expect(upgraded.pragma('integrity_check', { simple: true })).toBe('ok');
    const actionIntentForeignKeys = upgraded
      .prepare('PRAGMA foreign_key_list(action_intents)')
      .all() as Array<{ table: string; from: string; on_delete: string }>;
    expect(
      actionIntentForeignKeys.filter(
        (foreignKey) =>
          foreignKey.table === 'schedule_policies' &&
          foreignKey.from === 'policy_id' &&
          foreignKey.on_delete === 'SET NULL',
      ),
    ).toHaveLength(1);
    expect(
      upgraded
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_schedule_policies_provider_scope'",
        )
        .get(),
    ).toEqual({ name: 'idx_schedule_policies_provider_scope' });
    const policyScopeIndexColumns = upgraded
      .prepare('PRAGMA index_info(idx_schedule_policies_provider_scope)')
      .all() as Array<{ name: string }>;
    expect(policyScopeIndexColumns.map((row) => row.name)).toEqual(['provider_id', 'scope']);
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO action_intents (
          id, provider_id, policy_id, action_type, dedupe_key, state,
          scheduled_for_ms, reason_code, created_at_ms, updated_at_ms
        ) VALUES ('duplicate-intent', 'antigravity', 'activation-antigravity', 'trigger_window', 'legacy-dedupe', 'uncertain', 20, 'synthetic', 20, 20)`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed: action_intents\.dedupe_key/);
    upgraded.close();

    const reopened = openDatabase(file);
    expect(readPreservedRows(reopened)).toEqual(before);
    expect(
      reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 14').get(),
    ).toEqual({
      count: 1,
    });
    expect(reopened.pragma('foreign_key_check')).toEqual([]);
    expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
    reopened.close();
  });

  it('migrates a blank database with SQLite safety pragmas and can reopen it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-'));
    dirs.push(dir);
    const file = path.join(dir, 'awm.db');
    const appliedAtMs = 1_700_000_000_000;

    const db = openDatabase(file, { now: () => appliedAtMs });
    expect(
      db.prepare('SELECT version, applied_at_ms FROM schema_migrations ORDER BY version').all(),
    ).toEqual([
      { version: 1, applied_at_ms: appliedAtMs },
      { version: 2, applied_at_ms: appliedAtMs },
      { version: 3, applied_at_ms: appliedAtMs },
      { version: 4, applied_at_ms: appliedAtMs },
      { version: 5, applied_at_ms: appliedAtMs },
      { version: 6, applied_at_ms: appliedAtMs },
      { version: 7, applied_at_ms: appliedAtMs },
      { version: 8, applied_at_ms: appliedAtMs },
      { version: 9, applied_at_ms: appliedAtMs },
      { version: 10, applied_at_ms: appliedAtMs },
      { version: 11, applied_at_ms: appliedAtMs },
      { version: 12, applied_at_ms: appliedAtMs },
      { version: 13, applied_at_ms: appliedAtMs },
      { version: 14, applied_at_ms: appliedAtMs },
    ]);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(
      db
        .prepare("SELECT 1 FROM pragma_table_info('window_samples') WHERE name = 'phase_source'")
        .get(),
    ).toEqual({ 1: 1 });
    db.close();

    const reopened = openDatabase(file, { now: () => appliedAtMs + 1_000 });
    expect(
      (reopened.prepare('SELECT COUNT(*) AS n FROM action_intents').get() as { n: number }).n,
    ).toBe(0);
    expect(
      (reopened.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n,
    ).toBe(14);
    reopened.close();
  });

  it('supports an explicitly empty migration directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-no-migrations-'));
    dirs.push(dir);
    const migrationsDir = path.join(dir, 'migrations');
    fs.mkdirSync(migrationsDir);

    const db = openDatabase(path.join(dir, 'awm.db'), { migrationsDir });
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });

  it('fails clearly for missing, unsafe, duplicate or unknown migration versions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-invalid-migrations-'));
    dirs.push(dir);
    const missing = path.join(dir, 'does-not-exist');
    expect(() => openDatabase(path.join(dir, 'missing.db'), { migrationsDir: missing })).toThrow(
      'migration directory not found',
    );

    const unsafeVersionDir = path.join(dir, 'unsafe-version');
    fs.mkdirSync(unsafeVersionDir);
    fs.writeFileSync(
      path.join(unsafeVersionDir, '999999999999999999999_bad.sql'),
      'CREATE TABLE bad (id INTEGER);',
    );
    expect(() =>
      openDatabase(path.join(dir, 'unsafe.db'), { migrationsDir: unsafeVersionDir }),
    ).toThrow('invalid migration version');

    const duplicateVersionDir = path.join(dir, 'duplicate-version');
    fs.mkdirSync(duplicateVersionDir);
    fs.writeFileSync(
      path.join(duplicateVersionDir, '001_first.sql'),
      'CREATE TABLE first (id INTEGER);',
    );
    fs.writeFileSync(
      path.join(duplicateVersionDir, '001_second.sql'),
      'CREATE TABLE second (id INTEGER);',
    );
    expect(() =>
      openDatabase(path.join(dir, 'duplicate.db'), { migrationsDir: duplicateVersionDir }),
    ).toThrow('duplicate migration version 1');

    const futureDb = new Database(path.join(dir, 'future.db'));
    futureDb.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at_ms) VALUES (999, 1700000000000);
    `);
    futureDb.close();
    expect(() => openDatabase(path.join(dir, 'future.db'))).toThrow(
      'database migration 999 is not available',
    );
  });

  it('applies migration files by numeric version and rolls back a failed migration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-migrations-'));
    dirs.push(dir);
    const migrationsDir = path.join(dir, 'migrations');
    fs.mkdirSync(migrationsDir);
    fs.writeFileSync(path.join(migrationsDir, '010_third.sql'), 'CREATE TABLE third (id INTEGER);');
    fs.writeFileSync(path.join(migrationsDir, '001_first.sql'), 'CREATE TABLE first (id INTEGER);');
    fs.writeFileSync(path.join(migrationsDir, '002_broken.sql'), 'CREATE TABLE broken (');
    const file = path.join(dir, 'awm.db');

    expect(() => openDatabase(file, { migrationsDir })).toThrow();

    const failed = new Database(file);
    expect(failed.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name = 'first'").get()).toEqual({
      name: 'first',
    });
    expect(
      failed.prepare("SELECT name FROM sqlite_master WHERE name = 'broken'").get(),
    ).toBeUndefined();
    failed.close();
  });

  it('rolls back a foreign-key-off migration with violations and restores enforcement', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-foreign-key-migration-'));
    dirs.push(dir);
    const migrationsDir = path.join(dir, 'migrations');
    fs.mkdirSync(migrationsDir);
    fs.writeFileSync(
      path.join(migrationsDir, '001_invalid_fk.sql'),
      `-- awm:requires-foreign-keys-off
       CREATE TABLE parent (id INTEGER PRIMARY KEY);
       CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));
       INSERT INTO child (parent_id) VALUES (404);`,
    );
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    try {
      expect(() => runMigrations(db, migrationsDir)).toThrow(
        'database migration 1 left a foreign key violation in child',
      );
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name IN ('parent', 'child')").all(),
      ).toEqual([]);
      expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('upgrades an existing version-one database without rewriting its migration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-upgrade-'));
    dirs.push(dir);
    const file = path.join(dir, 'awm.db');
    const legacy = new Database(file);
    legacy.exec(fs.readFileSync(path.resolve('migrations/001_initial.sql'), 'utf8'));
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at_ms) VALUES (1, 1700000000000);
    `);
    legacy.close();

    const upgraded = openDatabase(file);
    expect(
      upgraded.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
      { version: 14 },
    ]);
    expect(
      upgraded
        .prepare(
          "SELECT name FROM pragma_table_info('window_samples') WHERE name = 'phase_confidence'",
        )
        .get(),
    ).toEqual({ name: 'phase_confidence' });
    expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    upgraded.close();
  });

  it('applies provider cleanup migration 007 to a version-six database exactly once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-provider-cleanup-upgrade-'));
    dirs.push(dir);
    const file = path.join(dir, 'awm.db');
    const versionSixMigrations = path.join(dir, 'version-six-migrations');
    fs.mkdirSync(versionSixMigrations);
    for (let version = 1; version <= 6; version += 1) {
      const migration = fs
        .readdirSync(path.resolve('migrations'))
        .find((name) => name.startsWith(`${String(version).padStart(3, '0')}_`));
      if (!migration) throw new Error(`missing migration ${version}`);
      fs.copyFileSync(
        path.resolve('migrations', migration),
        path.join(versionSixMigrations, migration),
      );
    }

    const previous = openDatabase(file, { migrationsDir: versionSixMigrations });
    expect(previous.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual(
      {
        version: 6,
      },
    );
    previous.close();

    const upgraded = openDatabase(file);
    expect(
      upgraded.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
    ).toHaveLength(14);
    expect(
      upgraded
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_cleanup_jobs'",
        )
        .get(),
    ).toEqual({ name: 'provider_cleanup_jobs' });
    expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    upgraded.close();

    const reopened = openDatabase(file);
    expect(
      reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 7').get(),
    ).toEqual({ count: 1 });
    reopened.close();
  });

  it('recovers explicit automation preferences from the settings audit during upgrade', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-settings-upgrade-'));
    dirs.push(dir);
    const file = path.join(dir, 'awm.db');
    const previousMigrations = path.join(dir, 'previous-migrations');
    fs.mkdirSync(previousMigrations);
    for (const version of [1, 2, 3, 4]) {
      const migration = fs
        .readdirSync(path.resolve('migrations'))
        .find((name) => name.startsWith(`${String(version).padStart(3, '0')}_`));
      if (!migration) throw new Error(`missing migration ${version}`);
      fs.copyFileSync(
        path.resolve('migrations', migration),
        path.join(previousMigrations, migration),
      );
    }

    const legacy = openDatabase(file, { migrationsDir: previousMigrations });
    legacy.exec(`
      INSERT INTO providers (id, kind, mode, created_at_ms, updated_at_ms)
      VALUES ('codex', 'codex', 'monitor_only', 1000, 2000),
             ('antigravity', 'antigravity', 'monitor_only', 1000, 2000);
      INSERT INTO schedule_policies (id, provider_id, kind, timezone, config_json, created_at_ms, updated_at_ms)
      VALUES ('activation-codex', 'codex', 'auto', 'UTC', '{}', 1000, 2000),
             ('activation-antigravity', 'antigravity', 'manual', 'UTC', '{}', 1000, 2000);
      INSERT INTO events (occurred_at_ms, provider_id, type, severity, data_json)
      VALUES (2000, 'codex', 'provider_settings_updated', 'info', '{"mode":"automation"}'),
             (2001, 'codex', 'schedule_policy_updated', 'info', '{"policyId":"activation-codex","policyKind":"fixed"}');
    `);
    legacy.close();

    const upgraded = openDatabase(file);
    expect(
      upgraded.prepare('SELECT mode, mode_explicit FROM providers WHERE id = ?').get('codex'),
    ).toEqual({ mode: 'automation', mode_explicit: 1 });
    expect(
      upgraded.prepare('SELECT mode, mode_explicit FROM providers WHERE id = ?').get('antigravity'),
    ).toEqual({ mode: 'monitor_only', mode_explicit: 0 });
    expect(
      upgraded
        .prepare('SELECT kind, kind_explicit FROM schedule_policies WHERE id = ?')
        .get('activation-codex'),
    ).toEqual({ kind: 'fixed', kind_explicit: 1 });
    expect(
      upgraded
        .prepare('SELECT kind, kind_explicit FROM schedule_policies WHERE id = ?')
        .get('activation-antigravity'),
    ).toEqual({ kind: 'manual', kind_explicit: 0 });
    upgraded.close();
  });
});
