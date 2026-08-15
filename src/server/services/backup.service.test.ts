import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import fss from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import { BackupService, RestoreUploadError, applyPendingRestore } from './backup.service.js';
import { createMockSettingsService } from '../__tests__/helpers.js';
import { removeTree } from '@core/utils/remove-tree.js';

// This must stay constructible: production calls `new ZipArchive(...)`, so an arrow-backed vi.fn throws.
vi.mock('archiver', () => ({
  ZipArchive: vi.fn(function () {
    let _output: EventEmitter | undefined;
    const archive = {
      pipe: vi.fn((o: EventEmitter) => { _output = o; }),
      file: vi.fn(),
      finalize: vi.fn(() => {
        if (_output) setImmediate(() => _output!.emit('close'));
      }),
      on: vi.fn((_event: string, _cb: () => void) => archive),
    };
    return archive;
  }),
}));

const mockExecute = vi.fn();
const mockClose = vi.fn();
// Spied, not replaced: only the four restore-cleanup cases below make a removal fail.
const actualRemoveTree = await vi.importActual<typeof import('@core/utils/remove-tree.js')>('@core/utils/remove-tree.js');

vi.mock('@core/utils/remove-tree.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  removeTree: vi.fn(),
}));

vi.mock('@libsql/client', () => ({
  createClient: vi.fn(() => ({
    execute: mockExecute,
    close: mockClose,
  })),
}));

function createMockLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as never;
}

// archiver is mocked suite-wide, so building real zip fixtures needs importActual.
async function createZipBuffer(entries: { name: string; content: Buffer }[]): Promise<Buffer> {
  const { ZipArchive } = await vi.importActual<typeof import('archiver')>('archiver');
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 0 } });
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const entry of entries) {
      archive.append(entry.content, { name: entry.name });
    }
    archive.finalize();
  });
}

// Every describe removes real temp dirs; only the cleanup-warn cases below re-arm it to fail.
beforeEach(() => {
  vi.mocked(removeTree).mockReset();
  vi.mocked(removeTree).mockImplementation(actualRemoveTree.removeTree);
});

