import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import archiver from 'archiver';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '../../db/index.js';
import { createTestApp, createMockServices, resetMockServices, inject } from '../__tests__/helpers.js';
import { DEFAULT_SETTINGS } from '../../shared/schemas/settings/registry.js';
import { registerRoutes, type Services } from './index.js';

vi.mock('../utils/version.js', () => ({
  getVersion: () => '0.1.0',
}));

vi.mock('../jobs/version-check.js', () => ({
  getUpdateStatus: vi.fn(),
  checkForUpdate: vi.fn(),
}));

import { getUpdateStatus } from '../jobs/version-check.js';

describe('system routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
  });

  describe('GET /api/system/status', () => {
    it('returns 200 with version, status, and valid ISO timestamp', async () => {
      vi.mocked(getUpdateStatus).mockReturnValue(undefined);
      const res = await app.inject({ method: 'GET', url: '/api/system/status' });

      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload.version).toBe('0.1.0');
      expect(payload.status).toBe('ok');
      expect(payload.timestamp).toBeDefined();

      // Verify timestamp is a valid ISO string
      const timestamp = new Date(payload.timestamp);
      expect(timestamp.toISOString()).toBe(payload.timestamp);
    });

    it('omits update field when no update available', async () => {
      vi.mocked(getUpdateStatus).mockReturnValue(undefined);
      const res = await app.inject({ method: 'GET', url: '/api/system/status' });

      const payload = JSON.parse(res.payload);
      expect(payload.update).toBeUndefined();
    });

    it('includes update field when newer version available and not dismissed', async () => {
      vi.mocked(getUpdateStatus).mockReturnValue({
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        dismissed: false,
      });
      (services.settings.get as Mock).mockResolvedValue(DEFAULT_SETTINGS.system);

      const res = await app.inject({ method: 'GET', url: '/api/system/status' });

      const payload = JSON.parse(res.payload);
      expect(payload.update).toEqual({
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        dismissed: false,
      });
      expect(getUpdateStatus).toHaveBeenCalledWith('');
    });

    it('includes update with dismissed: true when version dismissed', async () => {
      vi.mocked(getUpdateStatus).mockReturnValue({
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        dismissed: true,
      });
      (services.settings.get as Mock).mockResolvedValue({
        ...DEFAULT_SETTINGS.system,
        dismissedUpdateVersion: '0.2.0',
      });

      const res = await app.inject({ method: 'GET', url: '/api/system/status' });

      const payload = JSON.parse(res.payload);
      expect(payload.update.dismissed).toBe(true);
      expect(getUpdateStatus).toHaveBeenCalledWith('0.2.0');
    });
  });

  describe('PUT /api/system/update/dismiss', () => {
    it('writes dismissedUpdateVersion to system settings via patch', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/system/update/dismiss',
        payload: { version: '0.2.0' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ ok: true });
      expect(services.settings.patch as Mock).toHaveBeenCalledWith('system', {
        dismissedUpdateVersion: '0.2.0',
      });
    });

    it('returns 400 when version is missing from body', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/system/update/dismiss',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/health', () => {
    it('returns 200 with status and valid ISO timestamp when DB probe succeeds', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });

      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload.status).toBe('ok');
      expect(payload.timestamp).toBeDefined();

      // Verify timestamp is a valid ISO string
      const timestamp = new Date(payload.timestamp);
      expect(timestamp.toISOString()).toBe(payload.timestamp);
    });

    it('returns 503 with error when DB probe fails', async () => {
      const failingDb = inject<Db>({ run: vi.fn().mockRejectedValue(new Error('SQLITE_CANTOPEN')) });
      const failServices = createMockServices();
      const failApp = await createTestApp(failServices, failingDb);

      const res = await failApp.inject({ method: 'GET', url: '/api/health' });

      expect(res.statusCode).toBe(503);

      const payload = JSON.parse(res.payload);
      expect(payload.status).toBe('error');
      expect(payload.error).toBe('SQLITE_CANTOPEN');
      expect(payload.timestamp).toBeDefined();
      const timestamp = new Date(payload.timestamp);
      expect(timestamp.toISOString()).toBe(payload.timestamp);

      await failApp.close();
    });
  });

  describe('POST /api/system/tasks/search', () => {
    it('returns 200 with search summary', async () => {
      (services.settings.get as Mock).mockResolvedValue(DEFAULT_SETTINGS.search);
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/search' });

      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload).toHaveProperty('searched');
      expect(payload).toHaveProperty('grabbed');
      expect(payload.searched).toBe(0);
      expect(payload.grabbed).toBe(0);
    });

    it('returns 500 when search job throws', async () => {
      (services.settings.get as Mock).mockRejectedValue(new Error('DB connection lost'));

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/search' });

      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /api/system/tasks/rss', () => {
    it('returns 200 with RSS sync summary', async () => {
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        return Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]);
      });

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/rss' });

      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload).toHaveProperty('polled');
      expect(payload).toHaveProperty('matched');
      expect(payload).toHaveProperty('grabbed');
      expect(payload.polled).toBe(0);
    });

    it('returns 500 when RSS job throws', async () => {
      (services.settings.get as Mock).mockRejectedValue(new Error('DB connection lost'));

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/rss' });

      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /api/system/tasks/search-all-wanted', () => {
    it('returns 200 with { searched, grabbed, skipped, errors } summary', async () => {
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        return Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]);
      });
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/search-all-wanted' });

      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload).toHaveProperty('searched');
      expect(payload).toHaveProperty('grabbed');
      expect(payload).toHaveProperty('skipped');
      expect(payload).toHaveProperty('errors');
    });

    it('returns zeros when no wanted books exist', async () => {
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        return Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]);
      });
      (services.bookList.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/search-all-wanted' });

      expect(res.statusCode).toBe(200);
      const payload = JSON.parse(res.payload);
      expect(payload).toEqual({ searched: 0, grabbed: 0, skipped: 0, errors: 0 });
    });

    it('returns 500 when search-all-wanted throws', async () => {
      (services.settings.get as Mock).mockRejectedValue(new Error('DB connection lost'));

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/search-all-wanted' });

      expect(res.statusCode).toBe(500);
    });
  });

  describe('GET /api/system/backups', () => {
    it('returns backup list (200)', async () => {
      const backups = [{ filename: 'narratorr-backup-20260101T000000000Z.zip', timestamp: '2026-01-01T00:00:00Z', size: 1024 }];
      (services.backup.list as Mock).mockResolvedValue(backups);

      const res = await app.inject({ method: 'GET', url: '/api/system/backups' });
      expect(res.statusCode).toBe(200);
      const payload = JSON.parse(res.payload);
      expect(payload).toHaveLength(1);
      expect(payload[0].filename).toBe('narratorr-backup-20260101T000000000Z.zip');
    });

    it('returns empty array when no backups (200)', async () => {
      (services.backup.list as Mock).mockResolvedValue([]);

      const res = await app.inject({ method: 'GET', url: '/api/system/backups' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  describe('POST /api/system/backups/create', () => {
    it('triggers manual backup and returns result', async () => {
      (services.backup.create as Mock).mockResolvedValue({ filename: 'test.zip', timestamp: new Date().toISOString(), size: 1024 });
      (services.backup.prune as Mock).mockResolvedValue(0);

      const res = await app.inject({ method: 'POST', url: '/api/system/backups/create' });
      expect(res.statusCode).toBe(200);
      const payload = JSON.parse(res.payload);
      expect(payload.created).toBe(true);
    });
  });

  describe('GET /api/system/backups/:filename/download', () => {
    it('rejects path-traversal attempts with 400', async () => {
      (services.backup.getBackupPath as Mock).mockReturnValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/system/backups/..%2F..%2Fetc%2Fpasswd/download' });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when backup file does not exist on disk', async () => {
      (services.backup.getBackupPath as Mock).mockReturnValue('/nonexistent/path/backup.zip');

      const res = await app.inject({
        method: 'GET',
        url: '/api/system/backups/narratorr-backup-test.zip/download',
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error).toBe('Backup not found');
    });

    it('sanitizes filename with quotes in Content-Disposition header', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'narratorr-test-'));
      const tempFile = path.join(tempDir, 'test.zip');
      await fsp.writeFile(tempFile, 'fake');

      (services.backup.getBackupPath as Mock).mockReturnValue(tempFile);

      const res = await app.inject({ method: 'GET', url: '/api/system/backups/file"name.zip/download' });
      expect(res.statusCode).toBe(200);
      const disposition = String(res.headers['content-disposition']);
      expect(disposition).not.toContain('"name');
      expect(disposition).toMatch(/filename="[a-zA-Z0-9._-]+"/);

      await fsp.rm(tempDir, { recursive: true }).catch(() => {});
    });

    it('sanitizes filename with path separators in Content-Disposition header', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'narratorr-test-'));
      const tempFile = path.join(tempDir, 'test.zip');
      await fsp.writeFile(tempFile, 'fake');

      // Even if getBackupPath somehow accepts a filename with separators,
      // the Content-Disposition header must not contain them
      (services.backup.getBackupPath as Mock).mockReturnValue(tempFile);

      const res = await app.inject({ method: 'GET', url: '/api/system/backups/path%5Cfile.zip/download' });
      expect(res.statusCode).toBe(200);
      const disposition = String(res.headers['content-disposition']);
      expect(disposition).not.toContain('\\');
      expect(disposition).toMatch(/filename="[a-zA-Z0-9._-]+"/);

      await fsp.rm(tempDir, { recursive: true }).catch(() => {});
    });

    it('sanitizes filename with spaces in Content-Disposition header', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'narratorr-test-'));
      const tempFile = path.join(tempDir, 'test.zip');
      await fsp.writeFile(tempFile, 'fake');

      (services.backup.getBackupPath as Mock).mockReturnValue(tempFile);

      const res = await app.inject({ method: 'GET', url: '/api/system/backups/file%20name.zip/download' });
      expect(res.statusCode).toBe(200);
      const disposition = String(res.headers['content-disposition']);
      expect(disposition).not.toContain(' name');
      expect(disposition).toMatch(/filename="[a-zA-Z0-9._-]+"/);

      await fsp.rm(tempDir, { recursive: true }).catch(() => {});
    });

    it('sanitizes filename with null bytes in Content-Disposition header', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'narratorr-test-'));
      const tempFile = path.join(tempDir, 'test.zip');
      await fsp.writeFile(tempFile, 'fake');

      (services.backup.getBackupPath as Mock).mockReturnValue(tempFile);

      const res = await app.inject({ method: 'GET', url: '/api/system/backups/file%00name.zip/download' });
      expect(res.statusCode).toBe(200);
      const disposition = String(res.headers['content-disposition']);
      expect(disposition).not.toContain('\0');
      expect(disposition).toMatch(/filename="[a-zA-Z0-9._-]+"/);

      await fsp.rm(tempDir, { recursive: true }).catch(() => {});
    });

    it('clean filename passes through unchanged', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'narratorr-test-'));
      const tempFile = path.join(tempDir, 'narratorr-backup-20260101T000000Z.zip');
      await fsp.writeFile(tempFile, 'fake');

      (services.backup.getBackupPath as Mock).mockReturnValue(tempFile);

      const res = await app.inject({ method: 'GET', url: '/api/system/backups/narratorr-backup-20260101T000000Z.zip/download' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="narratorr-backup-20260101T000000Z.zip"');

      await fsp.rm(tempDir, { recursive: true }).catch(() => {});
    });

    it('streams zip file for valid existing backup (200)', async () => {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'narratorr-test-'));
      const tempFile = path.join(tempDir, 'narratorr-backup-test.zip');
      await fsp.writeFile(tempFile, 'fake-zip-content');

      (services.backup.getBackupPath as Mock).mockReturnValue(tempFile);

      const res = await app.inject({
        method: 'GET',
        url: '/api/system/backups/narratorr-backup-test.zip/download',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toContain('narratorr-backup-test.zip');

      await fsp.rm(tempDir, { recursive: true }).catch(() => {});
    });
  });

  describe('POST /api/system/restore/confirm', () => {
    it('returns 400 if no validated restore pending', async () => {
      (services.backup.confirmRestore as Mock).mockRejectedValue(new Error('No pending restore'));

      const res = await app.inject({ method: 'POST', url: '/api/system/restore/confirm' });
      expect(res.statusCode).toBe(400);
      const payload = JSON.parse(res.payload);
      expect(payload.error).toBe('No pending restore');
    });

    it('returns 200 and schedules process exit on success', async () => {
      (services.backup.confirmRestore as Mock).mockResolvedValue(undefined);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      const res = await app.inject({ method: 'POST', url: '/api/system/restore/confirm' });

      expect(res.statusCode).toBe(200);
      const payload = JSON.parse(res.payload);
      expect(payload.message).toContain('Restore confirmed');

      // Let setImmediate fire
      await new Promise(r => setImmediate(r));
      expect(exitSpy).toHaveBeenCalledWith(0);

      exitSpy.mockRestore();
    });
  });
});

