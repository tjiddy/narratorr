import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockClient = {
  id: 1,
  name: 'qBittorrent',
  type: 'qbittorrent',
  enabled: true,
  priority: 50,
  settings: { host: 'localhost', port: 8080, username: 'admin', password: '', useSsl: false },
  createdAt: new Date(),
};

describe('download-clients routes', () => {
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

  describe('GET /api/download-clients', () => {
    it('returns all clients', async () => {
      (services.downloadClient.getAll as Mock).mockResolvedValue([mockClient]);

      const res = await app.inject({ method: 'GET', url: '/api/download-clients' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveLength(1);
    });
  });

  describe('GET /api/download-clients/:id', () => {
    it('returns client when found', async () => {
      (services.downloadClient.getById as Mock).mockResolvedValue(mockClient);

      const res = await app.inject({ method: 'GET', url: '/api/download-clients/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).name).toBe('qBittorrent');
    });

    it('returns 404 when not found', async () => {
      (services.downloadClient.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/download-clients/999' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/download-clients', () => {
    it('creates client and returns 201', async () => {
      (services.downloadClient.create as Mock).mockResolvedValue(mockClient);

      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients',
        payload: {
          name: 'qBittorrent',
          type: 'qbittorrent',
          enabled: true,
          priority: 50,
          settings: { host: 'localhost', port: 8080 },
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 400 for invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients',
        payload: { name: '' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PUT /api/download-clients/:id', () => {
    it('updates client when found', async () => {
      (services.downloadClient.update as Mock).mockResolvedValue(mockClient);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/download-clients/1',
        payload: { name: 'Renamed' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('returns 404 when not found', async () => {
      (services.downloadClient.update as Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/download-clients/999',
        payload: { name: 'Nope' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/download-clients/:id', () => {
    it('deletes client and returns success', async () => {
      (services.downloadClient.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/download-clients/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);
    });

    it('returns 404 when not found', async () => {
      (services.downloadClient.delete as Mock).mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/download-clients/999' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/download-clients/test', () => {
    it('returns test result for config payload', async () => {
      (services.downloadClient.testConfig as Mock).mockResolvedValue({ success: true, message: 'Connected' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients/test',
        payload: {
          name: 'qBittorrent',
          type: 'qbittorrent',
          enabled: true,
          priority: 50,
          settings: { host: 'localhost', port: 8080 },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);
      expect(services.downloadClient.testConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'qbittorrent',
          settings: expect.objectContaining({ host: 'localhost', port: 8080 }),
        }),
      );
    });

    it('returns 400 for invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients/test',
        payload: { name: '' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/download-clients/:id/test', () => {
    it('returns test result', async () => {
      (services.downloadClient.test as Mock).mockResolvedValue({ success: true });

      const res = await app.inject({ method: 'POST', url: '/api/download-clients/1/test' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).success).toBe(true);
    });
  });
});