describe('BackupService', () => {
  let tempDir: string;
  let configPath: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'narratorr-test-'));
    configPath = tempDir;
    dbPath = path.join(tempDir, 'narratorr.db');
    await fs.writeFile(dbPath, 'test-db-content');
    mockExecute.mockReset();
    mockClose.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('list', () => {
    it('returns empty array when no backups exist', async () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.list();
      expect(result).toEqual([]);
    });

    it('returns backups sorted by timestamp descending', async () => {
      const backupsDir = path.join(configPath, 'backups');
      await fs.mkdir(backupsDir, { recursive: true });

      const file1 = 'narratorr-backup-20260101T000000000Z.zip';
      const file2 = 'narratorr-backup-20260102T000000000Z.zip';
      await fs.writeFile(path.join(backupsDir, file1), 'data1');
      // Ensure distinct mtimes.
      await new Promise(r => setTimeout(r, 50));
      await fs.writeFile(path.join(backupsDir, file2), 'data2');

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.list();

      expect(result).toHaveLength(2);
      expect(result[0]!.filename).toBe(file2);
      expect(result[1]!.filename).toBe(file1);
    });

    it('excludes backups with size=0 from list', async () => {
      const backupsDir = path.join(configPath, 'backups');
      await fs.mkdir(backupsDir, { recursive: true });

      await fs.writeFile(path.join(backupsDir, 'narratorr-backup-20260101T000000000Z.zip'), '');
      await fs.writeFile(path.join(backupsDir, 'narratorr-backup-20260102T000000000Z.zip'), 'data');

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.list();

      expect(result).toHaveLength(1);
      expect(result[0]!.filename).toBe('narratorr-backup-20260102T000000000Z.zip');
    });

    it('ignores non-backup files', async () => {
      const backupsDir = path.join(configPath, 'backups');
      await fs.mkdir(backupsDir, { recursive: true });

      await fs.writeFile(path.join(backupsDir, 'other-file.zip'), 'data');
      await fs.writeFile(path.join(backupsDir, 'narratorr-backup-20260101T000000000Z.zip'), 'data');

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.list();

      expect(result).toHaveLength(1);
    });
  });

  describe('create', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let createWriteStreamSpy: any;
    let mkdirSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mockExecute.mockResolvedValue({ rows: [] });

      mkdirSpy = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);

      // The archiver mock emits `close` on this stream.
      const mockStream = new EventEmitter();
      createWriteStreamSpy = vi.spyOn(fss, 'createWriteStream').mockReturnValue(mockStream as unknown as fss.WriteStream);
    });

    afterEach(() => {
      createWriteStreamSpy.mockRestore();
      mkdirSpy.mockRestore();
    });

    it('creates backup zip and returns metadata', async () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

      const statSpy = vi.spyOn(fs, 'stat').mockResolvedValue({ size: 12345 } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      const result = await service.create();

      expect(result.filename).toMatch(/^narratorr-backup-.*\.zip$/);
      expect(result.timestamp).toBeDefined();
      expect(result.size).toBe(12345);
      expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('VACUUM INTO'));
      expect(mockClose).toHaveBeenCalled();

      statSpy.mockRestore();
    });

    it('escapes single quotes in VACUUM INTO path (doubles them for SQL literal safety)', async () => {
      const pathWithQuote = "/config/it's-a-path";
      const service = new BackupService(pathWithQuote, dbPath, createMockSettingsService(), createMockLog());

      const statSpy = vi.spyOn(fs, 'stat').mockResolvedValue({ size: 100 } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      await service.create();

      const sqlArg = mockExecute.mock.calls[0]![0] as string;
      expect(sqlArg).toContain("it''s-a-path");
      expect(sqlArg).not.toMatch(/it's-a-path/);

      statSpy.mockRestore();
    });

    it('VACUUM INTO path is built from controlled inputs only (configPath + timestamp)', async () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

      const statSpy = vi.spyOn(fs, 'stat').mockResolvedValue({ size: 100 } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      await service.create();

      const sqlArg = mockExecute.mock.calls[0]![0] as string;
      expect(sqlArg).toContain(configPath.replace(/'/g, "''"));
      expect(sqlArg).toContain('backup-temp-');
      expect(sqlArg).toMatch(/VACUUM INTO '.*backup-temp-\d{4}-\d{2}-\d{2}T\d+Z\.db'/);

      statSpy.mockRestore();
    });

    it('rejects concurrent backup with "already in progress"', async () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const statSpy = vi.spyOn(fs, 'stat').mockResolvedValue({ size: 100 } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      const first = service.create();
      const second = service.create();

      await expect(second).rejects.toThrow('Backup already in progress');
      await first;

      statSpy.mockRestore();
    });

    it('cleans up temp file after successful backup', async () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const statSpy = vi.spyOn(fs, 'stat').mockResolvedValue({ size: 100 } as unknown as Awaited<ReturnType<typeof fs.stat>>);
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockResolvedValue();

      await service.create();

      expect(unlinkSpy).toHaveBeenCalledWith(expect.stringContaining('backup-temp-'));

      statSpy.mockRestore();
      unlinkSpy.mockRestore();
    });

    it('cleans up on failure', async () => {
      mockExecute.mockRejectedValue(new Error('VACUUM failed'));

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockResolvedValue();

      await expect(service.create()).rejects.toThrow('VACUUM failed');

      const unlinkCalls = unlinkSpy.mock.calls.map(c => c[0] as string);
      expect(unlinkCalls.some(p => p.includes('backup-temp-'))).toBe(true);
      expect(unlinkCalls.some(p => p.endsWith('.zip'))).toBe(true);

      unlinkSpy.mockRestore();
    });

    it('resets backupInProgress flag after failure', async () => {
      mockExecute.mockRejectedValueOnce(new Error('VACUUM failed'));

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockResolvedValue();

      await expect(service.create()).rejects.toThrow('VACUUM failed');

      mockExecute.mockResolvedValue({ rows: [] });
      const statSpy = vi.spyOn(fs, 'stat').mockResolvedValue({ size: 100 } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      const result = await service.create();
      expect(result.filename).toMatch(/^narratorr-backup-.*\.zip$/);

      statSpy.mockRestore();
      unlinkSpy.mockRestore();
    });
  });

  describe('prune', () => {
    it('with retention=3 and 5 backups, deletes the 2 oldest', async () => {
      const backupsDir = path.join(configPath, 'backups');
      await fs.mkdir(backupsDir, { recursive: true });

      const files = [];
      for (let i = 1; i <= 5; i++) {
        const name = `narratorr-backup-2026010${i}T000000000Z.zip`;
        files.push(name);
        await fs.writeFile(path.join(backupsDir, name), `data${i}`);
        await new Promise(r => setTimeout(r, 20));
      }

      const service = new BackupService(configPath, dbPath, createMockSettingsService({ system: { backupRetention: 3 } }), createMockLog());
      const deleted = await service.prune();

      expect(deleted).toBe(2);
      const remaining = await fs.readdir(backupsDir);
      expect(remaining).toHaveLength(3);
    });

    it('logs warning and continues when fs.unlink fails for one backup during prune', async () => {
      const backupsDir = path.join(configPath, 'backups');
      await fs.mkdir(backupsDir, { recursive: true });

      for (let i = 1; i <= 4; i++) {
        const name = `narratorr-backup-2026010${i}T000000000Z.zip`;
        await fs.writeFile(path.join(backupsDir, name), `data${i}`);
        await new Promise(r => setTimeout(r, 20));
      }

      const unlinkSpy = vi.spyOn(fs, 'unlink')
        .mockRejectedValueOnce(new Error('EACCES: permission denied'))
        .mockResolvedValueOnce(undefined as never);

      const mockLog = createMockLog() as unknown as { warn: ReturnType<typeof vi.fn>; [k: string]: unknown };
      const service = new BackupService(configPath, dbPath, createMockSettingsService({ system: { backupRetention: 2 } }), mockLog as never);
      const deleted = await service.prune();

      expect(deleted).toBe(1);
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ filename: expect.any(String) }),
        'Failed to delete old backup',
      );

      unlinkSpy.mockRestore();
    });

    it('with retention=3 and 2 backups, deletes nothing', async () => {
      const backupsDir = path.join(configPath, 'backups');
      await fs.mkdir(backupsDir, { recursive: true });

      await fs.writeFile(path.join(backupsDir, 'narratorr-backup-20260101T000000000Z.zip'), 'data1');
      await fs.writeFile(path.join(backupsDir, 'narratorr-backup-20260102T000000000Z.zip'), 'data2');

      const service = new BackupService(configPath, dbPath, createMockSettingsService({ system: { backupRetention: 3 } }), createMockLog());
      const deleted = await service.prune();

      expect(deleted).toBe(0);
    });
  });

  describe('getBackupPath', () => {
    it('returns path for valid backup filename', () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = service.getBackupPath('narratorr-backup-20260101T000000000Z.zip');
      expect(result).toBe(path.join(configPath, 'backups', 'narratorr-backup-20260101T000000000Z.zip'));
    });

    it('rejects path traversal attempts', () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      expect(service.getBackupPath('../etc/passwd')).toBeNull();
      expect(service.getBackupPath('narratorr-backup-../../etc.zip')).toBeNull();
    });

    it('rejects invalid filenames', () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      expect(service.getBackupPath('other-file.zip')).toBeNull();
      expect(service.getBackupPath('narratorr-backup-test.tar')).toBeNull();
    });

    it('rejects filenames with forward slashes', () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      expect(service.getBackupPath('path/narratorr-backup-test.zip')).toBeNull();
    });

    it('rejects filenames with backslashes', () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      expect(service.getBackupPath('path\\narratorr-backup-test.zip')).toBeNull();
    });
  });

  describe('deleteBackup', () => {
    it('unlinks the joined backups-dir path and info-logs the deletion', async () => {
      const filename = 'narratorr-backup-20260101T000000000Z.zip';
      const backupsDir = path.join(configPath, 'backups');
      await fs.mkdir(backupsDir, { recursive: true });
      await fs.writeFile(path.join(backupsDir, filename), 'data');

      const unlinkSpy = vi.spyOn(fs, 'unlink');
      const mockLog = createMockLog() as unknown as { info: ReturnType<typeof vi.fn>; [k: string]: unknown };
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), mockLog as never);

      await service.deleteBackup(filename);

      expect(unlinkSpy).toHaveBeenCalledWith(path.join(backupsDir, filename));
      expect(mockLog.info).toHaveBeenCalledWith({ filename }, 'Backup deleted');
      const remaining = await fs.readdir(backupsDir);
      expect(remaining).not.toContain(filename);

      unlinkSpy.mockRestore();
    });

    it('throws without calling fs.unlink for a path-traversal / invalid filename', async () => {
      const unlinkSpy = vi.spyOn(fs, 'unlink');
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

      await expect(service.deleteBackup('../etc/passwd')).rejects.toThrow('Invalid backup filename');
      await expect(service.deleteBackup('path\\narratorr-backup-test.zip')).rejects.toThrow('Invalid backup filename');
      await expect(service.deleteBackup('other-file.zip')).rejects.toThrow('Invalid backup filename');
      expect(unlinkSpy).not.toHaveBeenCalled();

      unlinkSpy.mockRestore();
    });

    it('tolerates an already-missing file (ENOENT) without surfacing a failure', async () => {
      const backupsDir = path.join(configPath, 'backups');
      await fs.mkdir(backupsDir, { recursive: true });

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

      await expect(service.deleteBackup('narratorr-backup-20260101T000000000Z.zip')).resolves.toBeUndefined();
    });

    it('re-throws non-ENOENT unlink errors', async () => {
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      );
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

      await expect(service.deleteBackup('narratorr-backup-20260101T000000000Z.zip')).rejects.toThrow('EACCES');

      unlinkSpy.mockRestore();
    });
  });

  describe('validateRestore', () => {
    it('falls back to appMigrationCount=0 and logs warning when app DB query fails', async () => {
      // getAppMigrationCount runs first; sqlite_master and the backup migration count follow.
      mockExecute.mockRejectedValueOnce(new Error('database is locked'));
      mockExecute.mockResolvedValueOnce({ rows: [{ count: 1 }] });
      mockExecute.mockResolvedValueOnce({ rows: [{ count: 1 }] });

      const mockLog = createMockLog() as unknown as { warn: ReturnType<typeof vi.fn>; [k: string]: unknown };
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), mockLog as never);
      const result = await service.validateRestore('/tmp/test.db');

      expect(result.valid).toBe(false);
      expect(result.appMigrationCount).toBe(0);
      expect(result.backupMigrationCount).toBe(1);
      expect(result.error).toContain('newer version');
      expect(mockLog.warn).toHaveBeenCalledWith('Could not query app migration count, assuming 0');
    });

    it('returns valid=true for DB with same migration count as app', async () => {
      mockExecute.mockResolvedValue({ rows: [{ count: 1 }] });

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.validateRestore('/tmp/test.db');

      expect(result.valid).toBe(true);
      expect(result.backupMigrationCount).toBe(1);
      expect(mockClose).toHaveBeenCalled();
    });

    it('returns valid=true for DB with fewer migrations than app', async () => {
      // getAppMigrationCount runs first; sqlite_master and the backup migration count follow.
      mockExecute.mockResolvedValueOnce({ rows: [{ count: 2 }] });
      mockExecute.mockResolvedValueOnce({ rows: [{ count: 1 }] });
      mockExecute.mockResolvedValueOnce({ rows: [{ count: 1 }] });

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.validateRestore('/tmp/test.db');

      expect(result.valid).toBe(true);
      expect(result.appMigrationCount).toBe(2);
      expect(result.backupMigrationCount).toBe(1);
    });

    it('returns valid=false for DB with more migrations than app', async () => {
      // getAppMigrationCount runs first; sqlite_master and the backup migration count follow.
      mockExecute.mockResolvedValueOnce({ rows: [{ count: 1 }] });
      mockExecute.mockResolvedValueOnce({ rows: [{ count: 1 }] });
      mockExecute.mockResolvedValueOnce({ rows: [{ count: 99 }] });

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.validateRestore('/tmp/test.db');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('newer version');
    });

    it('detects missing migrations table via structured sqlite_master query (not message.includes)', async () => {
      // First call gets the app migration count; second checks sqlite_master on the backup DB.
      mockExecute.mockResolvedValueOnce({ rows: [{ count: 1 }] });
      mockExecute.mockResolvedValueOnce({ rows: [{ count: 0 }] });

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.validateRestore('/tmp/test.db');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing migrations table');
      expect(mockExecute).toHaveBeenCalledWith(
        expect.stringContaining('sqlite_master'),
      );
    });

    it('returns valid=false for DB without __drizzle_migrations table', async () => {
      // First call gets the app migration count; second checks sqlite_master on the backup DB.
      mockExecute.mockResolvedValueOnce({ rows: [{ count: 1 }] });
      mockExecute.mockResolvedValueOnce({ rows: [{ count: 0 }] });

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.validateRestore('/tmp/test.db');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing migrations table');
    });

    it('returns valid=false for invalid database file', async () => {
      // First call gets the app migration count; second checks sqlite_master on the backup DB.
      mockExecute.mockResolvedValueOnce({ rows: [{ count: 1 }] });
      mockExecute.mockRejectedValueOnce(new Error('file is not a database'));

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.validateRestore('/tmp/test.db');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid database file');
    });
  });

  describe('confirmRestore (staging)', () => {
    it('rejects with error when no pendingRestore exists', async () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      await expect(service.confirmRestore()).rejects.toThrow('No pending restore');
    });

    it('rejects with error when pendingRestore is expired', async () => {
      // Same clock-freeze as the expiry-cleanup case below: the TTL branch must be chosen by the
      // test, not the host clock. Date only, so the real fs work here is unaffected.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
      try {
        const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

        const extractDir = path.join(tempDir, 'restore-expired');
        await fs.mkdir(extractDir, { recursive: true });
        const tempPath = path.join(extractDir, 'restore.db');
        await fs.writeFile(tempPath, 'test');
        await service.setPendingRestore(tempPath);

        // One minute past the 5-minute TTL, measured against the frozen instant.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (service as any)._pendingRestore.validatedAt = Date.now() - 6 * 60 * 1000;

        await expect(service.confirmRestore()).rejects.toThrow('expired');
      } finally {
        vi.useRealTimers();
      }
    });

    it('copies validated temp DB to restore-pending.db on confirm', async () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

      const extractDir = path.join(tempDir, 'narratorr-restore-test');
      await fs.mkdir(extractDir, { recursive: true });
      const tempPath = path.join(extractDir, 'narratorr-restore.db');
      await fs.writeFile(tempPath, 'restored-db-content');
      await service.setPendingRestore(tempPath);

      await service.confirmRestore();

      const pendingPath = path.join(configPath, 'restore-pending.db');
      const content = await fs.readFile(pendingPath, 'utf-8');
      expect(content).toBe('restored-db-content');

      await expect(fs.access(extractDir)).rejects.toThrow();
    });

    it('new upload replaces existing pendingRestore', async () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

      const dir1 = path.join(tempDir, 'restore-1');
      const dir2 = path.join(tempDir, 'restore-2');
      await fs.mkdir(dir1, { recursive: true });
      await fs.mkdir(dir2, { recursive: true });
      const tempPath1 = path.join(dir1, 'restore.db');
      const tempPath2 = path.join(dir2, 'restore.db');
      await fs.writeFile(tempPath1, 'old');
      await fs.writeFile(tempPath2, 'new');

      await service.setPendingRestore(tempPath1);
      await service.setPendingRestore(tempPath2);

      await expect(fs.access(tempPath1)).rejects.toThrow();

      expect(service.pendingRestore?.tempPath).toBe(tempPath2);
    });
  });
});

