import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import type { Mock } from 'vitest';

describe('remote-path-mappings routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  const mockMapping = {
    id: 1,
    downloadClientId: 1,
    remotePath: '/downloads/complete/',
    localPath: 'C:\\downloads\\',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

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

  describe('GET /api/remote-path-mappings', () => {
    it('returns all mappings', async () => {
      (services.remotePathMapping.getAll as Mock).mockResolvedValue([mockMapping]);

      const res = await app.inject({ method: 'GET', url: '/api/remote-path-mappings' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveLength(1);
    });

    it('filters by downloadClientId query param', async () => {
      (services.remotePathMapping.getByClientId as Mock).mockResolvedValue([mockMapping]);

      const res = await app.inject({ method: 'GET', url: '/api/remote-path-mappings?downloadClientId=1' });

      expect(res.statusCode).toBe(200);
      expect(services.remotePathMapping.getByClientId).toHaveBeenCalledWith(1);
    });
  });

  describe('POST /api/remote-path-mappings', () => {
    it('creates mapping and returns 201', async () => {
      (services.remotePathMapping.create as Mock).mockResolvedValue(mockMapping);

      const res = await app.inject({
        method: 'POST',
        url: '/api/remote-path-mappings',
        payload: {
          downloadClientId: 1,
          remotePath: '/downloads/complete/',
          localPath: 'C:\\downloads\\',
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 400 for missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/remote-path-mappings',
        payload: { downloadClientId: -1 },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PUT /api/remote-path-mappings/:id', () => {
    it('updates mapping', async () => {
      (services.remotePathMapping.update as Mock).mockResolvedValue(mockMapping);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/remote-path-mappings/1',
        payload: { remotePath: '/new/path/' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 404 when not found', async () => {
      (services.remotePathMapping.update as Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/remote-path-mappings/999',
        payload: { remotePath: '/new/path/' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/remote-path-mappings/:id', () => {
    it('deletes mapping when found', async () => {
      (services.remotePathMapping.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/remote-path-mappings/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);
    });

    it('returns 404 when not found', async () => {
      (services.remotePathMapping.delete as Mock).mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/remote-path-mappings/999' });

      expect(res.statusCode).toBe(404);
    });
  });
});
