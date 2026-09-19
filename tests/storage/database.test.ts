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
    ]);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
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
    ).toBe(2);
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
    ).toEqual([{ version: 1 }, { version: 2 }]);
    expect(
      upgraded
        .prepare(
          "SELECT name FROM pragma_table_info('window_samples') WHERE name = 'phase_confidence'",
        )
        .get(),
    ).toEqual({ name: 'phase_confidence' });
    upgraded.close();
  });
});