describe('processRestoreUpload', () => {
  let tempDir: string;
  let configPath: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'narratorr-upload-test-'));
    configPath = tempDir;
    dbPath = path.join(tempDir, 'narratorr.db');
    await fs.writeFile(dbPath, 'test-db-content');
    mockExecute.mockReset();
    mockClose.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns valid result and stages pending restore for valid zip', async () => {
    mockExecute.mockResolvedValue({ rows: [{ count: 1 }] });

    const zipBuffer = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.from('fake-sqlite-db') },
    ]);

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    const result = await service.processRestoreUpload(Readable.from(zipBuffer));

    expect(result.valid).toBe(true);
    expect(result.backupMigrationCount).toBe(1);
    expect(service.pendingRestore).not.toBeNull();
  });

  it('throws MISSING_DB when zip does not contain narratorr.db', async () => {
    const zipBuffer = await createZipBuffer([
      { name: 'other-file.txt', content: Buffer.from('not a db') },
    ]);

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    await expect(service.processRestoreUpload(Readable.from(zipBuffer)))
      .rejects.toThrow(RestoreUploadError);
    await expect(service.processRestoreUpload(Readable.from(await createZipBuffer([
      { name: 'other.txt', content: Buffer.from('x') },
    ]))))
      .rejects.toThrow('Zip does not contain narratorr.db');
  });

  it('returns { valid: false } when validateRestore rejects (no longer throws)', async () => {
    mockExecute.mockRejectedValue(new Error('no such table: __drizzle_migrations'));

    const zipBuffer = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.from('not-a-real-sqlite-db') },
    ]);

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    const result = await service.processRestoreUpload(Readable.from(zipBuffer));
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('throws INVALID_ZIP for non-zip input', async () => {
    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    await expect(service.processRestoreUpload(Readable.from(Buffer.from('this is not a zip'))))
      .rejects.toThrow('File is not a valid zip archive');
  });

  it('rethrows system-level I/O errors unchanged instead of wrapping as INVALID_ZIP', async () => {
    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    const zipBuffer = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.from('fake-sqlite-db') },
    ]);

    const ioError = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
    ioError.code = 'ENOSPC';
    vi.spyOn(service, 'validateRestore').mockRejectedValueOnce(ioError);

    const err = await service.processRestoreUpload(Readable.from(zipBuffer)).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RestoreUploadError);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOSPC');
  });

  it('cleans up temp directory on failure', async () => {
    const tmpBefore = (await fs.readdir(os.tmpdir())).filter(f => f.startsWith('narratorr-restore-'));

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

    try {
      await service.processRestoreUpload(Readable.from(Buffer.from('not a zip')));
    } catch { /* expected */ }

    const tmpAfter = (await fs.readdir(os.tmpdir())).filter(f => f.startsWith('narratorr-restore-'));
    expect(tmpAfter.length).toBe(tmpBefore.length);
  });

  it('rejects with OVERSIZED_DB when extracted narratorr.db exceeds the injected cap', async () => {
    const zipBuffer = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.alloc(2048, 0x61) },
    ]);

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog(), 1024);
    const err = await service.processRestoreUpload(Readable.from(zipBuffer)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RestoreUploadError);
    expect((err as RestoreUploadError).code).toBe('OVERSIZED_DB');
  });

  it('cleans up temp directory on OVERSIZED_DB overflow', async () => {
    const tmpBefore = (await fs.readdir(os.tmpdir())).filter(f => f.startsWith('narratorr-restore-'));

    const zipBuffer = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.alloc(2048, 0x61) },
    ]);

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog(), 1024);
    await service.processRestoreUpload(Readable.from(zipBuffer)).catch(() => {});

    const tmpAfter = (await fs.readdir(os.tmpdir())).filter(f => f.startsWith('narratorr-restore-'));
    expect(tmpAfter.length).toBe(tmpBefore.length);
  });

  it('settles the overflow path exactly once with no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const zipBuffer = await createZipBuffer([
        { name: 'narratorr.db', content: Buffer.alloc(4096, 0x61) },
      ]);

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog(), 1024);
      const err = await service.processRestoreUpload(Readable.from(zipBuffer)).catch((e: unknown) => e);
      expect((err as RestoreUploadError).code).toBe('OVERSIZED_DB');

      // Flush any post-teardown stream errors.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('accepts an entry exactly at the cap and rejects one byte over (strict greater-than)', async () => {
    mockExecute.mockResolvedValue({ rows: [{ count: 1 }] });
    const atCapZip = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.alloc(1024, 0x61) },
    ]);
    const atCapService = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog(), 1024);
    const atCapResult = await atCapService.processRestoreUpload(Readable.from(atCapZip));
    expect(atCapResult.valid).toBe(true);

    const overZip = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.alloc(1025, 0x61) },
    ]);
    const overService = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog(), 1024);
    const err = await overService.processRestoreUpload(Readable.from(overZip)).catch((e: unknown) => e);
    expect((err as RestoreUploadError).code).toBe('OVERSIZED_DB');
  });
});

