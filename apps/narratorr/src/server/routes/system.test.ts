import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

describe('system routes', () => {
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
      (services.settings.get as Mock).mockResolvedValue({ enabled: false, intervalMinutes: 360, autoGrab: false });
      (services.book.getAll as Mock).mockResolvedValue([]);

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/search' });

      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload).toHaveProperty('searched');
      expect(payload).toHaveProperty('grabbed');
      expect(payload.searched).toBe(0);
      expect(payload.grabbed).toBe(0);
    });

    it('returns 500 when search job throws', async () => {
      (services.settings.get as Mock).mockRejectedValue(new Error('DB connection lost'));

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/search' });

      expect(res.statusCode).toBe(500);
    });
  });
});
