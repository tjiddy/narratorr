import { describe, it, expect, type vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import { createTestApp, createMockServices, resetMockServices, installMockAppLog } from '../__tests__/helpers.js';
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

  // #1831 — per-route body-size headroom (defense-in-depth for un-proxied deployments).
  // A body over the ~10 MiB confirm/match limit surfaces a 413 with an accurate message
  // (via the scoped error-handler passthrough), while other routes still cap at 1 MiB.
  describe('per-route bodyLimit (#1831)', () => {
    it('match route 413s when the body exceeds ~10 MiB', async () => {
      const oversized = 'x'.repeat(11 * 1024 * 1024);
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/match',
        payload: { books: [{ path: '/a/b', title: oversized }] },
      });
      expect(res.statusCode).toBe(413);
      expect(services.matchJob.createJob).not.toHaveBeenCalled();
    });

    // Positive boundary: without this, the raise is untestable — createTestApp's default
    // 1 MiB cap would 413 the 11 MiB negative above even if the route option were deleted.
    it('match route accepts a ~3 MiB body (over the 1 MiB default, under the route limit)', async () => {
      (services.matchJob.createJob as ReturnType<typeof vi.fn>).mockReturnValue('job-3mib');
      const midsize = 'x'.repeat(3 * 1024 * 1024);
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/match',
        payload: { books: [{ path: '/a/b', title: midsize }] },
      });
      expect(res.statusCode).toBe(200);
      expect(services.matchJob.createJob).toHaveBeenCalled();
    });

    it('leaves the global 1 MiB default in place on other routes (scan 413s above 1 MiB)', async () => {
      (services.libraryScan.scanDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ discoveries: [], totalFolders: 0 });
      const overOneMib = 'x'.repeat(2 * 1024 * 1024);
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/scan',
        payload: { path: overOneMib },
      });
      expect(res.statusCode).toBe(413);
      expect(services.libraryScan.scanDirectory).not.toHaveBeenCalled();
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

    // #1902 — the direct-confirm commit path was atomically removed in favour of the staged
    // submissions lane. Reintroducing this route (or a service path behind it) must fail CI,
    // so pin that it is gone: the request 404s and no direct-confirm service method is invoked.
    it('POST /api/library/import/confirm returns 404 (direct-confirm path removed)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/import/confirm',
        payload: { books: [{ path: '/audiobooks/Anywhere', title: 'X' }], mode: 'copy' },
      });
      expect(res.statusCode).toBe(404);
      // Even with the mock harness still stubbing a confirmImport method, the removed route
      // must never route to a direct-confirm service path.
      const confirmMock = (services.libraryScan as unknown as { confirmImport?: ReturnType<typeof vi.fn> }).confirmImport;
      expect(confirmMock).not.toHaveBeenCalled();
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
      // Fixture corrected to the real MatchJobStatus contract (#1864 F8): the
      // status is one of matching/completed/failed/cancelled and progress is
      // `matched`, not `running`/`completed`.
      const mockStatus = {
        id: 'job-abc-123',
        status: 'matching',
        total: 5,
        matched: 2,
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
      expect(body.status).toBe('matching');
      expect(services.matchJob.getJob).toHaveBeenCalledWith('job-abc-123');
    });

    it('returns a terminal failed job at 200 with error + retained results (#1864 F8)', async () => {
      const failedStatus = {
        id: 'job-failed-1',
        status: 'failed',
        total: 3,
        matched: 1,
        results: [{ path: '/a', confidence: 'high', bestMatch: null, alternatives: [] }],
        error: 'orchestration boom',
      };
      (services.matchJob.getJob as ReturnType<typeof vi.fn>).mockReturnValue(failedStatus);

      const res = await app.inject({ method: 'GET', url: '/api/library/import/match/job-failed-1' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('failed');
      expect(body.error).toBe('orchestration boom');
      expect(body.results).toHaveLength(1);
    });

    it('returns 404 once the failed job is removed post-TTL', async () => {
      // After TTL the service drops the job — the poll then 404s (not a stale 200).
      (services.matchJob.getJob as ReturnType<typeof vi.fn>).mockReturnValue(null);
      const res = await app.inject({ method: 'GET', url: '/api/library/import/match/job-failed-1' });
      expect(res.statusCode).toBe(404);
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

    // =======================================================================
    // #1960 AC9/AC12/AC14 — the route goes through the companion sweep wrapper
    // =======================================================================

    it('AC9/AC12: a successful rescan triggers exactly one companion sweep', async () => {
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ scanned: 10, missing: 2, restored: 1 });
      (services.companionEbook.reconcileAll as ReturnType<typeof vi.fn>)
        .mockResolvedValue(undefined);

      const res = await app.inject({ method: 'POST', url: '/api/library/rescan' });

      expect(res.statusCode).toBe(200);
      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
      expect(services.companionEbook.reconcileBook).not.toHaveBeenCalled();
    });

    it('AC12: a 409 (ScanInProgressError) triggers ZERO companion sweeps', async () => {
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new ScanInProgressError());
      (services.companionEbook.reconcileAll as ReturnType<typeof vi.fn>)
        .mockResolvedValue(undefined);

      const res = await app.inject({ method: 'POST', url: '/api/library/rescan' });

      expect(res.statusCode).toBe(409);
      expect(services.companionEbook.reconcileAll).not.toHaveBeenCalled();
    });

    it('AC12: a 400 (LibraryPathError) still sweeps, and the mapping is unchanged', async () => {
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new LibraryPathError('Library path is not configured'));
      (services.companionEbook.reconcileAll as ReturnType<typeof vi.fn>)
        .mockResolvedValue(undefined);

      const res = await app.inject({ method: 'POST', url: '/api/library/rescan' });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toBe('Library path is not configured');
      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
    });

    it('AC12: a 500 (unexpected throw) still sweeps, and the mapping is unchanged', async () => {
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('Unexpected DB failure'));
      (services.companionEbook.reconcileAll as ReturnType<typeof vi.fn>)
        .mockResolvedValue(undefined);

      const res = await app.inject({ method: 'POST', url: '/api/library/rescan' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Unexpected DB failure');
      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
    });

    it('AC14: a rescan issued while a companion sweep is still in flight returns 200, not 409', async () => {
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ scanned: 1, missing: 0, restored: 0 });
      // Sweep A never settles — it is provably still pending when the second POST lands.
      let releaseSweep!: () => void;
      const pendingSweep = new Promise<void>((r) => { releaseSweep = r; });
      (services.companionEbook.reconcileAll as ReturnType<typeof vi.fn>)
        .mockReturnValue(pendingSweep);

      const first = await app.inject({ method: 'POST', url: '/api/library/rescan' });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({ method: 'POST', url: '/api/library/rescan' });
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.payload)).toEqual({ scanned: 1, missing: 0, restored: 0 });

      releaseSweep();
      await pendingSweep;
    });

    it('AC12: a rejecting sweep does not change the 200 the route already returned', async () => {
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ scanned: 4, missing: 0, restored: 0 });
      (services.companionEbook.reconcileAll as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('sweep rejected'));

      const res = await app.inject({ method: 'POST', url: '/api/library/rescan' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ scanned: 4, missing: 0, restored: 0 });
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

  describe('POST /api/library/import/scan — within-scan title collisions (#1925)', () => {
    it('serializes a former within-scan row as a normal candidate + review hint, no duplicate fields', async () => {
      (services.libraryScan.scanDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValue({
          discoveries: [
            { path: '/a/Author/Title', parsedTitle: 'Title', parsedAuthor: 'Author', parsedSeries: null, fileCount: 1, totalSize: 100, isDuplicate: false },
            { path: '/a/Copy/Author/Title', parsedTitle: 'Title', parsedAuthor: 'Author', parsedSeries: null, fileCount: 1, totalSize: 100, isDuplicate: false, reviewReason: 'Possible duplicate folder in this scan' },
          ],
          totalFolders: 2,
        });

      const res = await app.inject({ method: 'POST', url: '/api/library/import/scan', payload: { path: '/a' } });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      // Both rows flow through as normal candidates — the recording ladder decides identity at confirm time.
      expect(body.discoveries[0].isDuplicate).toBe(false);
      expect(body.discoveries[1].isDuplicate).toBe(false);
      expect(body.discoveries[1].reviewReason).toBe('Possible duplicate folder in this scan');
      // The within-scan hard-flag machinery is gone — no duplicate reason/first-path survives serialization.
      expect(body.discoveries[1]).not.toHaveProperty('duplicateReason');
      expect(body.discoveries[1]).not.toHaveProperty('duplicateFirstPath');
    });
  });

  // #2055 — the import editor's re-pick path asks the server for the same
  // chapter-runtime second opinion the match job already gets (#1942).
  describe('POST /api/library/import/duration-corroboration (#2055/#2168)', () => {
    // The live Fablehaven case, canonical values already pinned in-repo:
    // scanned 33219.47s (match-job.helpers.test.ts), chapter table 33219.49s
    // (chapter-corroboration.test.ts FABLEHAVEN_MS), provider scalar 539min = 32340s.
    const ASIN = 'B00CXXEX8W';
    const SCANNED = 33219.47;
    const CHAPTERS = 33219.49;
    /** Fablehaven has no trimmable tail, so both references carry the full sum. */
    const REFS = { fullSeconds: CHAPTERS, trimmedSeconds: CHAPTERS };

    const chapterStub = () => services.metadata.getChapterRuntimeSeconds as unknown as ReturnType<typeof vi.fn>;

    const post = (payload: unknown) =>
      app.inject({ method: 'POST', url: '/api/library/import/duration-corroboration', payload: payload as object });

    it('corroborates the scanned runtime against the chapter table', async () => {
      chapterStub().mockResolvedValue(REFS);

      const res = await post({ asin: ASIN, scannedSeconds: SCANNED });

      expect(res.statusCode).toBe(200);
      // The trimmed field is ABSENT: the walk removed nothing, so there is no
      // OTHER number to report (#2168 AC27).
      expect(JSON.parse(res.payload)).toEqual({ corroborated: true, chapterSeconds: CHAPTERS });
    });

    it('reports a chapter runtime that is also out of band as not corroborated', async () => {
      chapterStub().mockResolvedValue({ fullSeconds: 40000, trimmedSeconds: 40000 });

      const res = await post({ asin: ASIN, scannedSeconds: SCANNED });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ corroborated: false, chapterSeconds: 40000 });
    });

    it('omits chapterSeconds entirely when there is no usable chapter runtime', async () => {
      chapterStub().mockResolvedValue({});

      const res = await post({ asin: ASIN, scannedSeconds: SCANNED });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ corroborated: false });
      // The observation point is the SERIALIZED body: JSON drops an `undefined` value, so
      // present-but-undefined and absent are the same thing on the wire and this cannot
      // distinguish them. What it does catch — verified counterfactually — is a fabricated
      // stand-in (`chapterSeconds: 0`/`null`), which would read as a mismatch claim where
      // the honest answer is "no second opinion available".
      expect(body).not.toHaveProperty('chapterSeconds');
    });

    it('looks the edition up exactly once, with the trimmed ASIN', async () => {
      chapterStub().mockResolvedValue(REFS);

      const res = await post({ asin: `  ${ASIN}  `, scannedSeconds: SCANNED });

      expect(res.statusCode).toBe(200);
      expect(chapterStub()).toHaveBeenCalledTimes(1);
      expect(chapterStub()).toHaveBeenCalledWith(ASIN);
    });

    it('pins the shared inclusive tolerance band in both directions', async () => {
      chapterStub().mockResolvedValue({ fullSeconds: SCANNED + 240, trimmedSeconds: SCANNED + 240 });
      const inBand = await post({ asin: ASIN, scannedSeconds: SCANNED });
      expect(JSON.parse(inBand.payload).corroborated).toBe(true);

      chapterStub().mockResolvedValue({ fullSeconds: SCANNED + 241, trimmedSeconds: SCANNED + 241 });
      const outOfBand = await post({ asin: ASIN, scannedSeconds: SCANNED });
      expect(JSON.parse(outOfBand.payload).corroborated).toBe(false);
    });

    it.each([
      ['missing asin', { scannedSeconds: SCANNED }],
      ['blank asin', { asin: '   ', scannedSeconds: SCANNED }],
      ['missing scannedSeconds', { asin: ASIN }],
      ['zero scannedSeconds', { asin: ASIN, scannedSeconds: 0 }],
      ['negative scannedSeconds', { asin: ASIN, scannedSeconds: -1 }],
      ['non-numeric scannedSeconds', { asin: ASIN, scannedSeconds: 'abc' }],
    ])('rejects %s with 400 and never reaches the provider', async (_label, payload) => {
      chapterStub().mockResolvedValue(REFS);

      const res = await post(payload);

      expect(res.statusCode).toBe(400);
      expect(chapterStub()).not.toHaveBeenCalled();
    });

    it('degrades a rejected lookup to a 200 "no second opinion", logged at debug', async () => {
      const { spies, restore } = installMockAppLog(app);
      try {
        chapterStub().mockRejectedValue(new Error('audnexus exploded'));

        const res = await post({ asin: ASIN, scannedSeconds: SCANNED });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body).toEqual({ corroborated: false });
        expect(body).not.toHaveProperty('chapterSeconds');

        const debugCall = spies.debug.mock.calls.find(
          (c) => typeof c[1] === 'string' && c[1].includes('Chapter corroboration failed'),
        );
        expect(debugCall).toBeDefined();
        // serializeError shape — enumerable name/message keys, never the raw Error.
        expect(debugCall![0]).toMatchObject({
          asin: ASIN,
          error: expect.objectContaining({ type: 'Error', message: 'audnexus exploded' }),
        });
      } finally {
        restore();
      }
    });

    // #2168 — the route applies the same full-OR-trimmed rule the match job does,
    // and reports the trimmed reference only when it is a genuinely DIFFERENT
    // number. The trimmed chapter COUNT is never on the wire.
    describe('trimmed chapter runtime (#2168)', () => {
      /** Addie LaRue: only the trimmed reference is in band. */
      const ADDIE_SCANNED = 85_144;
      const ADDIE_FULL = 86_400;
      const ADDIE_TRIMMED = 85_134;

      /**
       * The FULL arm, made deletion-resistant. Every other positive fixture in
       * this suite gives both references the SAME value, so deleting
       * `inBand(fullSeconds, …)` from the route would leave them green via the
       * trimmed arm. Here the file DOES contain the trailing run (so it agrees
       * with the published total) and the trim over-removed relative to this
       * particular rip — the full reference is the only thing that can rescue it.
       */
      it('corroborates when ONLY the full reference is in band, with a DISTINCT out-of-band trim', async () => {
        // Δ(full, scanned) = 0.02s (in band); Δ(trimmed, scanned) = 7199.98s (out).
        const OVER_TRIMMED = 26_019.49;
        chapterStub().mockResolvedValue({ fullSeconds: CHAPTERS, trimmedSeconds: OVER_TRIMMED });

        const res = await post({ asin: ASIN, scannedSeconds: SCANNED });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload)).toEqual({
          corroborated: true,
          chapterSeconds: CHAPTERS,
          trimmedChapterSeconds: OVER_TRIMMED,
        });
      });

      it('corroborates on the full reference when the walk produced NO usable trimmed one', async () => {
        // The whole-list-consumed / degenerate-trim shape: the pair carries only
        // `fullSeconds`, and the route must still answer off it.
        chapterStub().mockResolvedValue({ fullSeconds: CHAPTERS });

        const res = await post({ asin: ASIN, scannedSeconds: SCANNED });

        const body = JSON.parse(res.payload);
        expect(body).toEqual({ corroborated: true, chapterSeconds: CHAPTERS });
        expect(body).not.toHaveProperty('trimmedChapterSeconds');
      });

      it('corroborates when ONLY the trimmed reference is in band, and reports it', async () => {
        chapterStub().mockResolvedValue({ fullSeconds: ADDIE_FULL, trimmedSeconds: ADDIE_TRIMMED });

        const res = await post({ asin: ASIN, scannedSeconds: ADDIE_SCANNED });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload)).toEqual({
          corroborated: true,
          chapterSeconds: ADDIE_FULL,
          trimmedChapterSeconds: ADDIE_TRIMMED,
        });
      });

      it('reports NOT corroborated when neither reference is in band', async () => {
        chapterStub().mockResolvedValue({ fullSeconds: ADDIE_FULL, trimmedSeconds: ADDIE_TRIMMED });

        const res = await post({ asin: ASIN, scannedSeconds: 70_000 });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload)).toEqual({
          corroborated: false,
          chapterSeconds: ADDIE_FULL,
          trimmedChapterSeconds: ADDIE_TRIMMED,
        });
      });

      it('OMITS the trimmed field when a chapter WAS removed but the two runtimes are equal', async () => {
        // The trusted zero-length-tail case: the adapter counted 1 removal, but the
        // field answers "what OTHER number did the band get checked against" — and
        // there isn't one. Counterfactual: key the field on the trim ACT rather than
        // the value and this leaks a duplicate of `chapterSeconds`.
        chapterStub().mockResolvedValue({ fullSeconds: CHAPTERS, trimmedSeconds: CHAPTERS });

        const res = await post({ asin: ASIN, scannedSeconds: SCANNED });

        const body = JSON.parse(res.payload);
        expect(body).toEqual({ corroborated: true, chapterSeconds: CHAPTERS });
        expect(body).not.toHaveProperty('trimmedChapterSeconds');
      });

      it('never puts the trimmed chapter COUNT on the wire', async () => {
        chapterStub().mockResolvedValue({ fullSeconds: ADDIE_FULL, trimmedSeconds: ADDIE_TRIMMED });

        const res = await post({ asin: ASIN, scannedSeconds: ADDIE_SCANNED });

        expect(Object.keys(JSON.parse(res.payload)).sort())
          .toEqual(['chapterSeconds', 'corroborated', 'trimmedChapterSeconds']);
      });

      it('a trimmed-only reference (no usable full one) still answers and reports it', async () => {
        chapterStub().mockResolvedValue({ trimmedSeconds: ADDIE_TRIMMED });

        const res = await post({ asin: ASIN, scannedSeconds: ADDIE_SCANNED });

        const body = JSON.parse(res.payload);
        expect(body).toEqual({ corroborated: true, trimmedChapterSeconds: ADDIE_TRIMMED });
        expect(body).not.toHaveProperty('chapterSeconds');
      });
    });
  });

});
