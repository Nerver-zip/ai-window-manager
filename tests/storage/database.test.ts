import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
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
        version: 9,
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
      version: 9,
    });
    db.close();
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
    ]);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
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
    ).toBe(9);
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
    ).toHaveLength(9);
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
