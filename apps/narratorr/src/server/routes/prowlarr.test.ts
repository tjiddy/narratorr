import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockServices } from '../__tests__/helpers.js';
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
    Object.values(services).forEach((svc) => {
      Object.values(svc).forEach((fn) => {
        if (typeof fn === 'function' && 'mockReset' in fn) {
          (fn as any).mockReset();
        }
      });
    });
  });

  describe('POST /api/prowlarr/test', () => {
    it('returns success on valid connection', async () => {
      (services.prowlarrSync.testConnection as any).mockResolvedValue({ success: true });

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
      (services.prowlarrSync.getConfig as any).mockResolvedValue(mockConfig);

      const res = await app.inject({ method: 'GET', url: '/api/prowlarr/config' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual(mockConfig);
    });

    it('returns 404 when not configured', async () => {
      (services.prowlarrSync.getConfig as any).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/prowlarr/config' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('PUT /api/prowlarr/config', () => {
    it('saves and returns config', async () => {
      (services.prowlarrSync.saveConfig as any).mockResolvedValue(undefined);

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
      (services.prowlarrSync.getConfig as any).mockResolvedValue(mockConfig);
      (services.prowlarrSync.preview as any).mockResolvedValue(mockPreview);

      const res = await app.inject({
        method: 'POST',
        url: '/api/prowlarr/preview',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveLength(2);
    });

    it('returns 400 when not configured', async () => {
      (services.prowlarrSync.getConfig as any).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/prowlarr/preview',
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/prowlarr/sync', () => {
    it('applies sync and returns result', async () => {
      (services.prowlarrSync.getConfig as any).mockResolvedValue(mockConfig);
      (services.prowlarrSync.apply as any).mockResolvedValue({ added: 1, updated: 0, removed: 0 });

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
      (services.prowlarrSync.getConfig as any).mockResolvedValue(null);

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
});