describe('restoreServerBackup', () => {
  let tempDir: string;
  let configPath: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'narratorr-server-restore-test-'));
    configPath = tempDir;
    dbPath = path.join(tempDir, 'narratorr.db');
    await fs.writeFile(dbPath, 'test-db-content');
    mockExecute.mockReset();
    mockClose.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns valid result and stages pending restore for valid server backup zip', async () => {
    const backupsDir = path.join(configPath, 'backups');
    await fs.mkdir(backupsDir, { recursive: true });
    const zipBuffer = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.from('fake-sqlite-db') },
    ]);
    const backupFilename = 'narratorr-backup-20260101T000000000Z.zip';
    await fs.writeFile(path.join(backupsDir, backupFilename), zipBuffer);

    // execute order: app count, backup table check, backup count.
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 3 }] });
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 1 }] });
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 2 }] });

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    const result = await service.restoreServerBackup(backupFilename);

    expect(result.valid).toBe(true);
    expect(result.backupMigrationCount).toBe(2);
    expect(result.appMigrationCount).toBe(3);
    expect(service.pendingRestore).not.toBeNull();
  });

  it('throws MISSING_DB when server backup zip does not contain narratorr.db', async () => {
    const backupsDir = path.join(configPath, 'backups');
    await fs.mkdir(backupsDir, { recursive: true });
    const zipBuffer = await createZipBuffer([
      { name: 'other-file.txt', content: Buffer.from('not a db') },
    ]);
    const backupFilename = 'narratorr-backup-20260101T000000000Z.zip';
    await fs.writeFile(path.join(backupsDir, backupFilename), zipBuffer);

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    await expect(service.restoreServerBackup(backupFilename))
      .rejects.toThrow('Zip does not contain narratorr.db');
    await expect(service.restoreServerBackup(backupFilename))
      .rejects.toThrow(RestoreUploadError);
  });

  it('returns { valid: false } when backup has more migrations than app (newer version)', async () => {
    const backupsDir = path.join(configPath, 'backups');
    await fs.mkdir(backupsDir, { recursive: true });
    const zipBuffer = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.from('fake-sqlite-db') },
    ]);
    const backupFilename = 'narratorr-backup-20260101T000000000Z.zip';
    await fs.writeFile(path.join(backupsDir, backupFilename), zipBuffer);

    // execute order: app count, backup table check, backup count.
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 2 }] });
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 1 }] });
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 5 }] });

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    const result = await service.restoreServerBackup(backupFilename);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('newer version');
  });

  it('cleans up temp directory when extraction or validation fails', async () => {
    const backupsDir = path.join(configPath, 'backups');
    await fs.mkdir(backupsDir, { recursive: true });
    const zipBuffer = await createZipBuffer([
      { name: 'other.txt', content: Buffer.from('x') },
    ]);
    const backupFilename = 'narratorr-backup-20260101T000000000Z.zip';
    await fs.writeFile(path.join(backupsDir, backupFilename), zipBuffer);

    const tmpBefore = (await fs.readdir(os.tmpdir())).filter(f => f.startsWith('narratorr-restore-'));

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    try {
      await service.restoreServerBackup(backupFilename);
    } catch { /* expected */ }

    const tmpAfter = (await fs.readdir(os.tmpdir())).filter(f => f.startsWith('narratorr-restore-'));
    expect(tmpAfter.length).toBe(tmpBefore.length);
  });

  it('rethrows system-level I/O errors unchanged instead of wrapping as INVALID_ZIP', async () => {
    const backupsDir = path.join(configPath, 'backups');
    await fs.mkdir(backupsDir, { recursive: true });
    const zipBuffer = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.from('fake-sqlite-db') },
    ]);
    const backupFilename = 'narratorr-backup-20260101T000000000Z.zip';
    await fs.writeFile(path.join(backupsDir, backupFilename), zipBuffer);

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

    const ioError = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
    ioError.code = 'ENOSPC';
    vi.spyOn(service, 'validateRestore').mockRejectedValueOnce(ioError);

    const err = await service.restoreServerBackup(backupFilename).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RestoreUploadError);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOSPC');
  });

  it('replaces existing pending restore when called with a new backup', async () => {
    const backupsDir = path.join(configPath, 'backups');
    await fs.mkdir(backupsDir, { recursive: true });

    const zipBuffer1 = await createZipBuffer([{ name: 'narratorr.db', content: Buffer.from('db-v1') }]);
    const zipBuffer2 = await createZipBuffer([{ name: 'narratorr.db', content: Buffer.from('db-v2') }]);
    await fs.writeFile(path.join(backupsDir, 'narratorr-backup-20260101T000000000Z.zip'), zipBuffer1);
    await fs.writeFile(path.join(backupsDir, 'narratorr-backup-20260102T000000000Z.zip'), zipBuffer2);

    // Mock for each call: app migration count, sqlite_master table check, backup migration count.
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 3 }] });
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 1 }] });
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 2 }] });

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    await service.restoreServerBackup('narratorr-backup-20260101T000000000Z.zip');
    const firstPending = service.pendingRestore?.tempPath;

    mockExecute.mockResolvedValueOnce({ rows: [{ count: 3 }] });
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 1 }] });
    mockExecute.mockResolvedValueOnce({ rows: [{ count: 2 }] });

    await service.restoreServerBackup('narratorr-backup-20260102T000000000Z.zip');
    expect(service.pendingRestore?.tempPath).not.toBe(firstPending);
  });

  it('throws INVALID_ZIP for a corrupt non-zip backup file on disk', async () => {
    const backupsDir = path.join(configPath, 'backups');
    await fs.mkdir(backupsDir, { recursive: true });
    const backupFilename = 'narratorr-backup-20260101T000000000Z.zip';
    await fs.writeFile(path.join(backupsDir, backupFilename), 'this is not a zip file');

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    const err = await service.restoreServerBackup(backupFilename).catch((e: unknown) => e) as RestoreUploadError;
    expect(err).toBeInstanceOf(RestoreUploadError);
    expect(err.code).toBe('INVALID_ZIP');
    expect(err.message).toBe('File is not a valid zip archive');
  });

  it('rejects invalid filenames before touching the filesystem', async () => {
    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    const err = await service.restoreServerBackup('../etc/passwd').catch((e: unknown) => e) as RestoreUploadError;
    expect(err).toBeInstanceOf(RestoreUploadError);
    expect(err.code).toBe('INVALID_ZIP');
    expect(err.message).toBe('Invalid backup filename');
  });
});

