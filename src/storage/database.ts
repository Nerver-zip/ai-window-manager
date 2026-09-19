import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';

export type SqliteDatabase = Database.Database;

export interface OpenDatabaseOptions {
  migrationsDir?: string;
  now?: () => number;
}

interface MigrationFile {
  name: string;
  version: number;
  path: string;
}

export function openDatabase(filename: string, options: OpenDatabaseOptions = {}): SqliteDatabase {
  const migrationsDir = resolveMigrationsDir(options.migrationsDir);
  const now = options.now ?? Date.now;

  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  try {
    runMigrations(db, migrationsDir, now);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function runMigrations(db: SqliteDatabase, migrationsDir: string, now = Date.now): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => {
        return (row as { version: number }).version;
      }),
  );

  const migrationFiles = readMigrationFiles(migrationsDir);
  const knownVersions = new Set(migrationFiles.map((migration) => migration.version));
  for (const version of applied) {
    if (!knownVersions.has(version)) {
      throw new Error(`database migration ${version} is not available in ${migrationsDir}`);
    }
  }

  for (const migration of migrationFiles) {
    const { version } = migration;
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(migration.path, 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at_ms) VALUES (?, ?)').run(
        version,
        now(),
      );
    });
    apply();
  }
}

function resolveMigrationsDir(explicitDir?: string): string {
  const candidates = explicitDir
    ? [path.resolve(explicitDir)]
    : [
        path.resolve(process.cwd(), 'migrations'),
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations'),
      ];

  const directory = candidates.find((candidate) => fs.existsSync(candidate));
  if (!directory) {
    throw new Error(`migration directory not found; checked: ${candidates.join(', ')}`);
  }
  return directory;
}

function readMigrationFiles(directory: string): MigrationFile[] {
  const byVersion = new Map<number, MigrationFile>();
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^\d+_[^/]+\.sql$/.test(name))
    .map((name) => {
      const version = Number(name.split('_', 1)[0]);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error(`invalid migration version in ${name}`);
      }
      return { name, version, path: path.join(directory, name) };
    });

  for (const migration of files) {
    if (byVersion.has(migration.version)) {
      throw new Error(`duplicate migration version ${migration.version}`);
    }
    byVersion.set(migration.version, migration);
  }

  return files.sort((left, right) => left.version - right.version);
}
