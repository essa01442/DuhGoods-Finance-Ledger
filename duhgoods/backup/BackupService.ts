import * as path from 'path';
import * as fs from 'fs';
import type { Fyo } from 'fyo';

export interface BackupResult {
  backupPath: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface RestoreResult {
  ok: boolean;
  message: string;
}

/**
 * Local database backup and restore service.
 *
 * Uses SQLite's built-in VACUUM INTO (for online backup without locking)
 * or a safe file copy when the db path is available.
 *
 * NEVER uploads to cloud services or external APIs.
 * NEVER sends financial data externally.
 *
 * Backup files are local only and stored at a user-specified path.
 */
export class BackupService {
  constructor(private readonly fyo: Fyo) {}

  /**
   * Creates a local backup of the current database.
   *
   * @param backupDir Directory where the backup file should be stored.
   * @returns BackupResult with the path and metadata.
   */
  async createBackup(backupDir: string): Promise<BackupResult> {
    const dbPath = this.fyo.db.dbPath;
    if (!dbPath || dbPath === ':memory:') {
      throw new Error('Cannot backup an in-memory database');
    }

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const backupFileName = `duhgoods-backup-${timestamp}.db`;
    const backupPath = path.join(backupDir, backupFileName);

    // Use VACUUM INTO for a consistent copy without requiring exclusive lock.
    const knex = (this.fyo.db as unknown as { knex: { raw: (sql: string, ...args: unknown[]) => Promise<unknown> } }).knex;
    if (knex) {
      await knex.raw(`VACUUM INTO ?`, [backupPath]);
    } else {
      // Fallback: file copy (requires db to be quiescent)
      fs.copyFileSync(dbPath, backupPath);
    }

    const stats = fs.statSync(backupPath);
    return {
      backupPath,
      sizeBytes: stats.size,
      createdAt: new Date(),
    };
  }

  /**
   * Validates a backup file by opening it and running PRAGMA integrity_check.
   */
  validateBackup(backupPath: string): { valid: boolean; message: string } {
    if (!fs.existsSync(backupPath)) {
      return { valid: false, message: `Backup file not found: ${backupPath}` };
    }

    try {
      // Dynamic require so this doesn't break non-Electron environments.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3') as new (path: string, opts?: unknown) => {
        pragma: (sql: string) => unknown[];
        close: () => void;
      };
      const db = new Database(backupPath, { readonly: true });
      const result = db.pragma('integrity_check') as { integrity_check: string }[];
      db.close();
      const ok = result.length === 1 && result[0]?.integrity_check === 'ok';
      return {
        valid: ok,
        message: ok ? 'Backup integrity check passed' : `Integrity check failed: ${JSON.stringify(result)}`,
      };
    } catch (e) {
      return {
        valid: false,
        message: `Failed to open backup: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Lists available backup files in a directory, sorted by newest first.
   */
  listBackups(backupDir: string): Array<{ name: string; path: string; sizeBytes: number; mtime: Date }> {
    if (!fs.existsSync(backupDir)) return [];
    return fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith('duhgoods-backup-') && f.endsWith('.db'))
      .map((f) => {
        const p = path.join(backupDir, f);
        const stats = fs.statSync(p);
        return { name: f, path: p, sizeBytes: stats.size, mtime: stats.mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }
}
