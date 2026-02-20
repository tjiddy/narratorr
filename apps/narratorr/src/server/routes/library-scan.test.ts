import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

describe('library-scan routes', () => {
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
    Object.values(services).forEach((svc) => {
      Object.values(svc).forEach((fn) => {
        if (typeof fn === 'function' && 'mockReset' in fn) {
          (fn as ReturnType<typeof vi.fn>).mockReset();
        }
      });
    });
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
          },
        ],
        totalFolders: 2,
        skippedDuplicates: 1,
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
      expect(body.skippedDuplicates).toBe(1);
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

    it('returns generic message when non-Error is thrown', async () => {
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
      expect(body.error).toBe('Import failed');
    });
  });

  describe('POST /api/library/import/scan-single', () => {
    it('returns scan result for a single book folder', async () => {
      const mockResult = {
        parsedTitle: 'The Great Gatsby',
        parsedAuthor: 'F. Scott Fitzgerald',
        match: { title: 'The Great Gatsby', asin: 'B123' },
      };

      (services.libraryScan.scanSingleBook as ReturnType<typeof vi.fn>)
        .mockResolvedValue(mockResult);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/scan-single',
        payload: { path: '/audiobooks/Fitzgerald/The Great Gatsby' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.parsedTitle).toBe('The Great Gatsby');
      expect(body.match.asin).toBe('B123');
      expect(services.libraryScan.scanSingleBook).toHaveBeenCalledWith(
        '/audiobooks/Fitzgerald/The Great Gatsby',
      );
    });

    it('returns 400 when path is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/scan-single',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('path is required');
    });

    it('returns 400 when path is not a string', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/scan-single',
        payload: { path: 123 },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 on scan error with error message', async () => {
      (services.libraryScan.scanSingleBook as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('Folder not found'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/scan-single',
        payload: { path: '/nonexistent/path' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('Folder not found');
    });

    it('returns generic message when non-Error is thrown', async () => {
      (services.libraryScan.scanSingleBook as ReturnType<typeof vi.fn>)
        .mockRejectedValue('unexpected');

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/scan-single',
        payload: { path: '/some/path' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Scan failed');
    });
  });

  describe('POST /api/library/import/single', () => {
    it('imports a single book successfully', async () => {
      const mockResult = { id: 1, title: 'Test Book', path: '/lib/Test Book' };

      (services.libraryScan.importSingleBook as ReturnType<typeof vi.fn>)
        .mockResolvedValue(mockResult);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/single',
        payload: {
          path: '/audiobooks/Author/Test Book',
          title: 'Test Book',
          authorName: 'Author',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.id).toBe(1);
      expect(body.title).toBe('Test Book');
    });

    it('passes mode and metadata to importSingleBook', async () => {
      (services.libraryScan.importSingleBook as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ id: 2 });

      const metadata = { asin: 'B123', description: 'A book' };
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/single',
        payload: {
          path: '/audiobooks/Book',
          title: 'Book',
          authorName: 'Author',
          mode: 'move',
          metadata,
        },
      });

      expect(res.statusCode).toBe(200);
      // metadata is separated from item, mode is passed as third arg
      expect(services.libraryScan.importSingleBook).toHaveBeenCalledWith(
        { path: '/audiobooks/Book', title: 'Book', authorName: 'Author' },
        metadata,
        'move',
      );
    });

    it('passes undefined metadata when not provided', async () => {
      (services.libraryScan.importSingleBook as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ id: 3 });

      await app.inject({
        method: 'POST',
        url: '/api/library/import/single',
        payload: {
          path: '/audiobooks/Book',
          title: 'Book',
          authorName: 'Author',
        },
      });

      expect(services.libraryScan.importSingleBook).toHaveBeenCalledWith(
        { path: '/audiobooks/Book', title: 'Book', authorName: 'Author' },
        undefined,
        undefined,
      );
    });

    it('returns 400 when path is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/single',
        payload: { title: 'Book' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('path and title are required');
    });

    it('returns 400 when title is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/single',
        payload: { path: '/audiobooks/Book' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('path and title are required');
    });

    it('returns 500 on import error', async () => {
      (services.libraryScan.importSingleBook as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('Disk full'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/single',
        payload: {
          path: '/audiobooks/Book',
          title: 'Book',
          authorName: 'Author',
        },
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('Disk full');
    });

    it('returns generic message when non-Error is thrown', async () => {
      (services.libraryScan.importSingleBook as ReturnType<typeof vi.fn>)
        .mockRejectedValue(42);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/single',
        payload: {
          path: '/audiobooks/Book',
          title: 'Book',
          authorName: 'Author',
        },
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Import failed');
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
            { path: '/audiobooks/Book1', parsedTitle: 'Book 1', parsedAuthor: 'Author 1' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.jobId).toBe('job-abc-123');
      expect(services.matchJob.createJob).toHaveBeenCalledWith([
        { path: '/audiobooks/Book1', parsedTitle: 'Book 1', parsedAuthor: 'Author 1' },
      ]);
    });

    it('returns 400 when books array is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/match',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('books array is required');
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
    it('returns generic message when non-Error is thrown', async () => {
      (services.libraryScan.scanDirectory as ReturnType<typeof vi.fn>)
        .mockRejectedValue({ code: 'UNKNOWN' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/scan',
        payload: { path: '/audiobooks' },
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Scan failed');
    });
  });
});
