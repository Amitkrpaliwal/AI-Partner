import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Minimal interface so MigrationRunner doesn't import DatabaseService directly
// (avoids circular dependency since DatabaseService imports MigrationRunner)
interface DB {
  run(sql: string, params?: any[]): Promise<void>;
  all(sql: string, params?: any[]): Promise<any[]>;
  exec(sql: string): Promise<void>;
}

export class MigrationRunner {
  constructor(private db: DB) {}

  async run(): Promise<void> {
    // Ensure the tracking table exists before anything else
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        filename TEXT NOT NULL,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Read migration files sorted numerically by their numeric prefix
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => /^\d+_.+\.sql$/.test(f))
      .sort(); // lexicographic sort works because filenames are zero-padded (001_, 002_, ...)

    // Fetch already-applied versions
    const applied: { version: number }[] = await this.db.all(
      'SELECT version FROM schema_migrations ORDER BY version ASC'
    );
    const appliedSet = new Set(applied.map(r => r.version));

    // Apply pending migrations in order
    for (const file of files) {
      const version = parseInt(file.split('_')[0], 10);
      if (appliedSet.has(version)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      console.log(`[MigrationRunner] Applying migration ${version}: ${file}`);

      try {
        // exec handles multi-statement SQL files
        await this.db.exec(sql);
        // Record the migration after successful exec
        await this.db.run(
          'INSERT INTO schema_migrations (version, filename) VALUES (?, ?)',
          [version, file]
        );
        console.log(`[MigrationRunner] Migration ${version} applied OK`);
      } catch (err) {
        throw new Error(`[MigrationRunner] Migration ${version} (${file}) failed: ${err}`);
      }
    }
  }

  async getAppliedMigrations(): Promise<{ version: number; filename: string; applied_at: string }[]> {
    return this.db.all('SELECT * FROM schema_migrations ORDER BY version ASC');
  }
}
