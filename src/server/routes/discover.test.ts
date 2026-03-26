import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Mock } from 'vitest';
import Fastify from 'fastify';

vi.mock('../config.js', () => ({ config: { authBypass: false, isDev: true } }));
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import type { AuthService } from '../services/auth.service.js';
import { TaskRegistryError } from '../services/task-registry.js';

const NOW = new Date('2026-01-15T12:00:00Z');

function mockSuggestionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, asin: 'B001', title: 'Test Book', authorName: 'Author',
    narratorName: null, coverUrl: null, duration: null, publishedDate: null,
    language: null, genres: null, seriesName: null, seriesPosition: null,
    reason: 'author', reasonContext: 'test', score: 80,
    status: 'pending', refreshedAt: NOW, dismissedAt: null,
    snoozeUntil: null, createdAt: NOW,
    ...overrides,
  };
}

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
        mockSuggestionRow({ id: 1, asin: 'B001', score: 80, reason: 'author' }),
        mockSuggestionRow({ id: 2, asin: 'B002', score: 60, reason: 'genre' }),
      ];
      (services.discovery.getSuggestions as Mock).mockResolvedValueOnce(mockData);

      const res = await app.inject({ method: 'GET', url: '/api/discover/suggestions' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveLength(2);
      expect(body[0].score).toBe(80);
      expect(body[1].score).toBe(60);
      // Timestamps serialized as ISO strings
      expect(body[0].refreshedAt).toBe(NOW.toISOString());
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
      (services.discovery.dismissSuggestion as Mock).mockResolvedValueOnce(
        mockSuggestionRow({ id: 1, status: 'dismissed', dismissedAt: NOW }),
      );

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
        suggestion: mockSuggestionRow({ id: 1, status: 'added' }),
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
        suggestion: mockSuggestionRow({ id: 1, status: 'added' }),
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
    it('triggers manual refresh via task registry and returns refresh summary', async () => {
      const refreshResult = { added: 3, removed: 1, warnings: ['some warning'] };
      (services.settings.get as Mock).mockResolvedValueOnce({ enabled: true });
      (services.taskRegistry.runExclusive as Mock).mockResolvedValueOnce(refreshResult);

      const res = await app.inject({ method: 'POST', url: '/api/discover/refresh' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual(refreshResult);
      expect(body.added).toBe(3);
      expect(body.removed).toBe(1);
      expect(body.warnings).toEqual(['some warning']);
    });

    it('returns 409 when discovery.enabled is false', async () => {
      (services.settings.get as Mock).mockResolvedValueOnce({ enabled: false });

      const res = await app.inject({ method: 'POST', url: '/api/discover/refresh' });
      expect(res.statusCode).toBe(409);
    });

    // #149 — typed error routing via plugin (ERR-1)
    it('returns 409 when task registry throws TaskRegistryError ALREADY_RUNNING (plugin-routed)', async () => {
      (services.settings.get as Mock).mockResolvedValueOnce({ enabled: true });
      (services.taskRegistry.runExclusive as Mock).mockRejectedValue(new TaskRegistryError('Task "discovery" is already running', 'ALREADY_RUNNING'));

      const res = await app.inject({ method: 'POST', url: '/api/discover/refresh' });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Task "discovery" is already running' });
    });

    it('returns 500 with plugin fallback body when unrelated error message contains "already running" substring (regression: no string routing)', async () => {
      (services.settings.get as Mock).mockResolvedValueOnce({ enabled: true });
      (services.taskRegistry.runExclusive as Mock).mockRejectedValue(new Error('Config already running out of space'));

      const res = await app.inject({ method: 'POST', url: '/api/discover/refresh' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
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
      (services.discovery.snoozeSuggestion as Mock).mockResolvedValueOnce(
        mockSuggestionRow({ id: 1, asin: 'B001', status: 'pending', snoozeUntil }),
      );

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
      (services.taskRegistry.runExclusive as Mock).mockRejectedValueOnce(new Error('Provider unreachable'));

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
        taskRegistry: services.taskRegistry as never,
      });
      await authApp.ready();

      const res = await authApp.inject({ method: 'GET', url: '/api/discover/suggestions' });
      expect(res.statusCode).toBe(401);

      await authApp.close();
    });
  });

  // -------------------------------------------------------------------------
  // Diversity reason filter (#407)
  // -------------------------------------------------------------------------

  describe('diversity reason query param', () => {
    it('GET /api/discover/suggestions?reason=diversity returns 200 and forwards to service', async () => {
      (services.discovery.getSuggestions as Mock).mockResolvedValueOnce([]);

      const res = await app.inject({ method: 'GET', url: '/api/discover/suggestions?reason=diversity' });
      expect(res.statusCode).toBe(200);
      expect(services.discovery.getSuggestions).toHaveBeenCalledWith({ reason: 'diversity' });
    });

    it('rejects invalid reason value with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/discover/suggestions?reason=invalid' });
      expect(res.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  // #406 — Concurrent refresh protection
  // ---------------------------------------------------------------------------
  describe('POST /api/discover/refresh concurrency (AC7)', () => {
    it('returns 409 when task registry reports discovery is already running', async () => {
      (services.settings.get as Mock).mockResolvedValueOnce({ enabled: true });
      (services.taskRegistry.runExclusive as Mock).mockRejectedValueOnce(new TaskRegistryError('Task "discovery" is already running', 'ALREADY_RUNNING'));

      const res = await app.inject({ method: 'POST', url: '/api/discover/refresh' });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error).toContain('already running');
    });

    it('calls taskRegistry.runExclusive("discovery") with a callback that invokes refreshSuggestions', async () => {
      const refreshResult = { added: 2, removed: 0, warnings: [] };
      (services.settings.get as Mock).mockResolvedValueOnce({ enabled: true });
      (services.discovery.refreshSuggestions as Mock).mockResolvedValueOnce(refreshResult);
      (services.taskRegistry.runExclusive as Mock).mockImplementationOnce(
        async (_name: string, fn: () => Promise<unknown>) => fn(),
      );

      const res = await app.inject({ method: 'POST', url: '/api/discover/refresh' });
      expect(res.statusCode).toBe(200);
      expect(services.taskRegistry.runExclusive).toHaveBeenCalledWith('discovery', expect.any(Function));
      expect(services.discovery.refreshSuggestions).toHaveBeenCalledOnce();
      expect(JSON.parse(res.payload)).toEqual(refreshResult);
    });

    it('still returns 409 when discovery is disabled (before hitting task registry)', async () => {
      (services.settings.get as Mock).mockResolvedValueOnce({ enabled: false });

      const res = await app.inject({ method: 'POST', url: '/api/discover/refresh' });
      expect(res.statusCode).toBe(409);
      expect(services.taskRegistry.runExclusive).not.toHaveBeenCalled();
    });
  });
});
