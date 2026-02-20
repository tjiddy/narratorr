import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockIndexer = {
  id: 1,
  name: 'AudioBookBay',
  type: 'abb',
  enabled: true,
  priority: 50,
  settings: { hostname: 'audiobookbay.lu', pageLimit: 2 },
  createdAt: new Date(),
};

describe('indexers routes', () => {
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
          (fn as Mock).mockReset();
        }
      });
    });
  });

  describe('GET /api/indexers', () => {
    it('returns all indexers', async () => {
      (services.indexer.getAll as Mock).mockResolvedValue([mockIndexer]);

      const res = await app.inject({ method: 'GET', url: '/api/indexers' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveLength(1);
    });
  });

  describe('GET /api/indexers/:id', () => {
    it('returns indexer when found', async () => {
      (services.indexer.getById as Mock).mockResolvedValue(mockIndexer);

      const res = await app.inject({ method: 'GET', url: '/api/indexers/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).name).toBe('AudioBookBay');
    });

    it('returns 404 when not found', async () => {
      (services.indexer.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/indexers/999' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/indexers', () => {
    it('creates indexer and returns 201', async () => {
      (services.indexer.create as Mock).mockResolvedValue(mockIndexer);

      const res = await app.inject({
        method: 'POST',
        url: '/api/indexers',
        payload: {
          name: 'AudioBookBay',
          type: 'abb',
          enabled: true,
          priority: 50,
          settings: { hostname: 'audiobookbay.lu', pageLimit: 2 },
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 400 for invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/indexers',
        payload: { name: '' }, // missing required fields
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PUT /api/indexers/:id', () => {
    it('updates indexer when found', async () => {
      (services.indexer.update as Mock).mockResolvedValue({ ...mockIndexer, name: 'Updated' });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/indexers/1',
        payload: { name: 'Updated' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 404 when not found', async () => {
      (services.indexer.update as Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/indexers/999',
        payload: { name: 'Nope' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/indexers/:id', () => {
    it('deletes indexer and returns success', async () => {
      (services.indexer.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/indexers/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);
    });

    it('returns 404 when not found', async () => {
      (services.indexer.delete as Mock).mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/indexers/999' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/indexers/test', () => {
    it('returns test result for config payload', async () => {
      (services.indexer.testConfig as Mock).mockResolvedValue({ success: true, message: 'Connected' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/indexers/test',
        payload: {
          name: 'AudioBookBay',
          type: 'abb',
          enabled: true,
          priority: 50,
          settings: { hostname: 'audiobookbay.lu', pageLimit: 2 },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);
      expect(services.indexer.testConfig).toHaveBeenCalledWith({
        type: 'abb',
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2 },
      });
    });

    it('returns 400 for invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/indexers/test',
        payload: { name: '' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/indexers/:id/test', () => {
    it('returns test result', async () => {
      (services.indexer.test as Mock).mockResolvedValue({ success: true, message: 'Connected' });

      const res = await app.inject({ method: 'POST', url: '/api/indexers/1/test' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);
    });
  });
});
