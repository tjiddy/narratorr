import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockConfig = {
  url: 'https://prowlarr.test',
  apiKey: 'test-key',
  syncMode: 'addOnly',
  categories: [3030],
};

const mockPreview = [
  { action: 'new', name: 'NZBGeek', type: 'newznab', prowlarrId: 1 },
  { action: 'unchanged', name: 'Existing', type: 'torznab', prowlarrId: 2, localId: 10 },
];

describe('prowlarr routes', () => {
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

  describe('POST /api/prowlarr/test', () => {
    it('returns success on valid connection', async () => {
      (services.prowlarrSync.testConnection as Mock).mockResolvedValue({ success: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/prowlarr/test',
        payload: { url: 'https://prowlarr.test', apiKey: 'key' },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: true });
    });

    it('returns 400 on missing url', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/prowlarr/test',
        payload: { apiKey: 'key' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 on missing apiKey', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/prowlarr/test',
        payload: { url: 'https://prowlarr.test' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/prowlarr/config', () => {
    it('returns config when configured', async () => {
      (services.prowlarrSync.getConfig as Mock).mockResolvedValue(mockConfig);

      const res = await app.inject({ method: 'GET', url: '/api/prowlarr/config' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual(mockConfig);
    });

    it('returns 404 when not configured', async () => {
      (services.prowlarrSync.getConfig as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/prowlarr/config' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('PUT /api/prowlarr/config', () => {
    it('saves and returns config', async () => {
      (services.prowlarrSync.saveConfig as Mock).mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/prowlarr/config',
        payload: mockConfig,
      });

      expect(res.statusCode).toBe(200);
      expect(services.prowlarrSync.saveConfig).toHaveBeenCalled();
    });

    it('returns 400 on invalid config', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/prowlarr/config',
        payload: { url: '', apiKey: '' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/prowlarr/preview', () => {
    it('returns preview items', async () => {
      (services.prowlarrSync.getConfig as Mock).mockResolvedValue(mockConfig);
      (services.prowlarrSync.preview as Mock).mockResolvedValue(mockPreview);

      const res = await app.inject({
        method: 'POST',
        url: '/api/prowlarr/preview',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveLength(2);
    });

    it('returns 400 when not configured', async () => {
      (services.prowlarrSync.getConfig as Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/prowlarr/preview',
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/prowlarr/sync', () => {
    it('applies sync and returns result', async () => {
      (services.prowlarrSync.getConfig as Mock).mockResolvedValue(mockConfig);
      (services.prowlarrSync.apply as Mock).mockResolvedValue({ added: 1, updated: 0, removed: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/prowlarr/sync',
        payload: {
          items: [{ prowlarrId: 1, action: 'new', selected: true }],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ added: 1, updated: 0, removed: 0 });
    });

    it('returns 400 when not configured', async () => {
      (services.prowlarrSync.getConfig as Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/prowlarr/sync',
        payload: {
          items: [{ prowlarrId: 1, action: 'new', selected: true }],
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('error paths', () => {
    it('POST /test returns 500 when testConnection throws', async () => {
      (services.prowlarrSync.testConnection as Mock).mockRejectedValue(new Error('ECONNREFUSED'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/prowlarr/test',
        payload: { url: 'https://prowlarr.test', apiKey: 'key' },
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ success: false, message: 'ECONNREFUSED' });
    });

    it('GET /config returns 500 when getConfig throws', async () => {
      (services.prowlarrSync.getConfig as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'GET', url: '/api/prowlarr/config' });

      expect(res.statusCode).toBe(500);
    });

    it('PUT /config returns 500 when saveConfig throws', async () => {
      (services.prowlarrSync.saveConfig as Mock).mockRejectedValue(new Error('Write failed'));

      const res = await app.inject({
        method: 'PUT',
        url: '/api/prowlarr/config',
        payload: mockConfig,
      });

      expect(res.statusCode).toBe(500);
    });

    it('POST /preview returns 500 when preview throws', async () => {
      (services.prowlarrSync.getConfig as Mock).mockResolvedValue(mockConfig);
      (services.prowlarrSync.preview as Mock).mockRejectedValue(new Error('API unreachable'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/prowlarr/preview',
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'API unreachable' });
    });

    it('POST /sync returns 500 when apply throws', async () => {
      (services.prowlarrSync.getConfig as Mock).mockResolvedValue(mockConfig);
      (services.prowlarrSync.apply as Mock).mockRejectedValue(new Error('Partial sync failure'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/prowlarr/sync',
        payload: {
          items: [{ prowlarrId: 1, action: 'new', selected: true }],
        },
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Partial sync failure' });
    });
  });
});
