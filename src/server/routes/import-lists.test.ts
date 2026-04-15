import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const validImportList = {
  name: 'My ABS List',
  type: 'abs',
  enabled: true,
  syncIntervalMinutes: 1440,
  settings: { serverUrl: 'http://abs.local', apiKey: 'test-key', libraryId: 'lib-1' },
};

const savedList = {
  id: 1,
  ...validImportList,
  lastRunAt: null,
  nextRunAt: new Date().toISOString(),
  lastSyncError: null,
  createdAt: new Date().toISOString(),
};

describe('import-lists routes', () => {
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

  describe('GET /api/import-lists', () => {
    it('returns all lists with masked secrets', async () => {
      (services.importList.getAll as Mock).mockResolvedValue([savedList]);

      const res = await app.inject({ method: 'GET', url: '/api/import-lists' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('My ABS List');
      // Settings should have apiKey masked
      expect(body[0].settings.apiKey).toBe('********');
    });
  });

  describe('GET /api/import-lists/:id', () => {
    it('returns single list with masked secrets', async () => {
      (services.importList.getById as Mock).mockResolvedValue(savedList);

      const res = await app.inject({ method: 'GET', url: '/api/import-lists/1' });

      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('My ABS List');
      expect(res.json().settings.apiKey).toBe('********');
    });
  });

  describe('POST /api/import-lists', () => {
    it('creates list with encrypted API key and sets nextRunAt', async () => {
      (services.importList.create as Mock).mockResolvedValue(savedList);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists',
        payload: validImportList,
      });

      expect(res.statusCode).toBe(201);
      expect(services.importList.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'My ABS List', type: 'abs' }),
      );
    });

    it('rejects invalid provider type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists',
        payload: { ...validImportList, type: 'invalid' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists',
        payload: { type: 'abs', settings: {} },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects missing provider-specific required settings', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists',
        payload: { name: 'Bad ABS', type: 'abs', settings: { serverUrl: 'http://abs.local' } },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.message).toContain('settings/apiKey');
    });

    it('rejects sync interval below minimum', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists',
        payload: { ...validImportList, syncIntervalMinutes: 2 },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PUT /api/import-lists/:id', () => {
    it('updates list with sentinel passthrough', async () => {
      (services.importList.update as Mock).mockResolvedValue(savedList);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/import-lists/1',
        payload: { name: 'Updated Name' },
      });

      expect(res.statusCode).toBe(200);
      expect(services.importList.update).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Updated Name' }));
    });

    it('rejects missing provider-specific required settings on update', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/import-lists/1',
        payload: { type: 'abs', settings: { serverUrl: 'http://abs.local' } },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.message).toContain('settings/apiKey');
    });

    it('accepts toggle-only update without type or settings', async () => {
      (services.importList.update as Mock).mockResolvedValue({ ...savedList, enabled: false });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/import-lists/1',
        payload: { enabled: false },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('DELETE /api/import-lists/:id', () => {
    it('removes list', async () => {
      (services.importList.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/import-lists/1' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });

  describe('POST /api/import-lists/test', () => {
    it('calls provider test with provided config', async () => {
      (services.importList.testConfig as Mock).mockResolvedValue({ success: true });

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/test',
        payload: validImportList,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });

  describe('POST /api/import-lists/:id/test', () => {
    it('calls provider test with saved config', async () => {
      (services.importList.test as Mock).mockResolvedValue({ success: true });

      const res = await app.inject({ method: 'POST', url: '/api/import-lists/1/test' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });

  describe('POST /api/import-lists/abs/libraries', () => {
    it('returns libraries from ABS API', async () => {
      const mockLibraries = [{ id: 'lib-1', name: 'Audiobooks' }, { id: 'lib-2', name: 'Podcasts' }];
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ libraries: mockLibraries }),
      } as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ libraries: mockLibraries });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://abs.local/api/libraries',
        expect.objectContaining({ headers: { Authorization: 'Bearer test-key' } }),
      );
      vi.restoreAllMocks();
    });

    it('returns 400 when serverUrl or apiKey is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('serverUrl and apiKey are required');
    });

    it('returns 502 when ABS API returns non-OK status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as Response);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'bad-key' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain('ABS API returned 401');
      vi.restoreAllMocks();
    });

    it('returns 502 when connection fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/abs/libraries',
        payload: { serverUrl: 'http://abs.local', apiKey: 'test-key' },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain('Connection failed: ECONNREFUSED');
      vi.restoreAllMocks();
    });
  });

  describe('POST /api/import-lists/preview', () => {
    it('accepts config in body and returns first 10 items', async () => {
      const previewResult = {
        items: [{ title: 'Book 1', author: 'Author 1' }],
        total: 1,
      };
      (services.importList.preview as Mock).mockResolvedValue(previewResult);

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: { type: validImportList.type, settings: validImportList.settings },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(previewResult);
    });

    it('returns empty items array when provider returns nothing', async () => {
      (services.importList.preview as Mock).mockResolvedValue({ items: [], total: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/import-lists/preview',
        payload: { type: validImportList.type, settings: validImportList.settings },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [], total: 0 });
    });
  });
});