describe('applyPendingRestore (startup swap)', () => {
  let tempDir: string;
  let configPath: string;
  let dbPath: string;
  let mockLog: { info: ReturnType<typeof vi.fn<(msg: string) => void>>; warn: ReturnType<typeof vi.fn<(msg: string) => void>> };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'narratorr-swap-test-'));
    configPath = tempDir;
    dbPath = path.join(tempDir, 'narratorr.db');
    mockLog = { info: vi.fn(), warn: vi.fn() };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('renames restore-pending.db to dbPath when it exists', async () => {
    const pendingPath = path.join(configPath, 'restore-pending.db');
    await fs.writeFile(pendingPath, 'restored-data');
    await fs.writeFile(dbPath, 'old-data');

    applyPendingRestore(configPath, dbPath, mockLog);

    const content = fss.readFileSync(dbPath, 'utf-8');
    expect(content).toBe('restored-data');
    expect(fss.existsSync(pendingPath)).toBe(false);
    expect(mockLog.info).toHaveBeenCalledWith('Restored database from pending backup');
  });

  it('no-op when restore-pending.db does not exist', () => {
    applyPendingRestore(configPath, dbPath, mockLog);

    expect(mockLog.info).not.toHaveBeenCalled();
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('falls back to copyFileSync + unlinkSync when renameSync throws', async () => {
    const pendingPath = path.join(configPath, 'restore-pending.db');
    await fs.writeFile(pendingPath, 'restored-data');
    await fs.writeFile(dbPath, 'old-data');

    const renameSpy = vi.spyOn(fss, 'renameSync').mockImplementation(() => {
      throw new Error('EXDEV: cross-device link not permitted');
    });

    applyPendingRestore(configPath, dbPath, mockLog);

    const content = fss.readFileSync(dbPath, 'utf-8');
    expect(content).toBe('restored-data');
    expect(fss.existsSync(pendingPath)).toBe(false);
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Restored database from pending backup (copy fallback — rename failed)',
    );

    renameSpy.mockRestore();
  });

  it('logs warning when both renameSync and copyFileSync fail', async () => {
    const pendingPath = path.join(configPath, 'restore-pending.db');
    await fs.writeFile(pendingPath, 'restored-data');
    await fs.writeFile(dbPath, 'old-data');

    const renameSpy = vi.spyOn(fss, 'renameSync').mockImplementation(() => {
      throw new Error('EXDEV: cross-device link not permitted');
    });
    const copySpy = vi.spyOn(fss, 'copyFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    applyPendingRestore(configPath, dbPath, mockLog);

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to apply pending restore'),
    );
    const content = fss.readFileSync(dbPath, 'utf-8');
    expect(content).toBe('old-data');

    renameSpy.mockRestore();
    copySpy.mockRestore();
  });

  it('restore-pending.db no longer exists on disk after swap', async () => {
    const pendingPath = path.join(configPath, 'restore-pending.db');
    await fs.writeFile(pendingPath, 'restored-data');

    applyPendingRestore(configPath, dbPath, mockLog);

    expect(fss.existsSync(pendingPath)).toBe(false);
  });
});

