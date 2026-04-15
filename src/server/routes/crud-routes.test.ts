import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

/**
 * Tests shared CRUD error paths from registerCrudRoutes once (via notifiers).
 * Notifiers, indexers, and download-clients all delegate to the same handler —
 * testing error paths per-entity would be pure duplication.
 */

const validNotifier = {
  name: 'Test Webhook',
  type: 'webhook',
  enabled: true,
  events: ['on_grab'],
  settings: { url: 'https://example.com/hook' },
};

describe('crud-routes shared error paths', () => {
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

  describe('GET /api/notifiers — getAll', () => {
    it('returns 500 when service throws', async () => {
      (services.notifier.getAll as Mock).mockRejectedValue(new Error('DB connection lost'));

      const res = await app.inject({ method: 'GET', url: '/api/notifiers' });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Internal server error' });
    });
  });

  describe('GET /api/notifiers/:id — getById', () => {
    it('returns 404 when not found', async () => {
      (services.notifier.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/notifiers/999' });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Notifier not found' });
    });

    it('returns 500 when service throws', async () => {
      (services.notifier.getById as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'GET', url: '/api/notifiers/1' });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Internal server error' });
    });
  });

  describe('POST /api/notifiers — create', () => {
    it('returns 500 when service throws', async () => {
      (services.notifier.create as Mock).mockRejectedValue(new Error('Constraint violation'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers',
        payload: validNotifier,
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Internal server error' });
    });
  });

  describe('PUT /api/notifiers/:id — update', () => {
    it('returns 404 when not found', async () => {
      (services.notifier.update as Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/notifiers/999',
        payload: { name: 'Nope' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Notifier not found' });
    });

    it('returns 400 on invalid update payload', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/notifiers/1',
        payload: { name: '' }, // min(1) violation
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 500 when service throws', async () => {
      (services.notifier.update as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({
        method: 'PUT',
        url: '/api/notifiers/1',
        payload: { name: 'Updated' },
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Internal server error' });
    });
  });

  describe('DELETE /api/notifiers/:id — delete', () => {
    it('returns 404 when not found', async () => {
      (services.notifier.delete as Mock).mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/notifiers/999' });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Notifier not found' });
    });

    it('returns 500 with error message when service throws', async () => {
      (services.notifier.delete as Mock).mockRejectedValue(new Error('Foreign key constraint'));

      const res = await app.inject({ method: 'DELETE', url: '/api/notifiers/1' });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Foreign key constraint' });
    });

    it('returns stringified value for non-Error throws', async () => {
      (services.notifier.delete as Mock).mockRejectedValue('string error');

      const res = await app.inject({ method: 'DELETE', url: '/api/notifiers/1' });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'string error' });
    });
  });

  describe('POST /api/notifiers/test — testConfig', () => {
    it('returns 500 when service throws', async () => {
      (services.notifier.testConfig as Mock).mockRejectedValue(new Error('Connection refused'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers/test',
        payload: validNotifier,
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Internal server error' });
    });
  });

  describe('POST /api/notifiers/:id/test — test', () => {
    it('returns 500 when service throws', async () => {
      (services.notifier.test as Mock).mockRejectedValue(new Error('Timeout'));

      const res = await app.inject({ method: 'POST', url: '/api/notifiers/1/test' });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'Internal server error' });
    });
  });
});
