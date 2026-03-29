import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import fss from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import { EventEmitter } from 'events';
import { BackupService, RestoreUploadError, applyPendingRestore } from './backup.service.js';
import { createMockSettingsService } from '../__tests__/helpers.js';

// Mock archiver — finalize() triggers 'close' on the piped output stream
vi.mock('archiver', () => ({
  default: vi.fn(() => {
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

// Mock libSQL client
const mockExecute = vi.fn();
const mockClose = vi.fn();
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

      // Create two backup files with different mtimes
      const file1 = 'narratorr-backup-20260101T000000000Z.zip';
      const file2 = 'narratorr-backup-20260102T000000000Z.zip';
      await fs.writeFile(path.join(backupsDir, file1), 'data1');
      // Small delay to ensure different mtime
      await new Promise(r => setTimeout(r, 50));
      await fs.writeFile(path.join(backupsDir, file2), 'data2');

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.list();

      expect(result).toHaveLength(2);
      // Most recent first
      expect(result[0].filename).toBe(file2);
      expect(result[1].filename).toBe(file1);
    });

    it('excludes backups with size=0 from list', async () => {
      const backupsDir = path.join(configPath, 'backups');
      await fs.mkdir(backupsDir, { recursive: true });

      await fs.writeFile(path.join(backupsDir, 'narratorr-backup-20260101T000000000Z.zip'), '');
      await fs.writeFile(path.join(backupsDir, 'narratorr-backup-20260102T000000000Z.zip'), 'data');

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.list();

      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe('narratorr-backup-20260102T000000000Z.zip');
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

      // Mock mkdir so tests don't depend on filesystem permissions
      mkdirSpy = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);

      // Mock createWriteStream to return an EventEmitter (archiver mock triggers 'close' on it)
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

      // The VACUUM INTO SQL should have the single quote doubled
      const sqlArg = mockExecute.mock.calls[0][0] as string;
      expect(sqlArg).toContain("it''s-a-path");
      expect(sqlArg).not.toMatch(/it's-a-path/);

      statSpy.mockRestore();
    });

    it('VACUUM INTO path is built from controlled inputs only (configPath + timestamp)', async () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

      const statSpy = vi.spyOn(fs, 'stat').mockResolvedValue({ size: 100 } as unknown as Awaited<ReturnType<typeof fs.stat>>);

      await service.create();

      const sqlArg = mockExecute.mock.calls[0][0] as string;
      // Path should start with configPath and contain backup-temp- prefix
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

      // The temp db file should be cleaned up (first unlink call is the temp db)
      expect(unlinkSpy).toHaveBeenCalledWith(expect.stringContaining('backup-temp-'));

      statSpy.mockRestore();
      unlinkSpy.mockRestore();
    });

    it('cleans up on failure', async () => {
      mockExecute.mockRejectedValue(new Error('VACUUM failed'));

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const unlinkSpy = vi.spyOn(fs, 'unlink').mockResolvedValue();

      await expect(service.create()).rejects.toThrow('VACUUM failed');

      // Should attempt to clean up both temp db and zip file
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

      // Second call should not throw "already in progress"
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

  describe('validateRestore', () => {
    it('returns valid=true for DB with same migration count as app', async () => {
      mockExecute.mockResolvedValue({ rows: [{ count: 1 }] });

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.validateRestore('/tmp/test.db');

      expect(result.valid).toBe(true);
      expect(result.backupMigrationCount).toBe(1);
      expect(mockClose).toHaveBeenCalled();
    });

    it('returns valid=true for DB with fewer migrations than app', async () => {
      mockExecute.mockResolvedValue({ rows: [{ count: 1 }] });

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.validateRestore('/tmp/test.db');

      expect(result.valid).toBe(true);
    });

    it('returns valid=false for DB with more migrations than app', async () => {
      mockExecute.mockResolvedValue({ rows: [{ count: 99 }] });

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.validateRestore('/tmp/test.db');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('newer version');
    });

    // #197 — structured table-existence check replaces string matching (ERR-1)
    it.todo('detects missing migrations table via structured query (not message.includes)');

    it('returns valid=false for DB without __drizzle_migrations table', async () => {
      mockExecute.mockRejectedValue(new Error('no such table: __drizzle_migrations'));

      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
      const result = await service.validateRestore('/tmp/test.db');

      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing migrations table');
    });

    it('returns valid=false for invalid database file', async () => {
      mockExecute.mockRejectedValue(new Error('file is not a database'));

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
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

      // Create a temp file in a subdirectory (matching real extraction pattern)
      const extractDir = path.join(tempDir, 'restore-expired');
      await fs.mkdir(extractDir, { recursive: true });
      const tempPath = path.join(extractDir, 'restore.db');
      await fs.writeFile(tempPath, 'test');
      await service.setPendingRestore(tempPath);

      // Manually expire the pending restore by manipulating internal state
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any)._pendingRestore.validatedAt = Date.now() - 6 * 60 * 1000;

      await expect(service.confirmRestore()).rejects.toThrow('expired');
    });

    it('copies validated temp DB to restore-pending.db on confirm', async () => {
      const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

      // Simulate real extraction pattern: file inside a subdirectory
      const extractDir = path.join(tempDir, 'narratorr-restore-test');
      await fs.mkdir(extractDir, { recursive: true });
      const tempPath = path.join(extractDir, 'narratorr-restore.db');
      await fs.writeFile(tempPath, 'restored-db-content');
      await service.setPendingRestore(tempPath);

      await service.confirmRestore();

      const pendingPath = path.join(configPath, 'restore-pending.db');
      const content = await fs.readFile(pendingPath, 'utf-8');
      expect(content).toBe('restored-db-content');

      // Extraction directory should be cleaned up
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

      // Old temp file should be cleaned up
      await expect(fs.access(tempPath1)).rejects.toThrow();

      // Pending should point to new file
      expect(service.pendingRestore?.tempPath).toBe(tempPath2);
    });
  });
});

describe('processRestoreUpload', () => {
  let tempDir: string;
  let configPath: string;
  let dbPath: string;

  // Get the real archiver (unmocked) for creating test zip data
  async function createZipBuffer(entries: { name: string; content: Buffer }[]): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const archiverModule = await vi.importActual<any>('archiver');
    const archiver = archiverModule.default;
    return new Promise((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 0 } });
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
    // validateRestore will call execute to get migration count
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

  it('throws INVALID_DB when validateRestore rejects', async () => {
    // Make validateRestore fail by making the "DB" fail migration query
    mockExecute.mockRejectedValue(new Error('no such table: __drizzle_migrations'));

    const zipBuffer = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.from('not-a-real-sqlite-db') },
    ]);

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    await expect(service.processRestoreUpload(Readable.from(zipBuffer)))
      .rejects.toThrow(RestoreUploadError);
  });

  it('throws INVALID_ZIP for non-zip input', async () => {
    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());
    await expect(service.processRestoreUpload(Readable.from(Buffer.from('this is not a zip'))))
      .rejects.toThrow('File is not a valid zip archive');
  });

  it('cleans up temp directory on failure', async () => {
    // Track temp dirs before test
    const tmpBefore = (await fs.readdir(os.tmpdir())).filter(f => f.startsWith('narratorr-restore-'));

    const service = new BackupService(configPath, dbPath, createMockSettingsService(), createMockLog());

    // Use non-zip data to trigger INVALID_ZIP
    try {
      await service.processRestoreUpload(Readable.from(Buffer.from('not a zip')));
    } catch { /* expected */ }

    // No new temp dirs should remain after cleanup
    const tmpAfter = (await fs.readdir(os.tmpdir())).filter(f => f.startsWith('narratorr-restore-'));
    expect(tmpAfter.length).toBe(tmpBefore.length);
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

  it('restore-pending.db no longer exists on disk after swap', async () => {
    const pendingPath = path.join(configPath, 'restore-pending.db');
    await fs.writeFile(pendingPath, 'restored-data');

    applyPendingRestore(configPath, dbPath, mockLog);

    expect(fss.existsSync(pendingPath)).toBe(false);
  });
});
