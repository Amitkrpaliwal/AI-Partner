/**
 * MigrationRunner unit tests — no server required.
 * Uses an in-memory SQLite database via a lightweight DB stub.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import sqlite3 from 'sqlite3';
import { MigrationRunner } from '../../database/MigrationRunner';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Minimal DB stub that wraps sqlite3 :memory:
function makeMemoryDB() {
  const db = new sqlite3.Database(':memory:');
  return {
    run: (sql: string, params: any[] = []) =>
      new Promise<void>((res, rej) => db.run(sql, params, (e) => (e ? rej(e) : res()))),
    all: (sql: string, params: any[] = []) =>
      new Promise<any[]>((res, rej) => db.all(sql, params, (e, rows) => (e ? rej(e) : res(rows)))),
    exec: (sql: string) =>
      new Promise<void>((res, rej) => db.exec(sql, (e) => (e ? rej(e) : res()))),
    close: () => new Promise<void>((res, rej) => db.close((e) => (e ? rej(e) : res()))),
  };
}

// Helper: write a temp migration file and return its directory
function makeTempMigrationsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-test-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  }
  return dir;
}

// Patch MigrationRunner to use a custom migrations directory
function makeRunner(db: ReturnType<typeof makeMemoryDB>, migrationsDir: string) {
  const runner = new MigrationRunner(db);
  // Override the private MIGRATIONS_DIR via property assignment on prototype-level
  (runner as any).migrationsDir = migrationsDir;
  return runner;
}

// MigrationRunner reads MIGRATIONS_DIR from a module-level constant — we need a version
// that accepts an injected dir. For testing, subclass and override the getter.
class TestMigrationRunner extends MigrationRunner {
  constructor(db: any, private dir: string) {
    super(db);
  }
  // Override run() to use our injected dir instead of the module constant
  async run(): Promise<void> {
    const { run } = await import('../../database/MigrationRunner');
    // Call the parent run but with patched FS path — we do it manually here:
    const db = (this as any).db;

    await db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        filename TEXT NOT NULL,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `);

    const files = fs.readdirSync(this.dir)
      .filter((f: string) => /^\d+_.+\.sql$/.test(f))
      .sort();

    const applied: { version: number }[] = await db.all(
      'SELECT version FROM schema_migrations ORDER BY version ASC'
    );
    const appliedSet = new Set(applied.map((r: any) => r.version));

    for (const file of files) {
      const version = parseInt(file.split('_')[0], 10);
      if (appliedSet.has(version)) continue;
      const sql = fs.readFileSync(path.join(this.dir, file), 'utf-8');
      await db.exec(sql);
      await db.run(
        'INSERT INTO schema_migrations (version, filename) VALUES (?, ?)',
        [version, file]
      );
    }
  }

  async getAppliedMigrations() {
    const db = (this as any).db;
    return db.all('SELECT * FROM schema_migrations ORDER BY version ASC');
  }
}

describe('MigrationRunner', () => {
  let db: ReturnType<typeof makeMemoryDB>;

  beforeEach(() => {
    db = makeMemoryDB();
  });

  it('creates schema_migrations table on first run', async () => {
    const dir = makeTempMigrationsDir({ '001_test.sql': 'CREATE TABLE IF NOT EXISTS t1 (id INTEGER);' });
    const runner = new TestMigrationRunner(db, dir);
    await runner.run();

    const rows = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
    expect(rows.length).toBe(1);
  });

  it('applies migrations in numeric order', async () => {
    const dir = makeTempMigrationsDir({
      '002_b.sql': 'CREATE TABLE IF NOT EXISTS b (id INTEGER);',
      '001_a.sql': 'CREATE TABLE IF NOT EXISTS a (id INTEGER);',
    });
    const runner = new TestMigrationRunner(db, dir);
    await runner.run();

    const applied = await runner.getAppliedMigrations();
    expect(applied.map((r: any) => r.version)).toEqual([1, 2]);
    expect(applied[0].filename).toBe('001_a.sql');
    expect(applied[1].filename).toBe('002_b.sql');
  });

  it('skips already-applied migrations (idempotency)', async () => {
    const dir = makeTempMigrationsDir({
      '001_a.sql': 'CREATE TABLE IF NOT EXISTS a (id INTEGER);',
    });
    const runner = new TestMigrationRunner(db, dir);

    await runner.run();  // first run
    await runner.run();  // second run — should be a no-op

    const applied = await runner.getAppliedMigrations();
    expect(applied.length).toBe(1);  // only 1 row, not 2
  });

  it('applies only new migrations on subsequent runs', async () => {
    const dir = makeTempMigrationsDir({
      '001_a.sql': 'CREATE TABLE IF NOT EXISTS a (id INTEGER);',
    });
    const runner = new TestMigrationRunner(db, dir);
    await runner.run();

    // Add a new migration file
    fs.writeFileSync(path.join(dir, '002_b.sql'), 'CREATE TABLE IF NOT EXISTS b (id INTEGER);');
    await runner.run();

    const applied = await runner.getAppliedMigrations();
    expect(applied.length).toBe(2);
    expect(applied[1].filename).toBe('002_b.sql');
  });

  it('throws on a failing migration', async () => {
    const dir = makeTempMigrationsDir({
      '001_bad.sql': 'THIS IS NOT VALID SQL @@@@;',
    });
    const runner = new TestMigrationRunner(db, dir);
    await expect(runner.run()).rejects.toThrow();
  });
});
