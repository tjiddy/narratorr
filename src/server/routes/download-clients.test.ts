import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockClient = {
  id: 1,
  name: 'qBittorrent',
  type: 'qbittorrent',
  enabled: true,
  priority: 50,
  settings: { host: 'localhost', port: 8080, username: 'admin', password: 'secret-pass', apiKey: 'client-key-456', useSsl: false },
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
    resetMockServices(services);
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

    it('returns 400 for invalid typed settings and does not call service.create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients',
        payload: { name: 'Bad', type: 'qbittorrent', settings: { port: 8080 } }, // missing host
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('settings/host');
      expect(services.downloadClient.create).not.toHaveBeenCalled();
    });
  });

  // ===== #263 — create with pathMappings =====

  describe('POST /api/download-clients with pathMappings', () => {
    it('creates client with path mappings and returns 201', async () => {
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
          pathMappings: [{ remotePath: '/remote/downloads', localPath: '/local/downloads' }],
        },
      });

      expect(res.statusCode).toBe(201);
      expect(services.downloadClient.create).toHaveBeenCalledWith(
        expect.objectContaining({
          pathMappings: [{ remotePath: '/remote/downloads', localPath: '/local/downloads' }],
        }),
      );
    });

    it('creates client only when pathMappings is empty array', async () => {
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
          pathMappings: [],
        },
      });

      expect(res.statusCode).toBe(201);
      expect(services.downloadClient.create).toHaveBeenCalledWith(
        expect.objectContaining({ pathMappings: [] }),
      );
    });

    it('creates client only when pathMappings is omitted', async () => {
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

    it('returns 400 for invalid pathMappings entries', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients',
        payload: {
          name: 'qBittorrent',
          type: 'qbittorrent',
          enabled: true,
          priority: 50,
          settings: { host: 'localhost', port: 8080 },
          pathMappings: [{ remotePath: '', localPath: '/local' }],
        },
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

    it('returns 400 when settings provided without type', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/download-clients/1',
        payload: { settings: { host: 'localhost', port: 8080 } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('type');
      expect(services.downloadClient.update).not.toHaveBeenCalled();
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

    // #827 — sentinel-laden body + valid id reaches the service (no schema 400)
    it('accepts sentinel in password with id and forwards to testConfig', async () => {
      (services.downloadClient.testConfig as Mock).mockResolvedValue({ success: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients/test',
        payload: {
          name: 'qb-edit',
          type: 'qbittorrent',
          enabled: true,
          priority: 50,
          settings: { host: 'h', port: 8080, password: '********' },
          id: 7,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(services.downloadClient.testConfig).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7 }),
      );
    });
  });

  describe('POST /api/download-clients/categories', () => {
    it('returns categories from config', async () => {
      (services.downloadClient.getCategoriesFromConfig as Mock).mockResolvedValue({ categories: ['audiobooks', 'movies'] });

      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients/categories',
        payload: {
          name: 'qBittorrent',
          type: 'qbittorrent',
          enabled: true,
          priority: 50,
          settings: { host: 'localhost', port: 8080 },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).categories).toEqual(['audiobooks', 'movies']);
    });

    it('returns 400 for invalid body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients/categories',
        payload: { name: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns error from service when fetch fails', async () => {
      (services.downloadClient.getCategoriesFromConfig as Mock).mockResolvedValue({ categories: [], error: 'Connection refused' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients/categories',
        payload: {
          name: 'qBittorrent',
          type: 'qbittorrent',
          enabled: true,
          priority: 50,
          settings: { host: 'localhost', port: 8080 },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.categories).toEqual([]);
      expect(body.error).toBe('Connection refused');
    });

    // ===== #844 — sentinel resolution =====

    it('resolves sentinel apiKey against persisted client and dispatches plaintext (sabnzbd)', async () => {
      (services.downloadClient.getById as Mock).mockResolvedValue({
        ...mockClient,
        type: 'sabnzbd',
        settings: { host: 'h', port: 8080, apiKey: 'real-sab-key' },
      });
      (services.downloadClient.getCategoriesFromConfig as Mock).mockResolvedValue({ categories: ['cat'] });

      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients/categories',
        payload: {
          name: 'sab', type: 'sabnzbd', enabled: true, priority: 50,
          settings: { host: 'h', port: 8080, apiKey: '********' },
          id: 1,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(services.downloadClient.getCategoriesFromConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'sabnzbd',
          settings: expect.objectContaining({ apiKey: 'real-sab-key' }),
        }),
      );
    });

    it('resolves sentinel password against persisted client (qbittorrent)', async () => {
      (services.downloadClient.getById as Mock).mockResolvedValue({
        ...mockClient,
        settings: { host: 'h', port: 8080, password: 'real-pw' },
      });
      (services.downloadClient.getCategoriesFromConfig as Mock).mockResolvedValue({ categories: [] });

      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients/categories',
        payload: {
          name: 'qb', type: 'qbittorrent', enabled: true, priority: 50,
          settings: { host: 'h', port: 8080, password: '********' },
          id: 1,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(services.downloadClient.getCategoriesFromConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ password: 'real-pw' }),
        }),
      );
    });

    it('returns 400 when sentinel apiKey is sent without id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients/categories',
        payload: {
          name: 'sab', type: 'sabnzbd', enabled: true, priority: 50,
          settings: { host: 'h', port: 8080, apiKey: '********' },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('id is required');
      expect(services.downloadClient.getCategoriesFromConfig).not.toHaveBeenCalled();
    });

    it('returns 404 when sentinel apiKey + id but client not found', async () => {
      (services.downloadClient.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients/categories',
        payload: {
          name: 'sab', type: 'sabnzbd', enabled: true, priority: 50,
          settings: { host: 'h', port: 8080, apiKey: '********' },
          id: 999,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error).toBe('Download client not found');
      expect(services.downloadClient.getCategoriesFromConfig).not.toHaveBeenCalled();
    });

    it('plaintext credentials bypass resolution and dispatch unchanged (no id required)', async () => {
      (services.downloadClient.getCategoriesFromConfig as Mock).mockResolvedValue({ categories: ['c'] });

      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients/categories',
        payload: {
          name: 'sab', type: 'sabnzbd', enabled: true, priority: 50,
          settings: { host: 'h', port: 8080, apiKey: 'real-key' },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(services.downloadClient.getCategoriesFromConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ apiKey: 'real-key' }),
        }),
      );
      expect(services.downloadClient.getById).not.toHaveBeenCalled();
    });

    it('returns 400 for sentinel on non-secret field (qbittorrent settings.host)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients/categories',
        payload: {
          name: 'qb', type: 'qbittorrent', enabled: true, priority: 50,
          settings: { host: '********', port: 8080, password: 'real-pw' },
          id: 1,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).error).toContain('non-secret field: host');
      expect(services.downloadClient.getCategoriesFromConfig).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/download-clients/:id/categories', () => {
    it('returns categories for saved client', async () => {
      (services.downloadClient.getCategories as Mock).mockResolvedValue({ categories: ['audiobooks'] });

      const res = await app.inject({ method: 'POST', url: '/api/download-clients/1/categories' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).categories).toEqual(['audiobooks']);
    });

    it('returns empty categories with error when client not found', async () => {
      (services.downloadClient.getCategories as Mock).mockResolvedValue({ categories: [], error: 'Download client not found' });

      const res = await app.inject({ method: 'POST', url: '/api/download-clients/999/categories' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.categories).toEqual([]);
      expect(body.error).toBe('Download client not found');
    });

    it('returns 500 when service throws', async () => {
      (services.downloadClient.getCategories as Mock).mockRejectedValue(new Error('Unexpected'));

      const res = await app.inject({ method: 'POST', url: '/api/download-clients/1/categories' });

      expect(res.statusCode).toBe(500);
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

  describe('secret field masking', () => {
    it('GET /api/download-clients masks password and apiKey in list response', async () => {
      (services.downloadClient.getAll as Mock).mockResolvedValue([mockClient]);

      const res = await app.inject({ method: 'GET', url: '/api/download-clients' });
      const body = JSON.parse(res.payload);

      expect(body[0].settings.password).toBe('********');
      expect(body[0].settings.apiKey).toBe('********');
      expect(body[0].settings.host).toBe('localhost');
      expect(body[0].settings.port).toBe(8080);
    });

    it('GET /api/download-clients/:id masks secret fields in detail response', async () => {
      (services.downloadClient.getById as Mock).mockResolvedValue(mockClient);

      const res = await app.inject({ method: 'GET', url: '/api/download-clients/1' });
      const body = JSON.parse(res.payload);

      expect(body.settings.password).toBe('********');
      expect(body.settings.apiKey).toBe('********');
      expect(body.settings.host).toBe('localhost');
    });

    it('POST /api/download-clients masks secret fields in create response', async () => {
      (services.downloadClient.create as Mock).mockResolvedValue(mockClient);

      const res = await app.inject({
        method: 'POST',
        url: '/api/download-clients',
        payload: {
          name: 'qBittorrent',
          type: 'qbittorrent',
          enabled: true,
          priority: 50,
          settings: { host: 'localhost', port: 8080, password: 'new-pass' },
        },
      });
      const body = JSON.parse(res.payload);

      expect(res.statusCode).toBe(201);
      expect(body.settings.password).toBe('********');
      expect(body.settings.apiKey).toBe('********');
    });

    it('PUT /api/download-clients/:id masks secret fields in update response', async () => {
      (services.downloadClient.update as Mock).mockResolvedValue(mockClient);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/download-clients/1',
        payload: { name: 'Renamed' },
      });
      const body = JSON.parse(res.payload);

      expect(res.statusCode).toBe(200);
      expect(body.settings.password).toBe('********');
      expect(body.settings.apiKey).toBe('********');
    });
  });
});
