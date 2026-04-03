import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./client.js', () => ({
  URL_BASE: '',
  fetchApi: vi.fn(),
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
import { ApiError } from './client.js';

describe('backupsApi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
      const { fetchApi } = await import('./client.js');
      const mockFetchApi = vi.mocked(fetchApi);
      mockFetchApi.mockResolvedValue({ valid: true, backupMigrationCount: 2, appMigrationCount: 3 });

      await backupsApi.restoreBackupDirect('file with spaces.zip');

      expect(mockFetchApi).toHaveBeenCalledWith(
        '/system/backups/file%20with%20spaces.zip/restore',
        { method: 'POST' },
      );
    });

    it('encodes special characters in filename', async () => {
      const { fetchApi } = await import('./client.js');
      const mockFetchApi = vi.mocked(fetchApi);
      mockFetchApi.mockResolvedValue({ valid: true, backupMigrationCount: 1, appMigrationCount: 1 });

      await backupsApi.restoreBackupDirect('backup#1?v=2.zip');

      expect(mockFetchApi).toHaveBeenCalledWith(
        '/system/backups/backup%231%3Fv%3D2.zip/restore',
        { method: 'POST' },
      );
    });
  });

  describe('uploadRestore', () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
    });

    it('sends FormData with credentials', async () => {
      const validationResult = { valid: true, details: {} };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(validationResult),
      });

      const file = new File(['data'], 'backup.zip', { type: 'application/zip' });
      await backupsApi.uploadRestore(file);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/system/restore');
      expect(options.method).toBe('POST');
      expect(options.body).toBeInstanceOf(FormData);
      expect(options.credentials).toBe('include');
      expect(options.headers).toBeUndefined();
    });

    it('throws ApiError on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Bad file' }),
      });

      const file = new File(['bad'], 'bad.zip', { type: 'application/zip' });
      await expect(backupsApi.uploadRestore(file)).rejects.toThrow(ApiError);
      await expect(backupsApi.uploadRestore(file)).rejects.toMatchObject({
        status: 400,
        body: { error: 'Bad file' },
      });
    });

    it('returns parsed JSON on success', async () => {
      const validationResult = { valid: true, tables: ['books', 'authors'], rowCount: 42 };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(validationResult),
      });

      const file = new File(['data'], 'backup.zip', { type: 'application/zip' });
      const result = await backupsApi.uploadRestore(file);

      expect(result).toEqual(validationResult);
    });
  });
});
