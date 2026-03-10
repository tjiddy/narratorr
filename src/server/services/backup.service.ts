import fs from 'fs/promises';
import fss from 'fs';
import path from 'path';
import archiver from 'archiver';
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'url';
import type { FastifyBaseLogger } from 'fastify';
import type { SettingsService } from './settings.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOURNAL_PATH = path.join(__dirname, '../../../drizzle/meta/_journal.json');

export interface BackupMetadata {
  filename: string;
  timestamp: string;
  size: number;
}

export interface RestoreValidation {
  valid: boolean;
  backupMigrationCount?: number;
  appMigrationCount?: number;
  error?: string;
}

interface PendingRestore {
  tempPath: string;
  validatedAt: number;
}

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class BackupService {
  private backupInProgress = false;
  private _pendingRestore: PendingRestore | null = null;

  constructor(
    private configPath: string,
    private dbPath: string,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
  ) {}

  private get backupsDir(): string {
    return path.join(this.configPath, 'backups');
  }

  private get restorePendingPath(): string {
    return path.join(this.configPath, 'restore-pending.db');
  }

  private async ensureBackupsDir(): Promise<void> {
    await fs.mkdir(this.backupsDir, { recursive: true });
  }

  get pendingRestore(): PendingRestore | null {
    return this._pendingRestore;
  }

  /** Get the app's current migration count from _journal.json */
  private async getAppMigrationCount(): Promise<number> {
    try {
      const journalRaw = await fs.readFile(JOURNAL_PATH, 'utf-8');
      const journal = JSON.parse(journalRaw) as { entries: unknown[] };
      return journal.entries.length;
    } catch {
      this.log.warn('Could not read _journal.json, assuming 0 migrations');
      return 0;
    }
  }

  /** Create a backup using VACUUM INTO for a consistent snapshot */
  async create(): Promise<BackupMetadata> {
    if (this.backupInProgress) {
      throw new Error('Backup already in progress');
    }

    this.backupInProgress = true;
    await this.ensureBackupsDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '');
    const filename = `narratorr-backup-${timestamp}.zip`;
    const zipPath = path.join(this.backupsDir, filename);
    const tempDbPath = path.join(this.configPath, `backup-temp-${timestamp}.db`);

    try {
      // Step 1: VACUUM INTO for consistent snapshot
      const client = createClient({ url: `file:${this.dbPath}` });
      try {
        await client.execute(`VACUUM INTO '${tempDbPath}'`);
      } finally {
        client.close();
      }

      // Step 2: Zip the snapshot
      await new Promise<void>((resolve, reject) => {
        const output = fss.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', resolve);
        archive.on('error', reject);

        archive.pipe(output);
        archive.file(tempDbPath, { name: 'narratorr.db' });
        archive.finalize();
      });

      // Step 3: Clean up temp file
      await fs.unlink(tempDbPath).catch(() => {});

      const stat = await fs.stat(zipPath);
      const metadata: BackupMetadata = {
        filename,
        timestamp: new Date().toISOString(),
        size: stat.size,
      };

      this.log.info({ filename, size: stat.size }, 'Backup created');
      return metadata;
    } catch (error) {
      // Clean up on failure
      await fs.unlink(tempDbPath).catch(() => {});
      await fs.unlink(zipPath).catch(() => {});
      throw error;
    } finally {
      this.backupInProgress = false;
    }
  }

  /** List all backups sorted by timestamp descending */
  async list(): Promise<BackupMetadata[]> {
    await this.ensureBackupsDir();

    const files = await fs.readdir(this.backupsDir);
    const backups: BackupMetadata[] = [];

    for (const file of files) {
      if (!file.startsWith('narratorr-backup-') || !file.endsWith('.zip')) continue;

      const filePath = path.join(this.backupsDir, file);
      const stat = await fs.stat(filePath);

      // Exclude corrupted (zero-size) backups
      if (stat.size === 0) continue;

      backups.push({
        filename: file,
        timestamp: stat.mtime.toISOString(),
        size: stat.size,
      });
    }

    return backups.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** Prune oldest backups exceeding retention limit */
  async prune(): Promise<number> {
    const systemSettings = await this.settingsService.get('system');
    const retention = systemSettings.backupRetention;

    const backups = await this.list();
    if (backups.length <= retention) return 0;

    const toDelete = backups.slice(retention);
    let deleted = 0;

    for (const backup of toDelete) {
      try {
        await fs.unlink(path.join(this.backupsDir, backup.filename));
        deleted++;
      } catch (error) {
        this.log.warn({ filename: backup.filename, error }, 'Failed to delete old backup');
      }
    }

    if (deleted > 0) {
      this.log.info({ deleted, retention }, 'Pruned old backups');
    }

    return deleted;
  }

  /** Get the file path for a backup, with path traversal protection */
  getBackupPath(filename: string): string | null {
    // Reject path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return null;
    }
    if (!filename.startsWith('narratorr-backup-') || !filename.endsWith('.zip')) {
      return null;
    }
    return path.join(this.backupsDir, filename);
  }

  /** Validate an uploaded restore file */
  async validateRestore(tempPath: string): Promise<RestoreValidation> {
    const appMigrationCount = await this.getAppMigrationCount();

    try {
      // Check it's a valid SQLite file by attempting to open with libSQL
      const client = createClient({ url: `file:${tempPath}` });
      try {
        const result = await client.execute('SELECT COUNT(*) as count FROM __drizzle_migrations');
        const backupMigrationCount = Number(result.rows[0].count);

        if (backupMigrationCount > appMigrationCount) {
          return {
            valid: false,
            backupMigrationCount,
            appMigrationCount,
            error: `Backup has ${backupMigrationCount} migrations but app only has ${appMigrationCount}. This backup is from a newer version.`,
          };
        }

        return { valid: true, backupMigrationCount, appMigrationCount };
      } finally {
        client.close();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      if (message.includes('__drizzle_migrations')) {
        return { valid: false, error: 'Not a valid Narratorr database — missing migrations table' };
      }

      return { valid: false, error: `Invalid database file: ${message}` };
    }
  }

  /** Store a validated restore for later confirmation */
  async setPendingRestore(tempPath: string): Promise<void> {
    // Clean up existing pending restore if any
    if (this._pendingRestore) {
      await fs.unlink(this._pendingRestore.tempPath).catch(() => {});
    }

    this._pendingRestore = {
      tempPath,
      validatedAt: Date.now(),
    };
  }

  /** Confirm and stage the pending restore */
  async confirmRestore(): Promise<void> {
    if (!this._pendingRestore) {
      throw new Error('No pending restore');
    }

    if (Date.now() - this._pendingRestore.validatedAt > PENDING_TTL_MS) {
      await fs.rm(path.dirname(this._pendingRestore.tempPath), { recursive: true }).catch(() => {});
      this._pendingRestore = null;
      throw new Error('Pending restore has expired');
    }

    const { tempPath } = this._pendingRestore;

    // Stage the validated DB to the well-known pending path
    await fs.copyFile(tempPath, this.restorePendingPath);

    // Clean up the validation temp file and its parent extraction directory
    await fs.rm(path.dirname(tempPath), { recursive: true }).catch(() => {});
    this._pendingRestore = null;

    this.log.info('Restore staged to restore-pending.db — process will exit');
  }
}

/**
 * Startup swap hook: check for restore-pending.db and swap it in before DB is opened.
 * Call this BEFORE runMigrations/createDb in main().
 */
export function applyPendingRestore(configPath: string, dbPath: string, log: { info: (msg: string) => void; warn: (msg: string) => void }): void {
  const pendingPath = path.join(configPath, 'restore-pending.db');

  if (!fss.existsSync(pendingPath)) return;

  try {
    fss.renameSync(pendingPath, dbPath);
    log.info('Restored database from pending backup');
  } catch {
    // Rename failed (cross-device?) — fall back to copy + delete
    try {
      fss.copyFileSync(pendingPath, dbPath);
      fss.unlinkSync(pendingPath);
      log.warn('Restored database from pending backup (copy fallback — rename failed)');
    } catch (copyError) {
      log.warn(`Failed to apply pending restore: ${copyError instanceof Error ? copyError.message : 'unknown error'}`);
    }
  }
}
