import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockAuthor = { name: 'Brandon Sanderson', asin: 'B001H6UJO8' };
const mockBook = { title: 'The Way of Kings', asin: 'B0030DL4GK', authors: [{ name: 'Brandon Sanderson' }] };

describe('metadata routes', () => {
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

  describe('GET /api/metadata/search', () => {
    it('returns search results', async () => {
      (services.metadata.search as Mock).mockResolvedValue({
        books: [],
        authors: [mockAuthor],
        series: [],
      });

      const res = await app.inject({ method: 'GET', url: '/api/metadata/search?q=sanderson' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.authors).toHaveLength(1);
    });

    it('returns 400 when query is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/metadata/search' });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/metadata/authors/:id', () => {
    it('returns author when found', async () => {
      (services.metadata.getAuthor as Mock).mockResolvedValue(mockAuthor);

      const res = await app.inject({ method: 'GET', url: '/api/metadata/authors/B001H6UJO8' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).name).toBe('Brandon Sanderson');
    });

    it('returns 404 when not found', async () => {
      (services.metadata.getAuthor as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/metadata/authors/INVALID' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/metadata/authors/:id/books', () => {
    it('returns author books', async () => {
      (services.metadata.getAuthorBooks as Mock).mockResolvedValue([mockBook]);

      const res = await app.inject({ method: 'GET', url: '/api/metadata/authors/B001H6UJO8/books' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveLength(1);
    });
  });

  describe('GET /api/metadata/books/:id', () => {
    it('returns book when found', async () => {
      (services.metadata.getBook as Mock).mockResolvedValue(mockBook);

      const res = await app.inject({ method: 'GET', url: '/api/metadata/books/B0030DL4GK' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).title).toBe('The Way of Kings');
    });

    it('returns 404 when not found', async () => {
      (services.metadata.getBook as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/metadata/books/INVALID' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/metadata/test', () => {
    it('returns provider test results', async () => {
      (services.metadata.testProviders as Mock).mockResolvedValue([
        { name: 'Audnexus', type: 'audnexus', success: true },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/metadata/test' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveLength(1);
    });
  });

  describe('GET /api/metadata/providers', () => {
    it('returns provider list', async () => {
      (services.metadata.getProviders as Mock).mockReturnValue([
        { name: 'Audnexus', type: 'audnexus' },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/metadata/providers' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveLength(1);
    });
  });

  describe('error paths', () => {
    it('GET /api/metadata/search returns 500 when service throws', async () => {
      (services.metadata.search as Mock).mockRejectedValue(new Error('Rate limited'));

      const res = await app.inject({ method: 'GET', url: '/api/metadata/search?q=sanderson' });

      expect(res.statusCode).toBe(500);
    });

    it('GET /api/metadata/authors/:id returns 500 when service throws', async () => {
      (services.metadata.getAuthor as Mock).mockRejectedValue(new Error('Network error'));

      const res = await app.inject({ method: 'GET', url: '/api/metadata/authors/B001H6UJO8' });

      expect(res.statusCode).toBe(500);
    });

    it('GET /api/metadata/authors/:id/books returns 500 when service throws', async () => {
      (services.metadata.getAuthorBooks as Mock).mockRejectedValue(new Error('Timeout'));

      const res = await app.inject({ method: 'GET', url: '/api/metadata/authors/B001H6UJO8/books' });

      expect(res.statusCode).toBe(500);
    });

    it('GET /api/metadata/books/:id returns 500 when service throws', async () => {
      (services.metadata.getBook as Mock).mockRejectedValue(new Error('Provider error'));

      const res = await app.inject({ method: 'GET', url: '/api/metadata/books/B0030DL4GK' });

      expect(res.statusCode).toBe(500);
    });

    it('GET /api/metadata/test returns 500 when service throws', async () => {
      (services.metadata.testProviders as Mock).mockRejectedValue(new Error('All providers down'));

      const res = await app.inject({ method: 'GET', url: '/api/metadata/test' });

      expect(res.statusCode).toBe(500);
    });
  });
});
