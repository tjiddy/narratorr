import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./client.js', () => ({
  URL_BASE: '',
  fetchApi: vi.fn(),
  fetchMultipart: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      super((body as { error?: string })?.error || `HTTP ${status}`);
      this.status = status;
      this.body = body;
    }
  },
}));

import { backupsApi } from './backups.js';
import { ApiError, fetchApi, fetchMultipart } from './client.js';

describe('backupsApi', () => {
  beforeEach(() => {
    vi.mocked(fetchApi).mockReset();
    vi.mocked(fetchMultipart).mockReset();
  });

  describe('getBackupDownloadUrl', () => {
    it('encodes filename', () => {
      const url = backupsApi.getBackupDownloadUrl('file with spaces.zip');
      expect(url).toBe('/api/system/backups/file%20with%20spaces.zip/download');
    });

    it('handles special characters', () => {
      const url = backupsApi.getBackupDownloadUrl('backup#1?v=2&rev=3.zip');
      expect(url).toBe('/api/system/backups/backup%231%3Fv%3D2%26rev%3D3.zip/download');
    });
  });

  describe('restoreBackupDirect', () => {
    it('calls fetchApi with encoded filename and POST method', async () => {
      vi.mocked(fetchApi).mockResolvedValue({ valid: true, backupMigrationCount: 2, appMigrationCount: 3 });

      await backupsApi.restoreBackupDirect('file with spaces.zip');

      expect(fetchApi).toHaveBeenCalledWith(
        '/system/backups/file%20with%20spaces.zip/restore',
        { method: 'POST' },
      );
    });

    it('encodes special characters in filename', async () => {
      vi.mocked(fetchApi).mockResolvedValue({ valid: true, backupMigrationCount: 1, appMigrationCount: 1 });

      await backupsApi.restoreBackupDirect('backup#1?v=2.zip');

      expect(fetchApi).toHaveBeenCalledWith(
        '/system/backups/backup%231%3Fv%3D2.zip/restore',
        { method: 'POST' },
      );
    });
  });

  describe('uploadRestore', () => {
    it('calls fetchMultipart with /system/restore and FormData payload', async () => {
      const validationResult = { valid: true, details: {} };
      vi.mocked(fetchMultipart).mockResolvedValue(validationResult);

      const file = new File(['data'], 'backup.zip', { type: 'application/zip' });
      await backupsApi.uploadRestore(file);

      expect(fetchMultipart).toHaveBeenCalledOnce();
      const [path, body] = vi.mocked(fetchMultipart).mock.calls[0]!;
      expect(path).toBe('/system/restore');
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get('file')).toBe(file);
    });

    it('throws ApiError when fetchMultipart rejects', async () => {
      vi.mocked(fetchMultipart).mockRejectedValue(new ApiError(400, { error: 'Bad file' }));

      const file = new File(['bad'], 'bad.zip', { type: 'application/zip' });
      await expect(backupsApi.uploadRestore(file)).rejects.toThrow(ApiError);
      await expect(backupsApi.uploadRestore(file)).rejects.toMatchObject({
        status: 400,
        body: { error: 'Bad file' },
      });
    });

    it('returns parsed JSON on success', async () => {
      const validationResult = { valid: true, tables: ['books', 'authors'], rowCount: 42 };
      vi.mocked(fetchMultipart).mockResolvedValue(validationResult);

      const file = new File(['data'], 'backup.zip', { type: 'application/zip' });
      const result = await backupsApi.uploadRestore(file);

      expect(result).toBe(validationResult);
    });
  });
});
