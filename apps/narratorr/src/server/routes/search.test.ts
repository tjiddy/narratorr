import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockSearchResult = {
  title: 'The Way of Kings',
  author: 'Brandon Sanderson',
  indexer: 'AudioBookBay',
  downloadUrl: 'magnet:?xt=urn:btih:abc123',
  size: 1073741824,
  seeders: 42,
};

describe('search routes', () => {
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

  describe('GET /api/search', () => {
    it('returns search results', async () => {
      (services.indexer.searchAll as any).mockResolvedValue([mockSearchResult]);

      const res = await app.inject({ method: 'GET', url: '/api/search?q=sanderson' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveLength(1);
      expect(body[0].title).toBe('The Way of Kings');
    });

    it('returns 400 when query is too short', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=a' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when query is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search' });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/search/grab', () => {
    it('grabs download and returns 201', async () => {
      const mockDownload = { id: 1, title: 'Test', status: 'downloading' };
      (services.download.grab as any).mockResolvedValue(mockDownload);

      const res = await app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: {
          downloadUrl: 'magnet:?xt=urn:btih:abc123',
          title: 'The Way of Kings',
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 400 for empty download URL', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: {
          downloadUrl: '',
          title: 'Test',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when title is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: {
          downloadUrl: 'magnet:?xt=urn:btih:abc123',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 500 when grab fails', async () => {
      (services.download.grab as any).mockRejectedValue(new Error('No download client'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: {
          downloadUrl: 'magnet:?xt=urn:btih:abc123',
          title: 'Test',
        },
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('No download client');
    });
  });
});