describe('#324 — restore contract change', () => {
  let tempDir: string;
  let configPath: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'narratorr-324-'));
    configPath = tempDir;
    dbPath = path.join(tempDir, 'narratorr.db');
    await fs.writeFile(dbPath, 'test-db-content');
    mockExecute.mockReset();
    mockClose.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('processRestoreUpload returns { valid: false, error } for newer-version backup', async () => {
    // execute order: app count, backup table check, backup count.
    mockExecute
      .mockResolvedValueOnce({ rows: [{ count: 5 }] })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ count: 99 }] });

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    const result = await service.processRestoreUpload(Readable.from(await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.from('fake-db') },
    ])));

    expect(result.valid).toBe(false);
    expect(result.error).toContain('newer version');
    expect(result.backupMigrationCount).toBe(99);
    expect(result.appMigrationCount).toBe(5);
  });

  it('processRestoreUpload still throws RestoreUploadError for corrupt zip', async () => {
    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    await expect(service.processRestoreUpload(Readable.from(Buffer.from('not a zip'))))
      .rejects.toThrow(RestoreUploadError);
  });

  it('restoreServerBackup returns { valid: false, error } for newer-version backup', async () => {
    const backupsDir = path.join(configPath, 'backups');
    await fs.mkdir(backupsDir, { recursive: true });
    const zipBuffer = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.from('fake-db') },
    ]);
    const backupFilename = 'narratorr-backup-20260101T000000000Z.zip';
    await fs.writeFile(path.join(backupsDir, backupFilename), zipBuffer);

    // Simulate newer-version: restoreServerBackup queries the backup count before the app count.
    mockExecute
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ count: 99 }] })
      .mockResolvedValueOnce({ rows: [{ count: 5 }] });

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    const result = await service.restoreServerBackup(backupFilename);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('newer version');
  });
});

