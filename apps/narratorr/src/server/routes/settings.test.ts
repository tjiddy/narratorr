import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockSettings = {
  library: { path: '/audiobooks', folderFormat: '{author}/{title}' },
  search: { intervalMinutes: 360, enabled: true },
  import: { deleteAfterImport: false, minSeedTime: 60 },
  general: { logLevel: 'info' },
};

describe('settings routes', () => {
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

  describe('GET /api/settings', () => {
    it('returns all settings', async () => {
      (services.settings.getAll as Mock).mockResolvedValue(mockSettings);

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.library.path).toBe('/audiobooks');
      expect(body.search.enabled).toBe(true);
    });
  });

  describe('PUT /api/settings', () => {
    it('updates settings', async () => {
      const updated = { ...mockSettings, library: { path: '/new', folderFormat: '{title}' } };
      (services.settings.update as Mock).mockResolvedValue(updated);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { library: { path: '/new', folderFormat: '{title}' } },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).library.path).toBe('/new');
    });

    it('accepts partial updates', async () => {
      (services.settings.update as Mock).mockResolvedValue(mockSettings);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { search: { enabled: false } },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('error paths', () => {
    it('GET /api/settings returns 500 when service throws', async () => {
      (services.settings.getAll as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(500);
    });

    it('PUT /api/settings returns 500 when service throws', async () => {
      (services.settings.update as Mock).mockRejectedValue(new Error('Upsert failed'));

      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { library: { path: '/new' } },
      });

      expect(res.statusCode).toBe(500);
    });
  });
});
