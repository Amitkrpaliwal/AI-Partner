import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.AI_PARTNER_DATA_DIR
    ? path.join(process.env.AI_PARTNER_DATA_DIR, 'coworker.db')
    : path.join(__dirname, '../../../coworker.db');

export class DatabaseService {
  private db: sqlite3.Database;
  private connectionReady: Promise<void>;

  constructor() {
    // Ensure directory exists
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Open the DB connection; store a promise so initialize() can await it
    this.connectionReady = new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
          console.error('Could not connect to database', err);
          reject(err);
        } else {
          console.log('Connected to SQLite database (sqlite3)');
          resolve();
        }
      });
    });
  }

  /**
   * Run database migrations. Must be called once at app startup before any
   * other service that touches the DB. Idempotent — safe to call multiple times.
   */
  public async initialize(): Promise<void> {
    await this.connectionReady;
    const { MigrationRunner } = await import('./MigrationRunner.js');
    const runner = new MigrationRunner(this);
    await runner.run();
    console.log('[Database] Migrations complete');
  }

  // Wrapper methods to maintain Promise compatibility
  public get(sql: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  public all(sql: string, params: any[] = []): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  public run(sql: string, params: any[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Execute multi-statement SQL (e.g. migration files). */
  public exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // Expose raw db
  public get raw() {
    return this.db;
  }
}

export const db = new DatabaseService();