describe('restore temp-dir cleanup: warn instead of swallow (#2370 AC9)', () => {
  let tempDir: string;
  let configPath: string;
  let dbPath: string;

  const ebusy = () => Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });

  /** Every removal in these flows is a restore temp dir, so failing them all is failing exactly those. */
  function failEveryCleanup() {
    vi.mocked(removeTree).mockRejectedValue(ebusy());
  }

  /** Mock calls at one level, through the `as never` log type this suite already uses. */
  function logCalls(log: ReturnType<typeof createMockLog>, level: 'warn' | 'info'): unknown[][] {
    return (log as unknown as Record<string, { mock: { calls: unknown[][] } }>)[level]!.mock.calls;
  }

  /** Just the warns this conversion emits. */
  function cleanupWarns(log: ReturnType<typeof createMockLog>) {
    return logCalls(log, 'warn').filter(([, message]) => message === 'Failed to remove restore temp directory');
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'narratorr-cleanup-warn-'));
    configPath = tempDir;
    dbPath = path.join(tempDir, 'narratorr.db');
    await fs.writeFile(dbPath, 'test-db-content');
    mockExecute.mockReset();
    mockClose.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('extractDbFromZip warns once and still rethrows the original error', async () => {
    failEveryCleanup();
    const log = createMockLog();
    const service = new BackupService(configPath, dbPath, createMockSettingsService(), log);
    const zipBuffer = await createZipBuffer([{ name: 'other.txt', content: Buffer.from('no db') }]);

    await expect(service.processRestoreUpload(Readable.from(zipBuffer)))
      .rejects.toThrow(RestoreUploadError);

    expect(cleanupWarns(log)).toHaveLength(1);
  });

  it('validateAndStage warns once and still returns the invalid validation', async () => {
    failEveryCleanup();
    // No __drizzle_migrations table → invalid, which is the branch that cleans up.
    mockExecute.mockResolvedValue({ rows: [{ count: 0 }] });
    const log = createMockLog();
    const service = new BackupService(configPath, dbPath, createMockSettingsService(), log);
    const zipBuffer = await createZipBuffer([{ name: 'narratorr.db', content: Buffer.from('fake-db') }]);

    const result = await service.processRestoreUpload(Readable.from(zipBuffer));

    expect(result.valid).toBe(false);
    expect(service.pendingRestore).toBeNull();
    expect(cleanupWarns(log)).toHaveLength(1);
  });

  it('confirmRestore warns once on the expiry path and still throws "Pending restore has expired"', async () => {
    // Fixture and production both read Date.now(); fake ONLY Date so the TTL branch is chosen by
    // the test rather than the host clock, and real timers keep the fs work below unaffected.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    try {
      const log = createMockLog();
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), log);
      const extractDir = path.join(tempDir, 'restore-expired');
      await fs.mkdir(extractDir, { recursive: true });
      const tempPath = path.join(extractDir, 'restore.db');
      await fs.writeFile(tempPath, 'test');
      await service.setPendingRestore(tempPath);
      // One minute past the 5-minute TTL, measured against the frozen instant.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any)._pendingRestore.validatedAt = Date.now() - 6 * 60 * 1000;
      failEveryCleanup();

      await expect(service.confirmRestore()).rejects.toThrow('Pending restore has expired');

      expect(cleanupWarns(log)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirmRestore warns once on the success path and still completes', async () => {
    const log = createMockLog();
    const service = new BackupService(configPath, dbPath, createMockSettingsService(), log);
    const extractDir = path.join(tempDir, 'restore-ok');
    await fs.mkdir(extractDir, { recursive: true });
    const tempPath = path.join(extractDir, 'restore.db');
    await fs.writeFile(tempPath, 'restored-db-content');
    await service.setPendingRestore(tempPath);
    failEveryCleanup();

    await expect(service.confirmRestore()).resolves.toBeUndefined();

    expect(await fs.readFile(path.join(configPath, 'restore-pending.db'), 'utf-8')).toBe('restored-db-content');
    expect(logCalls(log, 'info').flat()).toContain('Restore staged to restore-pending.db — process will exit');
    expect(cleanupWarns(log)).toHaveLength(1);
  });

  it('emits no warn when the removal succeeds', async () => {
    const log = createMockLog();
    const service = new BackupService(configPath, dbPath, createMockSettingsService(), log);
    const extractDir = path.join(tempDir, 'restore-clean');
    await fs.mkdir(extractDir, { recursive: true });
    const tempPath = path.join(extractDir, 'restore.db');
    await fs.writeFile(tempPath, 'restored-db-content');
    await service.setPendingRestore(tempPath);

    await service.confirmRestore();

    expect(removeTree).toHaveBeenCalledWith(extractDir);
    expect(cleanupWarns(log)).toHaveLength(0);
  });

  it('logs a SERIALIZED error, not the raw catch binding', async () => {
    failEveryCleanup();
    const log = createMockLog();
    const service = new BackupService(configPath, dbPath, createMockSettingsService(), log);
    const extractDir = path.join(tempDir, 'restore-serialized');
    await fs.mkdir(extractDir, { recursive: true });
    const tempPath = path.join(extractDir, 'restore.db');
    await fs.writeFile(tempPath, 'x');
    await service.setPendingRestore(tempPath);

    await service.confirmRestore();

    const [payload] = cleanupWarns(log)[0] as [Record<string, unknown>, string];
    const logged = payload.error as Record<string, unknown>;
    // `objectContaining({ message })` cannot tell a serialized error from a raw one: message and
    // stack are non-enumerable own properties that both matchers read straight through.
    expect(logged).not.toBeInstanceOf(Error);
    expect(logged.type).toBe('Error');
    expect(logged.code).toBe('EBUSY');
    expect(payload.tempDir).toBe(extractDir);
  });
});
