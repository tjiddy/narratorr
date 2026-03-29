import fs from 'fs/promises';
import fss from 'fs';
import path from 'path';
import os from 'os';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { createClient } from '@libsql/client';
import { fileURLToPath } from 'url';
import type { FastifyBaseLogger } from 'fastify';
import type { Readable } from 'stream';
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
        const escapedPath = tempDbPath.replace(/'/g, "''");
        await client.execute(`VACUUM INTO '${escapedPath}'`);
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
    } catch (error: unknown) {
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
      } catch (error: unknown) {
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

  /** Process a restore file upload: extract zip, validate DB, stage for confirmation. */
  async processRestoreUpload(fileStream: Readable): Promise<RestoreValidation & { valid: true; backupMigrationCount: number; appMigrationCount: number }> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'narratorr-restore-'));
    const tempDbPath = path.join(tempDir, 'narratorr-restore.db');

    try {
      let found = false;

      await new Promise<void>((resolve, reject) => {
        const zipStream = fileStream.pipe(unzipper.Parse());
        zipStream.on('entry', (entry: { path: string; autodrain: () => void; pipe: (dest: NodeJS.WritableStream) => void }) => {
          if (entry.path === 'narratorr.db') {
            found = true;
            const writeStream = fss.createWriteStream(tempDbPath);
            entry.pipe(writeStream);
            writeStream.on('finish', () => {});
            writeStream.on('error', reject);
          } else {
            entry.autodrain();
          }
        });
        zipStream.on('close', resolve);
        zipStream.on('error', reject);
      });

      if (!found) {
        await fs.rm(tempDir, { recursive: true }).catch(() => {});
        throw new RestoreUploadError('Zip does not contain narratorr.db', 'MISSING_DB');
      }

      const validation = await this.validateRestore(tempDbPath);

      if (!validation.valid) {
        await fs.rm(tempDir, { recursive: true }).catch(() => {});
        throw new RestoreUploadError(validation.error!, 'INVALID_DB');
      }

      await this.setPendingRestore(tempDbPath);

      return {
        valid: true as const,
        backupMigrationCount: validation.backupMigrationCount!,
        appMigrationCount: validation.appMigrationCount!,
      };
    } catch (error: unknown) {
      if (error instanceof RestoreUploadError) throw error;
      await fs.rm(tempDir, { recursive: true }).catch(() => {});
      // System-level I/O errors (ENOSPC, EACCES, etc.) should propagate as unexpected failures,
      // not be misreported as bad zip files. Only zip-format parse failures become INVALID_ZIP.
      const isSystemError = error instanceof Error && 'code' in error && typeof (error as NodeJS.ErrnoException).code === 'string';
      if (isSystemError) throw error;
      throw new RestoreUploadError('File is not a valid zip archive', 'INVALID_ZIP');
    }
  }

  /** Validate an uploaded restore file */
  async validateRestore(tempPath: string): Promise<RestoreValidation> {
    const appMigrationCount = await this.getAppMigrationCount();

    try {
      // Check it's a valid SQLite file by attempting to open with libSQL
      const client = createClient({ url: `file:${tempPath}` });
      try {
        // Check migrations table exists via sqlite_master (structured check, no string matching)
        const tableCheck = await client.execute(
          "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
        );
        if (Number(tableCheck.rows[0].count) === 0) {
          return { valid: false, error: 'Not a valid Narratorr database — missing migrations table' };
        }

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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
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

export class RestoreUploadError extends Error {
  constructor(
    message: string,
    public code: 'MISSING_DB' | 'INVALID_DB' | 'INVALID_ZIP',
  ) {
    super(message);
    this.name = 'RestoreUploadError';
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
    } catch (copyError: unknown) {
      log.warn(`Failed to apply pending restore: ${copyError instanceof Error ? copyError.message : 'unknown error'}`);
    }
  }
}