// ── POST /api/system/restore (multipart upload) ────────────────────────────
// Separate top-level describe because the base createTestApp does NOT register
// @fastify/multipart, and it must be registered BEFORE routes.

/** Create a zip Buffer using archiver. Resolves when the archive is finalized. */
function createZipBuffer(entries: { name: string; content: Buffer }[]): Promise<Buffer> {
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

/** Build a raw multipart/form-data payload suitable for Fastify inject. */
function createMultipartPayload(filename: string, content: Buffer, boundary = 'boundary123') {
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n` +
    `\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([header, content, footer]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('POST /api/system/restore', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    const mockDb = inject<Db>({ run: vi.fn().mockResolvedValue(undefined) });

    // Build a Fastify app with multipart registered BEFORE routes
    const instance = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    await instance.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });
    await registerRoutes(instance, services, mockDb);
    await instance.ready();
    app = instance as typeof app;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
  });

  it('returns 200 with validation result for valid zip containing narratorr.db', async () => {
    (services.backup.processRestoreUpload as Mock).mockResolvedValue({
      valid: true,
      backupMigrationCount: 2,
      appMigrationCount: 3,
    });

    const zipBuffer = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.from('fake-sqlite-db') },
    ]);
    const { payload, contentType } = createMultipartPayload('backup.zip', zipBuffer);

    const res = await app.inject({
      method: 'POST',
      url: '/api/system/restore',
      payload,
      headers: { 'content-type': contentType },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toEqual({ valid: true, backupMigrationCount: 2, appMigrationCount: 3 });
    expect(services.backup.processRestoreUpload as Mock).toHaveBeenCalled();
  });

  it('returns 400 when no file is uploaded', async () => {
    // Send multipart with an empty text field instead of a file
    const boundary = 'boundary456';
    const raw = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="notfile"',
      '',
      'hello',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const res = await app.inject({
      method: 'POST',
      url: '/api/system/restore',
      payload: raw,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('No file uploaded');
  });

  it('returns 400 when processRestoreUpload throws RestoreUploadError', async () => {
    const { RestoreUploadError } = await import('../services/backup.service.js');
    (services.backup.processRestoreUpload as Mock).mockRejectedValue(
      new RestoreUploadError('Zip does not contain narratorr.db', 'MISSING_DB'),
    );

    const zipBuffer = await createZipBuffer([
      { name: 'some-other-file.txt', content: Buffer.from('not a db') },
    ]);
    const { payload, contentType } = createMultipartPayload('backup.zip', zipBuffer);

    const res = await app.inject({
      method: 'POST',
      url: '/api/system/restore',
      payload,
      headers: { 'content-type': contentType },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('Zip does not contain narratorr.db');
  });

  it('returns 400 when processRestoreUpload throws INVALID_DB', async () => {
    const { RestoreUploadError } = await import('../services/backup.service.js');
    (services.backup.processRestoreUpload as Mock).mockRejectedValue(
      new RestoreUploadError('too new', 'INVALID_DB'),
    );

    const zipBuffer = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.from('fake-sqlite-db') },
    ]);
    const { payload, contentType } = createMultipartPayload('backup.zip', zipBuffer);

    const res = await app.inject({
      method: 'POST',
      url: '/api/system/restore',
      payload,
      headers: { 'content-type': contentType },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('too new');
  });

  it('returns 400 for non-zip file (INVALID_ZIP)', async () => {
    const { RestoreUploadError } = await import('../services/backup.service.js');
    (services.backup.processRestoreUpload as Mock).mockRejectedValue(
      new RestoreUploadError('File is not a valid zip archive', 'INVALID_ZIP'),
    );

    const plainText = Buffer.from('this is not a zip file at all');
    const { payload, contentType } = createMultipartPayload('backup.zip', plainText);

    const res = await app.inject({
      method: 'POST',
      url: '/api/system/restore',
      payload,
      headers: { 'content-type': contentType },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toBe('File is not a valid zip archive');
  });

  it('returns 500 for unexpected errors from processRestoreUpload', async () => {
    (services.backup.processRestoreUpload as Mock).mockRejectedValue(new Error('disk full'));

    const zipBuffer = await createZipBuffer([
      { name: 'narratorr.db', content: Buffer.from('fake-sqlite-db') },
    ]);
    const { payload, contentType } = createMultipartPayload('backup.zip', zipBuffer);

    const res = await app.inject({
      method: 'POST',
      url: '/api/system/restore',
      payload,
      headers: { 'content-type': contentType },
    });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.payload).error).toBe('Failed to process restore file');
  });
});
