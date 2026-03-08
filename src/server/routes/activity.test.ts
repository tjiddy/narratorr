import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

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

  describe('GET /api/activity', () => {
    it('returns all downloads', async () => {
      (services.download.getAll as Mock).mockResolvedValue([mockDownload]);

      const res = await app.inject({ method: 'GET', url: '/api/activity' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveLength(1);
    });

    it('passes status filter', async () => {
      (services.download.getAll as Mock).mockResolvedValue([]);

      await app.inject({ method: 'GET', url: '/api/activity?status=downloading' });

      expect(services.download.getAll).toHaveBeenCalledWith('downloading');
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
