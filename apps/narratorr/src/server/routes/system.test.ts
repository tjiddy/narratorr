import { describe, it, expect, beforeAll, afterAll, vi, type Mock } from 'vitest';
import Fastify from 'fastify';
import { createMockServices } from '../__tests__/helpers.js';
import { systemRoutes } from './system.js';

describe('system routes', () => {
  const services = createMockServices({
    settings: {
      get: vi.fn().mockResolvedValue({ enabled: false, intervalMinutes: 360, autoGrab: false }),
    } as Record<string, unknown>,
    book: {
      getAll: vi.fn().mockResolvedValue([]),
    } as Record<string, unknown>,
  });

  let app: Awaited<ReturnType<typeof Fastify>>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await systemRoutes(app, services);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/system/status', () => {
    it('returns 200 with version, status, and valid ISO timestamp', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/system/status' });

      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload.version).toBe('0.1.0');
      expect(payload.status).toBe('ok');
      expect(payload.timestamp).toBeDefined();

      // Verify timestamp is a valid ISO string
      const timestamp = new Date(payload.timestamp);
      expect(timestamp.toISOString()).toBe(payload.timestamp);
    });
  });

  describe('GET /api/health', () => {
    it('returns 200 with status and valid ISO timestamp', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/health' });

      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload.status).toBe('ok');
      expect(payload.timestamp).toBeDefined();

      // Verify timestamp is a valid ISO string
      const timestamp = new Date(payload.timestamp);
      expect(timestamp.toISOString()).toBe(payload.timestamp);
    });
  });

  describe('POST /api/system/tasks/search', () => {
    it('returns 200 with search summary', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/search' });

      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload).toHaveProperty('searched');
      expect(payload).toHaveProperty('grabbed');
      expect(payload.searched).toBe(0);
      expect(payload.grabbed).toBe(0);
    });

    it('returns 500 when search job throws', async () => {
      // settings.get is the first async call in runSearchJob
      (services.settings.get as Mock).mockRejectedValueOnce(new Error('DB connection lost'));

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/search' });

      expect(res.statusCode).toBe(500);
    });
  });
});
