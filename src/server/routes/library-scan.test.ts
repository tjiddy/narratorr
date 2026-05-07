import { describe, it, expect, type vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { ScanInProgressError, LibraryPathError } from '../services/library-scan.service.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';
import { verifyPreviewToken } from '../services/preview-token.js';

describe('library-scan routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    _resetKey();
    initializeKey(Buffer.alloc(32, 0xee));
    services = createMockServices();
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
    _resetKey();
  });

  beforeEach(() => {
    resetMockServices(services);
  });

  describe('POST /api/library/import/scan', () => {
    it('returns scan results', async () => {
      const mockResult = {
        discoveries: [
          {
            path: '/audiobooks/Author/Title',
            parsedTitle: 'Title',
            parsedAuthor: 'Author',
            parsedSeries: null,
            fileCount: 5,
            totalSize: 500000,
            isDuplicate: false,
          },
        ],
        totalFolders: 2,
      };

      (services.libraryScan.scanDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValue(mockResult);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/scan',
        payload: { path: '/audiobooks' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.discoveries).toHaveLength(1);
      expect(body.discoveries[0].parsedTitle).toBe('Title');
      expect(body.totalFolders).toBe(2);
    });

    // #1017 — scan response must decorate each discovery with a signed previewUrl
    it('decorates each discovery with a previewUrl whose token verifies to { path, scanRoot }', async () => {
      const mockResult = {
        discoveries: [
          {
            path: '/audiobooks/Author/Title',
            parsedTitle: 'Title',
            parsedAuthor: 'Author',
            parsedSeries: null,
            fileCount: 5,
            totalSize: 500000,
            isDuplicate: false,
          },
          {
            path: '/audiobooks/Author/Other',
            parsedTitle: 'Other',
            parsedAuthor: 'Author',
            parsedSeries: null,
            fileCount: 3,
            totalSize: 300000,
            isDuplicate: false,
          },
        ],
        totalFolders: 2,
      };

      (services.libraryScan.scanDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValue(mockResult);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/scan',
        payload: { path: '/audiobooks' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.discoveries).toHaveLength(2);

      for (const [i, expected] of mockResult.discoveries.entries()) {
        const previewUrl = body.discoveries[i].previewUrl as string;
        expect(previewUrl).toMatch(/^\/api\/import\/preview\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

        const token = previewUrl.replace('/api/import/preview/', '');
        const payload = verifyPreviewToken(token);
        expect(payload).not.toBeNull();
        expect(payload!.purpose).toBe('audio-preview');
        expect(payload!.path).toBe(expected.path);
        expect(payload!.scanRoot).toBe('/audiobooks');
      }
    });

    it('returns 400 when path is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/scan',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 500 on scan error', async () => {
      (services.libraryScan.scanDirectory as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('ENOENT'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/scan',
        payload: { path: '/nonexistent' },
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('ENOENT');
    });
  });

  describe('POST /api/library/import/confirm', () => {
    it('returns import results', async () => {
      (services.libraryScan.confirmImport as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ accepted: 3 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/confirm',
        payload: {
          books: [
            { path: '/a/b', title: 'Book 1', authorName: 'Author 1' },
            { path: '/a/c', title: 'Book 2', authorName: 'Author 2' },
            { path: '/a/d', title: 'Book 3' },
          ],
        },
      });

      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.payload);
      expect(body.accepted).toBe(3);
    });

    it('returns 400 when books array is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/confirm',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when books array is empty', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/confirm',
        payload: { books: [] },
      });

      expect(res.statusCode).toBe(400);
    });

    it('passes mode to confirmImport', async () => {
      (services.libraryScan.confirmImport as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ accepted: 1 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/confirm',
        payload: {
          books: [{ path: '/a/b', title: 'Book', authorName: 'Author' }],
          mode: 'copy',
        },
      });

      expect(res.statusCode).toBe(202);
      expect(services.libraryScan.confirmImport).toHaveBeenCalledWith(
        [{ path: '/a/b', title: 'Book', authorName: 'Author' }],
        'copy',
      );
    });

    it('forwards narrators and seriesPosition to the service (#1028)', async () => {
      (services.libraryScan.confirmImport as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ accepted: 1 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/confirm',
        payload: {
          books: [{
            path: '/a/b',
            title: 'Book',
            authorName: 'Author',
            narrators: ['Jim Dale'],
            seriesPosition: 27,
          }],
        },
      });

      expect(res.statusCode).toBe(202);
      expect(services.libraryScan.confirmImport).toHaveBeenCalledWith(
        [expect.objectContaining({ narrators: ['Jim Dale'], seriesPosition: 27 })],
        undefined,
      );
    });

    it('round-trips seriesPosition: 0 from request body to service (#1028)', async () => {
      (services.libraryScan.confirmImport as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ accepted: 1 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/confirm',
        payload: {
          books: [{ path: '/a/b', title: 'Book', authorName: 'Author', seriesPosition: 0 }],
        },
      });

      expect(res.statusCode).toBe(202);
      const calls = (services.libraryScan.confirmImport as ReturnType<typeof vi.fn>).mock.calls;
      const items = calls[0]![0] as Array<Record<string, unknown>>;
      expect(items[0]!.seriesPosition).toBe(0);
    });

    it('returns 500 on confirmImport error', async () => {
      (services.libraryScan.confirmImport as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('DB write failed'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/confirm',
        payload: {
          books: [{ path: '/a/b', title: 'Book', authorName: 'Author' }],
        },
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('DB write failed');
    });

    it('returns stringified value when non-Error is thrown', async () => {
      (services.libraryScan.confirmImport as ReturnType<typeof vi.fn>)
        .mockRejectedValue('string error');

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/confirm',
        payload: {
          books: [{ path: '/a/b', title: 'Book', authorName: 'Author' }],
        },
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('string error');
    });
  });

  // Wave 11.2 (#755) — single-book scan/import routes retired
  describe('removed routes', () => {
    it('POST /api/library/import/scan-single returns 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/scan-single',
        payload: { path: '/audiobooks/Anywhere' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/library/import/single returns 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/single',
        payload: { path: '/audiobooks/Anywhere', title: 'X' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/library/import/match', () => {
    it('creates a match job and returns jobId', async () => {
      (services.matchJob.createJob as ReturnType<typeof vi.fn>)
        .mockReturnValue('job-abc-123');

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/match',
        payload: {
          books: [
            { path: '/audiobooks/Book1', title: 'Book 1', author: 'Author 1' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.jobId).toBe('job-abc-123');
      expect(services.matchJob.createJob).toHaveBeenCalledWith([
        { path: '/audiobooks/Book1', title: 'Book 1', author: 'Author 1' },
      ]);
    });

    it('returns 400 when books array is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/match',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when books array is empty', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/match',
        payload: { books: [] },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when books is not an array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/match',
        payload: { books: 'not-an-array' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/library/import/match/:jobId', () => {
    it('returns job status when found', async () => {
      const mockStatus = {
        id: 'job-abc-123',
        status: 'running',
        total: 5,
        completed: 2,
        results: [],
      };

      (services.matchJob.getJob as ReturnType<typeof vi.fn>)
        .mockReturnValue(mockStatus);

      const res = await app.inject({
        method: 'GET',
        url: '/api/library/import/match/job-abc-123',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.id).toBe('job-abc-123');
      expect(body.status).toBe('running');
      expect(services.matchJob.getJob).toHaveBeenCalledWith('job-abc-123');
    });

    it('returns 404 when job not found', async () => {
      (services.matchJob.getJob as ReturnType<typeof vi.fn>)
        .mockReturnValue(undefined);

      const res = await app.inject({
        method: 'GET',
        url: '/api/library/import/match/nonexistent-job',
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Job not found or expired');
    });

    it('returns 404 when getJob returns null', async () => {
      (services.matchJob.getJob as ReturnType<typeof vi.fn>)
        .mockReturnValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/library/import/match/expired-job',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/library/import/match/:jobId', () => {
    it('cancels an existing job and returns true', async () => {
      (services.matchJob.cancelJob as ReturnType<typeof vi.fn>)
        .mockReturnValue(true);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/library/import/match/job-abc-123',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.cancelled).toBe(true);
      expect(services.matchJob.cancelJob).toHaveBeenCalledWith('job-abc-123');
    });

    it('returns false when job does not exist', async () => {
      (services.matchJob.cancelJob as ReturnType<typeof vi.fn>)
        .mockReturnValue(false);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/library/import/match/nonexistent-job',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.cancelled).toBe(false);
    });
  });

  describe('POST /api/library/import/scan (additional edge cases)', () => {
    it('returns stringified value when non-Error is thrown', async () => {
      (services.libraryScan.scanDirectory as ReturnType<typeof vi.fn>)
        .mockRejectedValue({ code: 'UNKNOWN' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/scan',
        payload: { path: '/audiobooks' },
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('[object Object]');
    });
  });

  describe('POST /api/library/rescan', () => {
    it('returns 200 with rescan summary', async () => {
      const mockResult = { scanned: 10, missing: 2, restored: 1 };
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>)
        .mockResolvedValue(mockResult);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/rescan',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ scanned: 10, missing: 2, restored: 1 });
    });

    it('returns 409 when scan is already in progress', async () => {
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new ScanInProgressError());

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/rescan',
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Scan already in progress');
    });

    it('returns 400 when library path is not configured', async () => {
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new LibraryPathError('Library path is not configured'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/rescan',
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Library path is not configured');
    });

    it('returns 400 when library path is not accessible', async () => {
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new LibraryPathError('Library path is not accessible: /audiobooks'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/rescan',
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Library path is not accessible: /audiobooks');
    });

    it('returns 500 on unexpected error', async () => {
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('Unexpected DB failure'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/rescan',
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Unexpected DB failure');
    });

    it('returns stringified value when non-Error is thrown', async () => {
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>)
        .mockRejectedValue('unknown');

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/rescan',
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('unknown');
    });
  });

  // ===========================================================================
  // #114 — scan response with isDuplicate flag; confirm with forceImport
  // ===========================================================================
  describe('POST /api/library/import/scan — isDuplicate flag', () => {
    it('response includes isDuplicate on each discovery item', async () => {
      (services.libraryScan.scanDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValue({
          discoveries: [
            { path: '/a/new', parsedTitle: 'New', parsedAuthor: null, parsedSeries: null, fileCount: 1, totalSize: 100, isDuplicate: false },
            { path: '/a/dup', parsedTitle: 'Dup', parsedAuthor: null, parsedSeries: null, fileCount: 1, totalSize: 100, isDuplicate: true, existingBookId: 5 },
          ],
          totalFolders: 2,
        });

      const res = await app.inject({ method: 'POST', url: '/api/library/import/scan', payload: { path: '/a' } });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.discoveries[0].isDuplicate).toBe(false);
      expect(body.discoveries[1].isDuplicate).toBe(true);
    });

    it('response does not include skippedDuplicates field', async () => {
      (services.libraryScan.scanDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ discoveries: [], totalFolders: 0 });

      const res = await app.inject({ method: 'POST', url: '/api/library/import/scan', payload: { path: '/a' } });
      const body = JSON.parse(res.payload);
      expect(body).not.toHaveProperty('skippedDuplicates');
    });

    it('returns 500 when service returns isDuplicate as wrong type (runtime schema enforcement)', async () => {
      (services.libraryScan.scanDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValue({
          discoveries: [
            { path: '/a/bad', parsedTitle: 'Bad', parsedAuthor: null, parsedSeries: null, fileCount: 1, totalSize: 100, isDuplicate: 'yes' },
          ],
          totalFolders: 1,
        });

      const res = await app.inject({ method: 'POST', url: '/api/library/import/scan', payload: { path: '/a' } });
      expect(res.statusCode).toBe(500);
    });

    it('duplicate entries have isDuplicate: true; new entries have isDuplicate: false', async () => {
      (services.libraryScan.scanDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValue({
          discoveries: [
            { path: '/a/new', parsedTitle: 'New', parsedAuthor: null, parsedSeries: null, fileCount: 1, totalSize: 100, isDuplicate: false },
            { path: '/a/dup', parsedTitle: 'Dup', parsedAuthor: null, parsedSeries: null, fileCount: 1, totalSize: 100, isDuplicate: true, existingBookId: 7 },
          ],
          totalFolders: 2,
        });

      const res = await app.inject({ method: 'POST', url: '/api/library/import/scan', payload: { path: '/a' } });
      const body = JSON.parse(res.payload);
      const newEntry = body.discoveries.find((d: { path: string }) => d.path === '/a/new');
      const dupEntry = body.discoveries.find((d: { path: string }) => d.path === '/a/dup');
      expect(newEntry.isDuplicate).toBe(false);
      expect(dupEntry.isDuplicate).toBe(true);
      expect(dupEntry.existingBookId).toBe(7);
    });
  });

  describe('POST /api/library/import/scan — within-scan duplicates (#342)', () => {
    it('response includes duplicateReason=within-scan and duplicateFirstPath for within-scan duplicates', async () => {
      (services.libraryScan.scanDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValue({
          discoveries: [
            { path: '/a/Author/Title', parsedTitle: 'Title', parsedAuthor: 'Author', parsedSeries: null, fileCount: 1, totalSize: 100, isDuplicate: false },
            { path: '/a/Copy/Author/Title', parsedTitle: 'Title', parsedAuthor: 'Author', parsedSeries: null, fileCount: 1, totalSize: 100, isDuplicate: true, duplicateReason: 'within-scan', duplicateFirstPath: '/a/Author/Title' },
          ],
          totalFolders: 2,
        });

      const res = await app.inject({ method: 'POST', url: '/api/library/import/scan', payload: { path: '/a' } });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.discoveries[0].isDuplicate).toBe(false);
      expect(body.discoveries[0]).not.toHaveProperty('duplicateFirstPath');
      expect(body.discoveries[1].isDuplicate).toBe(true);
      expect(body.discoveries[1].duplicateReason).toBe('within-scan');
      expect(body.discoveries[1].duplicateFirstPath).toBe('/a/Author/Title');
    });
  });

  describe('POST /api/library/import/confirm — forceImport field', () => {
    it('accepts items with forceImport: true and passes them to confirmImport', async () => {
      (services.libraryScan.confirmImport as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ accepted: 1 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/confirm',
        payload: {
          books: [{ path: '/a/dup', title: 'Dup Book', forceImport: true }],
        },
      });

      expect(res.statusCode).toBe(202);
      expect(services.libraryScan.confirmImport).toHaveBeenCalledWith(
        [{ path: '/a/dup', title: 'Dup Book', forceImport: true }],
        undefined,
      );
    });

    it('accepts items without forceImport field (field is optional)', async () => {
      (services.libraryScan.confirmImport as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ accepted: 1 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/confirm',
        payload: {
          books: [{ path: '/a/new', title: 'New Book' }],
        },
      });

      expect(res.statusCode).toBe(202);
    });
  });
});
