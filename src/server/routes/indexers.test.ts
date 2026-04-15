import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockIndexer = {
  id: 1,
  name: 'AudioBookBay',
  type: 'abb',
  enabled: true,
  priority: 50,
  settings: { hostname: 'audiobookbay.lu', pageLimit: 2, apiKey: 'secret-key-123', flareSolverrUrl: 'http://flaresolverr:8191' },
  source: null,
  sourceIndexerId: null,
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
    resetMockServices(services);
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

    it('returns 400 for invalid typed settings and does not call service.create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/indexers',
        payload: { name: 'Bad', type: 'newznab', settings: { apiKey: 'key' } }, // missing apiUrl
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('settings/apiUrl');
      expect(services.indexer.create).not.toHaveBeenCalled();
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

    it('returns 400 when settings provided without type', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/indexers/1',
        payload: { settings: { apiUrl: 'https://test', apiKey: 'key' } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('type');
      expect(services.indexer.update).not.toHaveBeenCalled();
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

    it('passes through ip when proxy is used', async () => {
      (services.indexer.testConfig as Mock).mockResolvedValue({
        success: true,
        message: 'Connected via proxy',
        ip: '203.0.113.42',
      });

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
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.ip).toBe('203.0.113.42');
    });

    it('#317 passes through metadata in testConfig response', async () => {
      (services.indexer.testConfig as Mock).mockResolvedValue({
        success: true,
        message: 'Connected as VipUser',
        metadata: { username: 'VipUser', classname: 'VIP', isVip: true },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/indexers/test',
        payload: {
          name: 'MAM',
          type: 'myanonamouse',
          enabled: true,
          priority: 50,
          settings: { mamId: 'test-id' },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.metadata).toEqual({ username: 'VipUser', classname: 'VIP', isVip: true });
    });

    it('#339 forwards optional id to service.testConfig when present in body', async () => {
      (services.indexer.testConfig as Mock).mockResolvedValue({ success: true, message: 'OK' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/indexers/test',
        payload: {
          name: 'MAM',
          type: 'myanonamouse',
          enabled: true,
          priority: 50,
          settings: { mamId: '********' },
          id: 5,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(services.indexer.testConfig).toHaveBeenCalledWith({
        type: 'myanonamouse',
        settings: { mamId: '********' },
        id: 5,
      });
    });

    it('#339 omits id from service.testConfig call when not present in body', async () => {
      (services.indexer.testConfig as Mock).mockResolvedValue({ success: true, message: 'OK' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/indexers/test',
        payload: {
          name: 'MAM',
          type: 'myanonamouse',
          enabled: true,
          priority: 50,
          settings: { mamId: 'real-id' },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(services.indexer.testConfig).toHaveBeenCalledWith({
        type: 'myanonamouse',
        settings: { mamId: 'real-id' },
      });
    });

    it('#339 rejects negative id values in test body with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/indexers/test',
        payload: {
          name: 'MAM',
          type: 'myanonamouse',
          enabled: true,
          priority: 50,
          settings: { mamId: 'test-id' },
          id: -1,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(services.indexer.testConfig).not.toHaveBeenCalled();
    });

    it('#339 rejects non-integer id values in test body with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/indexers/test',
        payload: {
          name: 'MAM',
          type: 'myanonamouse',
          enabled: true,
          priority: 50,
          settings: { mamId: 'test-id' },
          id: 1.5,
        },
      });

      expect(res.statusCode).toBe(400);
      expect(services.indexer.testConfig).not.toHaveBeenCalled();
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

    it('passes through ip when proxy is used', async () => {
      (services.indexer.test as Mock).mockResolvedValue({
        success: true,
        message: 'Connected via proxy',
        ip: '203.0.113.42',
      });

      const res = await app.inject({ method: 'POST', url: '/api/indexers/1/test' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.ip).toBe('203.0.113.42');
    });

    it('#317 passes through metadata in test-by-ID response', async () => {
      (services.indexer.test as Mock).mockResolvedValue({
        success: true,
        message: 'Connected as VipUser',
        metadata: { username: 'VipUser', classname: 'VIP', isVip: true },
      });

      const res = await app.inject({ method: 'POST', url: '/api/indexers/1/test' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.metadata).toEqual({ username: 'VipUser', classname: 'VIP', isVip: true });
    });
  });

  describe('secret field masking', () => {
    it('GET /api/indexers masks apiKey and flareSolverrUrl in list response', async () => {
      (services.indexer.getAll as Mock).mockResolvedValue([mockIndexer]);

      const res = await app.inject({ method: 'GET', url: '/api/indexers' });
      const body = JSON.parse(res.payload);

      expect(body[0].settings.apiKey).toBe('********');
      expect(body[0].settings.flareSolverrUrl).toBe('********');
      expect(body[0].settings.hostname).toBe('audiobookbay.lu');
    });

    it('GET /api/indexers/:id masks secret fields in detail response', async () => {
      (services.indexer.getById as Mock).mockResolvedValue(mockIndexer);

      const res = await app.inject({ method: 'GET', url: '/api/indexers/1' });
      const body = JSON.parse(res.payload);

      expect(body.settings.apiKey).toBe('********');
      expect(body.settings.flareSolverrUrl).toBe('********');
      expect(body.settings.hostname).toBe('audiobookbay.lu');
    });

    it('POST /api/indexers masks secret fields in create response', async () => {
      (services.indexer.create as Mock).mockResolvedValue(mockIndexer);

      const res = await app.inject({
        method: 'POST',
        url: '/api/indexers',
        payload: {
          name: 'Test Newznab',
          type: 'newznab',
          enabled: true,
          priority: 50,
          settings: { apiUrl: 'https://indexer.test', apiKey: 'new-key' },
        },
      });
      const body = JSON.parse(res.payload);

      expect(res.statusCode).toBe(201);
      expect(body.settings.apiKey).toBe('********');
    });

    it('PUT /api/indexers/:id masks secret fields in update response', async () => {
      (services.indexer.update as Mock).mockResolvedValue(mockIndexer);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/indexers/1',
        payload: { name: 'Updated' },
      });
      const body = JSON.parse(res.payload);

      expect(res.statusCode).toBe(200);
      expect(body.settings.apiKey).toBe('********');
      expect(body.settings.flareSolverrUrl).toBe('********');
    });
  });
});
