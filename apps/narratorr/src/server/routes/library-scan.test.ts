import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
          (fn as ReturnType<typeof import('vitest').vi.fn>).mockReset();
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

      (services.libraryScan.scanDirectory as ReturnType<typeof import('vitest').vi.fn>)
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
      (services.libraryScan.scanDirectory as ReturnType<typeof import('vitest').vi.fn>)
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
      (services.libraryScan.confirmImport as ReturnType<typeof import('vitest').vi.fn>)
        .mockResolvedValue({ imported: 3, failed: 0 });

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

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.imported).toBe(3);
      expect(body.failed).toBe(0);
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
  });
});
