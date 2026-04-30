import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { QualityGateServiceError } from '../services/quality-gate.service.js';
import { DownloadError } from '../services/download.service.js';

vi.mock('../utils/enqueue-auto-import.js', () => ({
  enqueueAutoImport: vi.fn().mockResolvedValue(true),
}));

import { enqueueAutoImport } from '../utils/enqueue-auto-import.js';

const mockDownload = {
  id: 1,
  bookId: 1,
  indexerId: 1,
  downloadClientId: 1,
  title: 'The Way of Kings',
  infoHash: 'abc123',
  protocol: 'torrent' as const,
  downloadUrl: 'magnet:?xt=urn:btih:abc123',
  size: 1073741824,
  seeders: 42,
  status: 'downloading',
  progress: 0.5,
  externalId: 'ext-1',
  errorMessage: null,
  addedAt: new Date(),
  completedAt: null,
  guid: null, outputPath: null, progressUpdatedAt: null, pendingCleanup: null,
};

describe('activity routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices({});
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
    vi.mocked(enqueueAutoImport).mockClear();
  });

  describe('GET /api/activity', () => {
    it('returns downloads in { data, total } envelope', async () => {
      (services.download.getAll as Mock).mockResolvedValue({ data: [mockDownload], total: 1 });

      const res = await app.inject({ method: 'GET', url: '/api/activity' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it('passes status filter and pagination', async () => {
      (services.download.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/activity?status=downloading' });

      expect(services.download.getAll).toHaveBeenCalledWith('downloading', { limit: 50, offset: undefined }, undefined);
    });

    it('forwards limit and offset to service', async () => {
      (services.download.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/activity?limit=10&offset=20' });

      expect(services.download.getAll).toHaveBeenCalledWith(undefined, { limit: 10, offset: 20 }, undefined);
    });

    it('rejects limit=0 with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/activity?limit=0' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects negative offset with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/activity?offset=-1' });
      expect(res.statusCode).toBe(400);
    });

    it('augments pending_review downloads with quality gate data via batch', async () => {
      const pendingDownload = { ...mockDownload, id: 2, status: 'pending_review' };
      const gateData = { action: 'held', mbPerHour: 60, existingMbPerHour: 40 };
      (services.download.getAll as Mock).mockResolvedValue({ data: [mockDownload, pendingDownload], total: 2 });
      (services.qualityGate.getQualityGateDataBatch as Mock).mockResolvedValue(
        new Map([[2, gateData]]),
      );

      const res = await app.inject({ method: 'GET', url: '/api/activity' });

      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].qualityGate).toBeUndefined();
      expect(body.data[1].qualityGate).toEqual(gateData);
      expect(body.total).toBe(2);
      expect(services.qualityGate.getQualityGateDataBatch).toHaveBeenCalledWith([2]);
    });

    it('batch-fetches quality gate data for multiple pending_review downloads', async () => {
      const pending1 = { ...mockDownload, id: 2, status: 'pending_review' };
      const pending2 = { ...mockDownload, id: 3, status: 'pending_review' };
      const gate2 = { action: 'held', mbPerHour: 60 };
      const gate3 = { action: 'held', mbPerHour: 80 };
      (services.download.getAll as Mock).mockResolvedValue({ data: [mockDownload, pending1, pending2], total: 3 });
      (services.qualityGate.getQualityGateDataBatch as Mock).mockResolvedValue(
        new Map([[2, gate2], [3, gate3]]),
      );

      const res = await app.inject({ method: 'GET', url: '/api/activity' });

      const body = JSON.parse(res.payload);
      expect(body.data[1].qualityGate).toEqual(gate2);
      expect(body.data[2].qualityGate).toEqual(gate3);
      // Should be called once with all pending_review IDs, not once per download
      expect(services.qualityGate.getQualityGateDataBatch).toHaveBeenCalledTimes(1);
      expect(services.qualityGate.getQualityGateDataBatch).toHaveBeenCalledWith([2, 3]);
    });

    it('skips quality gate fetch when no pending_review downloads exist', async () => {
      (services.download.getAll as Mock).mockResolvedValue({ data: [mockDownload], total: 1 });

      const res = await app.inject({ method: 'GET', url: '/api/activity' });

      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(1);
      expect(services.qualityGate.getQualityGateDataBatch).not.toHaveBeenCalled();
    });

    it('handles null quality gate data — download still appears without qualityGate field', async () => {
      const pendingDownload = { ...mockDownload, id: 2, status: 'pending_review' };
      (services.download.getAll as Mock).mockResolvedValue({ data: [pendingDownload], total: 1 });
      (services.qualityGate.getQualityGateDataBatch as Mock).mockResolvedValue(
        new Map([[2, null]]),
      );

      const res = await app.inject({ method: 'GET', url: '/api/activity' });

      const body = JSON.parse(res.payload);
      expect(body.data[0].qualityGate).toBeUndefined();
    });
  });

  describe('GET /api/activity/active', () => {
    it('returns active downloads', async () => {
      (services.download.getActive as Mock).mockResolvedValue([mockDownload]);

      const res = await app.inject({ method: 'GET', url: '/api/activity/active' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveLength(1);
    });
  });

  describe('GET /api/activity/counts', () => {
    it('returns active and completed counts', async () => {
      (services.download.getCounts as Mock).mockResolvedValue({ active: 3, completed: 7 });

      const res = await app.inject({ method: 'GET', url: '/api/activity/counts' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.active).toBe(3);
      expect(body.completed).toBe(7);
    });

    it('returns zeros when no downloads', async () => {
      (services.download.getCounts as Mock).mockResolvedValue({ active: 0, completed: 0 });

      const res = await app.inject({ method: 'GET', url: '/api/activity/counts' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.active).toBe(0);
      expect(body.completed).toBe(0);
    });
  });

  describe('GET /api/activity/:id', () => {
    it('returns download when found', async () => {
      (services.download.getById as Mock).mockResolvedValue(mockDownload);

      const res = await app.inject({ method: 'GET', url: '/api/activity/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).title).toBe('The Way of Kings');
    });

    it('returns 404 when not found', async () => {
      (services.download.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/activity/999' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/activity/:id', () => {
    it('cancels download and returns success', async () => {
      (services.downloadOrchestrator.cancel as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);
    });

    it('returns 404 when not found', async () => {
      (services.downloadOrchestrator.cancel as Mock).mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/999' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/activity/:id/retry', () => {
    it('returns 201 with new download on successful retry', async () => {
      const newDownload = { ...mockDownload, id: 2 };
      (services.downloadOrchestrator.retry as Mock).mockResolvedValue({ status: 'retried', download: newDownload });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(201);
      expect(services.downloadOrchestrator.retry).toHaveBeenCalledWith(1);
      expect(JSON.parse(res.payload).id).toBe(2);
    });

    it('returns 200 with no_candidates status when no candidates found', async () => {
      (services.downloadOrchestrator.retry as Mock).mockResolvedValue({ status: 'no_candidates' });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).status).toBe('no_candidates');
    });

    it('returns 200 with retry_error status when retry search errors', async () => {
      (services.downloadOrchestrator.retry as Mock).mockResolvedValue({ status: 'retry_error' });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).status).toBe('retry_error');
    });

    it('returns 404 when download not found', async () => {
      (services.downloadOrchestrator.retry as Mock).mockRejectedValue(new DownloadError('Download 999 not found', 'NOT_FOUND'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/999/retry' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when no book linked', async () => {
      (services.downloadOrchestrator.retry as Mock).mockRejectedValue(new DownloadError('Download 1 has no book linked', 'NO_BOOK_LINKED'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when download not in failed state', async () => {
      (services.downloadOrchestrator.retry as Mock).mockRejectedValue(new DownloadError('Download 1 is not in failed state', 'INVALID_STATUS'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 500 when retry fails unexpectedly', async () => {
      (services.downloadOrchestrator.retry as Mock).mockRejectedValue(new Error('No client'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(500);
    });

    // #149 — typed error routing via plugin (ERR-1)
    it('returns 404 when orchestrator throws DownloadError NOT_FOUND (plugin-routed)', async () => {
      (services.downloadOrchestrator.retry as Mock).mockRejectedValue(new DownloadError('Download 999 not found', 'NOT_FOUND'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/999/retry' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Download 999 not found' });
    });

    it('returns 404 when orchestrator throws DownloadError NO_BOOK_LINKED (plugin-routed)', async () => {
      (services.downloadOrchestrator.retry as Mock).mockRejectedValue(new DownloadError('Download 1 has no book linked', 'NO_BOOK_LINKED'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Download 1 has no book linked' });
    });

    it('returns 400 when orchestrator throws DownloadError INVALID_STATUS (plugin-routed)', async () => {
      (services.downloadOrchestrator.retry as Mock).mockRejectedValue(new DownloadError('Download 1 is not in failed state', 'INVALID_STATUS'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Download 1 is not in failed state' });
    });

    it('returns 500 with plugin fallback body when unrelated error message contains "not found" substring (regression: no string routing)', async () => {
      (services.downloadOrchestrator.retry as Mock).mockRejectedValue(new Error('Config key not found in registry'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
    });
  });

  describe('POST /api/activity/:id/approve', () => {
    it('transitions pending_review download to importing and enqueues auto import job', async () => {
      (services.qualityGateOrchestrator.approve as Mock).mockResolvedValue({ id: 1, status: 'importing', bookId: 1 });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ id: 1, status: 'importing', bookId: 1 });
      expect(enqueueAutoImport).toHaveBeenCalledWith(
        expect.anything(), 1, 1, expect.any(Function), expect.anything(),
      );
    });

    it('skips enqueue when bookId is null', async () => {
      (services.qualityGateOrchestrator.approve as Mock).mockResolvedValue({ id: 1, status: 'importing', bookId: null });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(200);
      expect(enqueueAutoImport).not.toHaveBeenCalled();
    });

    it('returns approve result unchanged on enqueue conflict (no 4xx/5xx) (#747)', async () => {
      (services.qualityGateOrchestrator.approve as Mock).mockResolvedValue({ id: 1, status: 'importing', bookId: 1 });
      // Simulate a benign idempotency outcome — another path already enqueued.
      vi.mocked(enqueueAutoImport).mockResolvedValueOnce(false);

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ id: 1, status: 'importing', bookId: 1 });
      expect(enqueueAutoImport).toHaveBeenCalledTimes(1);
    });

    it('returns 409 when download is not in pending_review status', async () => {
      (services.qualityGateOrchestrator.approve as Mock).mockRejectedValue(new QualityGateServiceError('Download is not pending review', 'INVALID_STATUS'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(409);
    });

    it('returns 404 when download not found', async () => {
      (services.qualityGateOrchestrator.approve as Mock).mockRejectedValue(new QualityGateServiceError('Download not found', 'NOT_FOUND'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/999/approve' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 500 when approve throws an untyped error', async () => {
      (services.qualityGateOrchestrator.approve as Mock).mockRejectedValue(new Error('unexpected DB failure'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
    });
  });

  // Slot-based concurrency tests removed in #636 — approve now enqueues via enqueueAutoImport

  describe('POST /api/activity/:id/reject', () => {
    it('transitions pending_review download to failed with default retry=false', async () => {
      (services.qualityGateOrchestrator.reject as Mock).mockResolvedValue({ id: 1, status: 'failed' });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/reject' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ id: 1, status: 'failed' });
      expect(services.qualityGateOrchestrator.reject).toHaveBeenCalledWith(1, { retry: false });
    });

    it('ignores unknown body fields and defaults retry to false', async () => {
      (services.qualityGateOrchestrator.reject as Mock).mockResolvedValue({ id: 1, status: 'failed' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/activity/1/reject',
        payload: { reason: 'Wrong narrator' },
      });

      expect(res.statusCode).toBe(200);
      expect(services.qualityGateOrchestrator.reject).toHaveBeenCalledWith(1, { retry: false });
    });

    it('returns 409 when download is not in pending_review status', async () => {
      (services.qualityGateOrchestrator.reject as Mock).mockRejectedValue(new QualityGateServiceError('Download is not pending review', 'INVALID_STATUS'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/reject' });

      expect(res.statusCode).toBe(409);
    });

    it('returns 404 when download not found', async () => {
      (services.qualityGateOrchestrator.reject as Mock).mockRejectedValue(new QualityGateServiceError('Download not found', 'NOT_FOUND'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/999/reject' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 500 when reject throws an untyped error', async () => {
      (services.qualityGateOrchestrator.reject as Mock).mockRejectedValue(new Error('unexpected DB failure'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/reject' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
    });
  });

  describe('error paths', () => {
    it('DELETE /api/activity/:id returns 500 when cancel throws', async () => {
      (services.downloadOrchestrator.cancel as Mock).mockRejectedValue(new Error('Adapter error'));

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/1' });

      expect(res.statusCode).toBe(500);
    });

    it('GET /api/activity returns 500 when downloadService.getAll throws', async () => {
      (services.download.getAll as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'GET', url: '/api/activity' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    it('GET /api/activity returns 500 when getQualityGateDataBatch rejects', async () => {
      const pendingDownload = { ...mockDownload, id: 2, status: 'pending_review' };
      (services.download.getAll as Mock).mockResolvedValue({ data: [pendingDownload], total: 1 });
      (services.qualityGate.getQualityGateDataBatch as Mock).mockRejectedValue(new Error('Batch query failed'));

      const res = await app.inject({ method: 'GET', url: '/api/activity' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    it('GET /api/activity/active returns 500 when service throws', async () => {
      (services.download.getActive as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'GET', url: '/api/activity/active' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    it('GET /api/activity/counts returns 500 when service throws', async () => {
      (services.download.getCounts as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'GET', url: '/api/activity/counts' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    it('GET /api/activity/:id returns 500 when getById throws', async () => {
      (services.download.getById as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'GET', url: '/api/activity/1' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('Internal server error');
    });

    it('GET /api/activity/:id returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/activity/abc' });
      expect(res.statusCode).toBe(400);
    });

    it('DELETE /api/activity/:id returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/activity/abc' });
      expect(res.statusCode).toBe(400);
    });

    it('POST /api/activity/:id/retry returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/activity/abc/retry' });
      expect(res.statusCode).toBe(400);
    });

    it('POST /api/activity/:id/retry delegates to service retry method', async () => {
      const newDownload = { ...mockDownload, id: 2 };
      (services.downloadOrchestrator.retry as Mock).mockResolvedValue({ status: 'retried', download: newDownload });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(201);
      expect(services.downloadOrchestrator.retry).toHaveBeenCalledWith(1);
    });
  });

  // #372 — Default pagination enforcement and section split
  describe('GET /api/activity — default pagination', () => {
    it('applies default limit=50 when no limit param provided', async () => {
      (services.download.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/activity' });

      expect(services.download.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: 50, offset: undefined },
        undefined,
      );
    });

    it('applies default limit when offset provided without limit', async () => {
      (services.download.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/activity?offset=10' });

      expect(services.download.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: 50, offset: 10 },
        undefined,
      );
    });

    it('allows explicit limit to override default', async () => {
      (services.download.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/activity?limit=25' });

      expect(services.download.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: 25, offset: undefined },
        undefined,
      );
    });
  });

  describe('GET /api/activity — section split', () => {
    it('passes section=queue to service', async () => {
      (services.download.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/activity?section=queue' });

      expect(services.download.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: 50, offset: undefined },
        'queue',
      );
    });

    it('passes section=history to service', async () => {
      (services.download.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/activity?section=history' });

      expect(services.download.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: 50, offset: undefined },
        'history',
      );
    });

    it('returns all downloads when no section param', async () => {
      (services.download.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/activity' });

      expect(services.download.getAll).toHaveBeenCalledWith(
        undefined,
        { limit: 50, offset: undefined },
        undefined,
      );
    });
  });

  describe('DELETE /api/activity/:id/history', () => {
    it('returns 200 { success: true } when download has terminal status', async () => {
      (services.download.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/1/history' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: true });
      expect(services.download.delete).toHaveBeenCalledWith(1);
    });

    it('returns 404 when id not found', async () => {
      (services.download.delete as Mock).mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/999/history' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when download has non-terminal status', async () => {
      (services.download.delete as Mock).mockRejectedValue(
        new DownloadError("Cannot delete download with status 'downloading' — use cancel instead", 'INVALID_STATUS'),
      );

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/1/history' });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual({ error: "Cannot delete download with status 'downloading' — use cancel instead" });
    });

    it('returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/activity/abc/history' });
      expect(res.statusCode).toBe(400);
    });

    it('returns 500 when service throws unexpected error', async () => {
      (services.download.delete as Mock).mockRejectedValue(new Error('db unavailable'));

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/1/history' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
    });
  });

  describe('DELETE /api/activity/history', () => {
    it('returns 200 { deleted: N } with count of deleted records', async () => {
      (services.download.deleteHistory as Mock).mockResolvedValue({ deleted: 3 });

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/history' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ deleted: 3 });
      expect(services.download.deleteHistory).toHaveBeenCalledWith();
    });

    it('returns 200 { deleted: 0 } when no history items exist', async () => {
      (services.download.deleteHistory as Mock).mockResolvedValue({ deleted: 0 });

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/history' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ deleted: 0 });
    });
  });

  describe('indexer name in responses (#57)', () => {
    describe('GET /api/activity', () => {
      it('includes indexerName in each download object', async () => {
        (services.download.getAll as Mock).mockResolvedValue({
          data: [{ ...mockDownload, indexerName: 'AudioBookBay' }],
          total: 1,
        });

        const res = await app.inject({ method: 'GET', url: '/api/activity' });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.data[0].indexerName).toBe('AudioBookBay');
      });

      it('returns indexerName: null for downloads with a deleted indexer', async () => {
        (services.download.getAll as Mock).mockResolvedValue({
          data: [{ ...mockDownload, indexerId: null, indexerName: null }],
          total: 1,
        });

        const res = await app.inject({ method: 'GET', url: '/api/activity' });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.data[0].indexerName).toBeNull();
      });
    });

    describe('GET /api/activity/active', () => {
      it('includes indexerName in response', async () => {
        (services.download.getActive as Mock).mockResolvedValue([
          { ...mockDownload, indexerName: 'AudioBookBay' },
        ]);

        const res = await app.inject({ method: 'GET', url: '/api/activity/active' });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body[0].indexerName).toBe('AudioBookBay');
      });
    });

    describe('GET /api/activity/:id', () => {
      it('returns indexerName for an existing indexer', async () => {
        (services.download.getById as Mock).mockResolvedValue({
          ...mockDownload,
          indexerName: 'AudioBookBay',
        });

        const res = await app.inject({ method: 'GET', url: '/api/activity/1' });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.indexerName).toBe('AudioBookBay');
      });

      it('returns indexerName: null for a deleted indexer', async () => {
        (services.download.getById as Mock).mockResolvedValue({
          ...mockDownload,
          indexerId: null,
          indexerName: null,
        });

        const res = await app.inject({ method: 'GET', url: '/api/activity/1' });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.indexerName).toBeNull();
      });
    });
  });

  // #301 — Reject endpoint with retry body field
  describe('POST /api/activity/:id/reject with retry flag (#301)', () => {
    it('passes retry=true from request body to orchestrator.reject(id, { retry: true })', async () => {
      (services.qualityGateOrchestrator.reject as Mock).mockResolvedValue({ id: 1, status: 'failed' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/activity/1/reject',
        payload: { retry: true },
      });

      expect(res.statusCode).toBe(200);
      expect(services.qualityGateOrchestrator.reject).toHaveBeenCalledWith(1, { retry: true });
    });

    it('defaults retry to false when body is empty — calls orchestrator.reject(id, { retry: false })', async () => {
      (services.qualityGateOrchestrator.reject as Mock).mockResolvedValue({ id: 1, status: 'failed' });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/reject' });

      expect(res.statusCode).toBe(200);
      expect(services.qualityGateOrchestrator.reject).toHaveBeenCalledWith(1, { retry: false });
    });

    it('defaults retry to false when body has no retry field — calls orchestrator.reject(id, { retry: false })', async () => {
      (services.qualityGateOrchestrator.reject as Mock).mockResolvedValue({ id: 1, status: 'failed' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/activity/1/reject',
        payload: { someOtherField: 'value' },
      });

      expect(res.statusCode).toBe(200);
      expect(services.qualityGateOrchestrator.reject).toHaveBeenCalledWith(1, { retry: false });
    });

    it('returns 400 when retry is a string instead of boolean', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/activity/1/reject',
        payload: { retry: 'true' },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload)).toEqual(expect.objectContaining({ error: 'Invalid request body' }));
      expect(services.qualityGateOrchestrator.reject).not.toHaveBeenCalled();
    });

    it('returns 409 for non-pending_review download with retry=true', async () => {
      (services.qualityGateOrchestrator.reject as Mock).mockRejectedValue(new QualityGateServiceError('Download is not pending review', 'INVALID_STATUS'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/activity/1/reject',
        payload: { retry: true },
      });

      expect(res.statusCode).toBe(409);
    });
  });
});
