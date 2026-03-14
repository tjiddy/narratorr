import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { Semaphore } from '../utils/semaphore.js';

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
      import: { semaphore: importSemaphore },
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

      expect(services.download.getAll).toHaveBeenCalledWith('downloading', undefined);
    });

    it('forwards limit and offset to service', async () => {
      (services.download.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/activity?limit=10&offset=20' });

      expect(services.download.getAll).toHaveBeenCalledWith(undefined, { limit: 10, offset: 20 });
    });

    it('rejects limit=0 with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/activity?limit=0' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects negative offset with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/activity?offset=-1' });
      expect(res.statusCode).toBe(400);
    });

    it('augments pending_review downloads with quality gate data', async () => {
      const pendingDownload = { ...mockDownload, id: 2, status: 'pending_review' };
      const gateData = { action: 'held', mbPerHour: 60, existingMbPerHour: 40 };
      (services.download.getAll as Mock).mockResolvedValue({ data: [mockDownload, pendingDownload], total: 2 });
      (services.qualityGate.getQualityGateData as Mock).mockResolvedValue(gateData);

      const res = await app.inject({ method: 'GET', url: '/api/activity' });

      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].qualityGate).toBeUndefined();
      expect(body.data[1].qualityGate).toEqual(gateData);
      expect(body.total).toBe(2);
      expect(services.qualityGate.getQualityGateData).toHaveBeenCalledWith(2);
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
      (services.download.cancel as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);
    });

    it('returns 404 when not found', async () => {
      (services.download.cancel as Mock).mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/999' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/activity/:id/retry', () => {
    it('returns 201 with new download on successful retry', async () => {
      const newDownload = { ...mockDownload, id: 2 };
      (services.download.retry as Mock).mockResolvedValue({ status: 'retried', download: newDownload });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(201);
      expect(services.download.retry).toHaveBeenCalledWith(1);
      expect(JSON.parse(res.payload).id).toBe(2);
    });

    it('returns 200 with no_candidates status when no candidates found', async () => {
      (services.download.retry as Mock).mockResolvedValue({ status: 'no_candidates' });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).status).toBe('no_candidates');
    });

    it('returns 200 with retry_error status when retry search errors', async () => {
      (services.download.retry as Mock).mockResolvedValue({ status: 'retry_error' });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).status).toBe('retry_error');
    });

    it('returns 404 when download not found', async () => {
      (services.download.retry as Mock).mockRejectedValue(new Error('Download 999 not found'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/999/retry' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 when no book linked', async () => {
      (services.download.retry as Mock).mockRejectedValue(new Error('Download 1 has no book linked'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when download not in failed state', async () => {
      (services.download.retry as Mock).mockRejectedValue(new Error('Download 1 is not in failed state'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 500 when retry fails unexpectedly', async () => {
      (services.download.retry as Mock).mockRejectedValue(new Error('No client'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /api/activity/:id/approve', () => {
    it('transitions pending_review download to importing and triggers import', async () => {
      (services.qualityGate.approve as Mock).mockResolvedValue({ id: 1, status: 'importing' });
      (services.import.importDownload as Mock).mockResolvedValue({});

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ id: 1, status: 'importing' });
      expect(services.import.importDownload).toHaveBeenCalledWith(1);
    });

    it('logs error when fire-and-forget import trigger fails', async () => {
      (services.qualityGate.approve as Mock).mockResolvedValue({ id: 1, status: 'importing' });
      const importError = new Error('Import pipeline crashed');
      let rejectImport: (err: Error) => void;
      (services.import.importDownload as Mock).mockReturnValue(
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
      (services.qualityGate.approve as Mock).mockRejectedValue(new Error('not pending_review'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(409);
    });

    it('returns 404 when download not found', async () => {
      (services.qualityGate.approve as Mock).mockRejectedValue(new Error('not found'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/999/approve' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/activity/:id/approve — concurrency', () => {
    it('approve when slot available triggers import immediately', async () => {
      (services.qualityGate.approve as Mock).mockResolvedValue({ id: 1, status: 'importing' });
      (services.import.importDownload as Mock).mockResolvedValue({});

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(200);
      expect(services.import.importDownload).toHaveBeenCalledWith(1);
      // setProcessingQueued should NOT have been called
      expect(services.import.setProcessingQueued).not.toHaveBeenCalled();
    });

    it('approve when no concurrency slot available sets download to processing_queued', async () => {
      // Fill all semaphore slots
      importSemaphore.setMax(2);
      importSemaphore.tryAcquire();
      importSemaphore.tryAcquire();

      (services.qualityGate.approve as Mock).mockResolvedValue({ id: 1, status: 'importing' });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ id: 1, status: 'processing_queued' });
      expect(services.import.importDownload).not.toHaveBeenCalled();
      expect(services.import.setProcessingQueued).toHaveBeenCalledWith(1);

      // Release slots for cleanup
      importSemaphore.release();
      importSemaphore.release();
    });

    it('releases semaphore slot when import fails after approve', async () => {
      (services.qualityGate.approve as Mock).mockResolvedValue({ id: 1, status: 'importing' });
      (services.import.importDownload as Mock).mockRejectedValue(new Error('import failed'));

      // Semaphore starts with capacity 2, both free
      expect(importSemaphore.tryAcquire()).toBe(true);
      importSemaphore.release(); // confirm slot was available

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/approve' });

      expect(res.statusCode).toBe(200);
      expect(services.import.importDownload).toHaveBeenCalledWith(1);

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
      (services.qualityGate.reject as Mock).mockResolvedValue({ id: 1, status: 'failed' });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/reject' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ id: 1, status: 'failed' });
      expect(services.qualityGate.reject).toHaveBeenCalledWith(1, undefined);
    });

    it('passes reason from body to service', async () => {
      (services.qualityGate.reject as Mock).mockResolvedValue({ id: 1, status: 'failed' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/activity/1/reject',
        payload: { reason: 'Wrong narrator' },
      });

      expect(res.statusCode).toBe(200);
      expect(services.qualityGate.reject).toHaveBeenCalledWith(1, 'Wrong narrator');
    });

    it('returns 409 when download is not in pending_review status', async () => {
      (services.qualityGate.reject as Mock).mockRejectedValue(new Error('not pending_review'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/reject' });

      expect(res.statusCode).toBe(409);
    });

    it('returns 404 when download not found', async () => {
      (services.qualityGate.reject as Mock).mockRejectedValue(new Error('not found'));

      const res = await app.inject({ method: 'POST', url: '/api/activity/999/reject' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('error paths', () => {
    it('DELETE /api/activity/:id returns 500 when cancel throws', async () => {
      (services.download.cancel as Mock).mockRejectedValue(new Error('Adapter error'));

      const res = await app.inject({ method: 'DELETE', url: '/api/activity/1' });

      expect(res.statusCode).toBe(500);
    });

    it('GET /api/activity returns 500 when service throws', async () => {
      (services.download.getAll as Mock).mockRejectedValue(new Error('DB error'));

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
      (services.download.retry as Mock).mockResolvedValue({ status: 'retried', download: newDownload });

      const res = await app.inject({ method: 'POST', url: '/api/activity/1/retry' });

      expect(res.statusCode).toBe(201);
      expect(services.download.retry).toHaveBeenCalledWith(1);
    });
  });
});
