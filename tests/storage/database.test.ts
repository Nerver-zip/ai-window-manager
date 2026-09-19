import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('migrates a blank database and can reopen it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-'));
    dirs.push(dir);
    const file = path.join(dir, 'awm.db');

    const db = openDatabase(file);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n,
    ).toBe(1);
    db.close();

    const reopened = openDatabase(file);
    expect(
      (reopened.prepare('SELECT COUNT(*) AS n FROM action_intents').get() as { n: number }).n,
    ).toBe(0);
    reopened.close();
  });

  it('creates the metadata table without migrations when the directory is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-no-migrations-'));
    dirs.push(dir);
    const originalCwd = process.cwd();
    process.chdir(dir);

    try {
      const db = openDatabase(path.join(dir, 'awm.db'));
      expect(
        (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n,
      ).toBe(0);
      db.close();
    } finally {
      process.chdir(originalCwd);
    }
  });
});
