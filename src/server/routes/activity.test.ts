import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { Semaphore } from '../utils/semaphore.js';
import { QualityGateServiceError } from '../services/quality-gate.service.js';

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
};

describe('activity routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;
  const importSemaphore = new Semaphore(2);

  beforeAll(async () => {
    services = createMockServices({
      import: {
        tryAcquireSlot: () => importSemaphore.tryAcquire(),
        releaseSlot: () => importSemaphore.release(),
      },
    });
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
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
      (services.downloadOrchestrator.retry as Mock).mockRejectedValue(new Error('Download 999 not found'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/999/retry' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when no book linked', async () => {
      (services.downloadOrchestrator.retry as Mock).mockRejectedValue(new Error('Download 1 has no book linked'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when download not in failed state', async () => {
      (services.downloadOrchestrator.retry as Mock).mockRejectedValue(new Error('Download 1 is not in failed state'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 500 when retry fails unexpectedly', async () => {
      (services.downloadOrchestrator.retry as Mock).mockRejectedValue(new Error('No client'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /api/activity/:id/approve', () => {
    it('transitions pending_review download to importing and triggers import', async () => {
      (services.qualityGateOrchestrator.approve as Mock).mockResolvedValue({ id: 1, status: 'importing' });
      (services.importOrchestrator.importDownload as Mock).mockResolvedValue({});

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ id: 1, status: 'importing' });
      expect(services.importOrchestrator.importDownload).toHaveBeenCalledWith(1);
    });

    it('logs error when fire-and-forget import trigger fails', async () => {
      (services.qualityGateOrchestrator.approve as Mock).mockResolvedValue({ id: 1, status: 'importing' });
      const importError = new Error('Import pipeline crashed');
      let rejectImport: (err: Error) => void;
      (services.importOrchestrator.importDownload as Mock).mockReturnValue(
        new Promise((_resolve, reject) => { rejectImport = reject; })
      );

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      // Response should succeed regardless of import failure
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ id: 1, status: 'importing' });

      // Trigger the rejection and verify it doesn't throw unhandled
      rejectImport!(importError);
      // Allow microtask queue to flush the .catch handler
      await new Promise((r) => setTimeout(r, 10));
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

  describe('POST /api/activity/:id/approve — concurrency', () => {
    it('approve when slot available triggers import immediately', async () => {
      (services.qualityGateOrchestrator.approve as Mock).mockResolvedValue({ id: 1, status: 'importing' });
      (services.importOrchestrator.importDownload as Mock).mockResolvedValue({});

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(200);
      expect(services.importOrchestrator.importDownload).toHaveBeenCalledWith(1);
      // setProcessingQueued should NOT have been called
      expect(services.import.setProcessingQueued).not.toHaveBeenCalled();
    });

    it('approve when no concurrency slot available sets download to processing_queued', async () => {
      // Fill all semaphore slots
      importSemaphore.setMax(2);
      importSemaphore.tryAcquire();
      importSemaphore.tryAcquire();

      (services.qualityGateOrchestrator.approve as Mock).mockResolvedValue({ id: 1, status: 'importing' });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ id: 1, status: 'processing_queued' });
      expect(services.importOrchestrator.importDownload).not.toHaveBeenCalled();
      expect(services.import.setProcessingQueued).toHaveBeenCalledWith(1);

      // Release slots for cleanup
      importSemaphore.release();
      importSemaphore.release();
    });

    it('releases semaphore slot when import fails after approve', async () => {
      (services.qualityGateOrchestrator.approve as Mock).mockResolvedValue({ id: 1, status: 'importing' });
      (services.importOrchestrator.importDownload as Mock).mockRejectedValue(new Error('import failed'));

      // Semaphore starts with capacity 2, both free
      expect(importSemaphore.tryAcquire()).toBe(true);
      importSemaphore.release(); // confirm slot was available

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(200);
      expect(services.importOrchestrator.importDownload).toHaveBeenCalledWith(1);

      // Wait for fire-and-forget promise to settle
      await new Promise(resolve => setTimeout(resolve, 10));

      // Semaphore slot should be released despite import failure
      // If we can acquire 2 slots, all capacity is free (none leaked)
      expect(importSemaphore.tryAcquire()).toBe(true);
      expect(importSemaphore.tryAcquire()).toBe(true);
      importSemaphore.release();
      importSemaphore.release();
    });
  });

  describe('POST /api/activity/:id/reject', () => {
    it('transitions pending_review download to failed', async () => {
      (services.qualityGateOrchestrator.reject as Mock).mockResolvedValue({ id: 1, status: 'failed' });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/reject' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ id: 1, status: 'failed' });
      expect(services.qualityGateOrchestrator.reject).toHaveBeenCalledWith(1);
    });

    it('ignores reason in body — parameter was removed (L-11)', async () => {
      (services.qualityGateOrchestrator.reject as Mock).mockResolvedValue({ id: 1, status: 'failed' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/activity/1/reject',
        payload: { reason: 'Wrong narrator' },
      });

      expect(res.statusCode).toBe(200);
      // reject() should only receive downloadId, not reason
      expect(services.qualityGateOrchestrator.reject).toHaveBeenCalledWith(1);
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
        new Error("Cannot delete download with status 'downloading' — use cancel instead"),
      );

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/1/history' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for NaN id', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/activity/abc/history' });
      expect(res.statusCode).toBe(400);
    });

    it('returns 500 when service throws unexpected error', async () => {
      (services.download.delete as Mock).mockRejectedValue(new Error('db unavailable'));

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/1/history' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'db unavailable' });
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
});
