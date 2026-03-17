import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Mock } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import type { AuthService } from '../services/auth.service.js';

describe('Discover Routes', () => {
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

  describe('GET /api/discover/suggestions', () => {
    it('returns suggestions sorted by score descending', async () => {
      const mockData = [
        { id: 1, asin: 'B001', score: 80, reason: 'author' },
        { id: 2, asin: 'B002', score: 60, reason: 'genre' },
      ];
      (services.discovery.getSuggestions as Mock).mockResolvedValueOnce(mockData);

      const res = await app.inject({ method: 'GET', url: '/api/discover/suggestions' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual(mockData);
    });

    it('filters by reason query param', async () => {
      (services.discovery.getSuggestions as Mock).mockResolvedValueOnce([]);

      const res = await app.inject({ method: 'GET', url: '/api/discover/suggestions?reason=author' });
      expect(res.statusCode).toBe(200);
      expect(services.discovery.getSuggestions).toHaveBeenCalledWith({ reason: 'author' });
    });

    it('returns empty array with 200 when no suggestions', async () => {
      (services.discovery.getSuggestions as Mock).mockResolvedValueOnce([]);

      const res = await app.inject({ method: 'GET', url: '/api/discover/suggestions' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  describe('POST /api/discover/suggestions/:id/dismiss', () => {
    it('sets status to dismissed and returns 200', async () => {
      (services.discovery.dismissSuggestion as Mock).mockResolvedValueOnce({ id: 1, status: 'dismissed' });

      const res = await app.inject({ method: 'POST', url: '/api/discover/suggestions/1/dismiss' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).status).toBe('dismissed');
    });

    it('returns 404 for unknown suggestion ID', async () => {
      (services.discovery.dismissSuggestion as Mock).mockResolvedValueOnce(null);

      const res = await app.inject({ method: 'POST', url: '/api/discover/suggestions/999/dismiss' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/discover/suggestions/:id/add', () => {
    it('creates wanted book and returns 200', async () => {
      (services.discovery.addSuggestion as Mock).mockResolvedValueOnce({
        suggestion: { id: 1, status: 'added' },
        book: { id: 10, title: 'Test' },
      });

      const res = await app.inject({ method: 'POST', url: '/api/discover/suggestions/1/add' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.suggestion.status).toBe('added');
      expect(body.book.id).toBe(10);
    });

    it('returns 409 for already-added suggestion', async () => {
      (services.discovery.addSuggestion as Mock).mockResolvedValueOnce({
        suggestion: { id: 1, status: 'added' },
        alreadyAdded: true,
      });

      const res = await app.inject({ method: 'POST', url: '/api/discover/suggestions/1/add' });
      expect(res.statusCode).toBe(409);
    });

    it('returns 200 with duplicate flag when library duplicate exists', async () => {
      (services.discovery.addSuggestion as Mock).mockResolvedValueOnce({
        suggestion: { id: 1, status: 'added' },
        book: { id: 99, title: 'Existing' },
        duplicate: true,
      });

      const res = await app.inject({ method: 'POST', url: '/api/discover/suggestions/1/add' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).duplicate).toBe(true);
    });

    it('returns 404 for unknown suggestion ID', async () => {
      (services.discovery.addSuggestion as Mock).mockResolvedValueOnce(null);

      const res = await app.inject({ method: 'POST', url: '/api/discover/suggestions/999/add' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/discover/refresh', () => {
    it('triggers manual refresh and returns 200', async () => {
      (services.settings.get as Mock).mockResolvedValueOnce({ enabled: true });
      (services.discovery.refreshSuggestions as Mock).mockResolvedValueOnce({ added: 0, removed: 0, warnings: [] });

      const res = await app.inject({ method: 'POST', url: '/api/discover/refresh' });
      expect(res.statusCode).toBe(200);
    });

    it('returns warnings array in response body when refresh has warnings', async () => {
      (services.settings.get as Mock).mockResolvedValueOnce({ enabled: true });
      (services.discovery.refreshSuggestions as Mock).mockResolvedValueOnce({
        added: 3, removed: 1, warnings: ['Expiry step failed — continuing with candidate generation'],
      });

      const res = await app.inject({ method: 'POST', url: '/api/discover/refresh' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.warnings).toEqual(['Expiry step failed — continuing with candidate generation']);
      expect(body.added).toBe(3);
      expect(body.removed).toBe(1);
    });

    it('returns 409 when discovery.enabled is false', async () => {
      (services.settings.get as Mock).mockResolvedValueOnce({ enabled: false });

      const res = await app.inject({ method: 'POST', url: '/api/discover/refresh' });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('GET /api/discover/stats', () => {
    it('returns counts by reason type', async () => {
      (services.discovery.getStats as Mock).mockResolvedValueOnce({ author: 5, series: 2, genre: 3 });

      const res = await app.inject({ method: 'GET', url: '/api/discover/stats' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ author: 5, series: 2, genre: 3 });
    });
  });

  describe('GET /api/discover/suggestions with author filter', () => {
    it('passes author filter to service', async () => {
      (services.discovery.getSuggestions as Mock).mockResolvedValueOnce([]);

      const res = await app.inject({ method: 'GET', url: '/api/discover/suggestions?author=Brandon%20Sanderson' });
      expect(res.statusCode).toBe(200);
      expect(services.discovery.getSuggestions).toHaveBeenCalledWith({ author: 'Brandon Sanderson' });
    });

    it('passes both reason and author filters', async () => {
      (services.discovery.getSuggestions as Mock).mockResolvedValueOnce([]);

      const res = await app.inject({ method: 'GET', url: '/api/discover/suggestions?reason=author&author=Sanderson' });
      expect(res.statusCode).toBe(200);
      expect(services.discovery.getSuggestions).toHaveBeenCalledWith({ reason: 'author', author: 'Sanderson' });
    });
  });

  // --- #408: Snooze route ---

  describe('POST /api/discover/suggestions/:id/snooze', () => {
    it('returns 200 with updated SuggestionRow including snoozeUntil', async () => {
      const snoozeUntil = new Date(Date.now() + 7 * 86400000);
      (services.discovery.snoozeSuggestion as Mock).mockResolvedValueOnce({
        id: 1, asin: 'B001', status: 'pending', snoozeUntil,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/discover/suggestions/1/snooze',
        payload: { durationDays: 7 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe('pending');
      expect(body.snoozeUntil).toBeDefined();
      expect(services.discovery.snoozeSuggestion).toHaveBeenCalledWith(1, 7);
    });

    it('returns 400 for invalid body (missing durationDays)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/discover/suggestions/1/snooze',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for non-integer durationDays (float)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/discover/suggestions/1/snooze',
        payload: { durationDays: 2.5 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for durationDays < 1', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/discover/suggestions/1/snooze',
        payload: { durationDays: 0 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for durationDays > 365', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/discover/suggestions/1/snooze',
        payload: { durationDays: 400 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for non-existent suggestion ID', async () => {
      (services.discovery.snoozeSuggestion as Mock).mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/discover/suggestions/999/snooze',
        payload: { durationDays: 7 },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 for suggestion not in pending status', async () => {
      (services.discovery.snoozeSuggestion as Mock).mockResolvedValueOnce('conflict');

      const res = await app.inject({
        method: 'POST',
        url: '/api/discover/suggestions/1/snooze',
        payload: { durationDays: 7 },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('validation', () => {
    it('rejects invalid reason query param with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/discover/suggestions?reason=bogus' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects non-positive id param with 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/discover/suggestions/0/dismiss' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects non-numeric id param with 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/discover/suggestions/abc/add' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('error propagation', () => {
    it('returns 500 when addSuggestion throws', async () => {
      (services.discovery.addSuggestion as Mock).mockRejectedValueOnce(new Error('DB connection lost'));

      const res = await app.inject({ method: 'POST', url: '/api/discover/suggestions/1/add' });
      expect(res.statusCode).toBe(500);
    });

    it('returns 500 when refreshSuggestions throws', async () => {
      (services.settings.get as Mock).mockResolvedValueOnce({ enabled: true });
      (services.discovery.refreshSuggestions as Mock).mockRejectedValueOnce(new Error('Provider unreachable'));

      const res = await app.inject({ method: 'POST', url: '/api/discover/refresh' });
      expect(res.statusCode).toBe(500);
    });
  });

  describe('auth integration', () => {
    it('returns 401 when no auth credentials provided', async () => {
      const authService = {
        validateApiKey: vi.fn().mockResolvedValue(false),
        getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
        hasUser: vi.fn().mockResolvedValue(true),
      } as unknown as AuthService;

      const authApp = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
      authApp.setValidatorCompiler(validatorCompiler);
      authApp.setSerializerCompiler(serializerCompiler);
      await authApp.register(cookie);
      const authPluginMod = await import('../plugins/auth.js');
      await authApp.register(authPluginMod.default, { authService });

      const { discoverRoutes } = await import('./discover.js');
      await discoverRoutes(authApp, {
        discoveryService: services.discovery as never,
        settingsService: services.settings as never,
      });
      await authApp.ready();

      const res = await authApp.inject({ method: 'GET', url: '/api/discover/suggestions' });
      expect(res.statusCode).toBe(401);

      await authApp.close();
    });
  });
});
