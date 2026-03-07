import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockNotifier = {
  id: 1,
  name: 'Test Webhook',
  type: 'webhook' as const,
  enabled: true,
  events: ['on_grab', 'on_import'],
  settings: { url: 'https://example.com/hook' } as Record<string, unknown>,
  createdAt: new Date(),
};

describe('notifiers routes', () => {
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

  describe('GET /api/notifiers', () => {
    it('returns all notifiers', async () => {
      vi.mocked(services.notifier.getAll).mockResolvedValue([mockNotifier]);
      const res = await app.inject({ method: 'GET', url: '/api/notifiers' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
    });
  });

  describe('GET /api/notifiers/:id', () => {
    it('returns notifier by id', async () => {
      vi.mocked(services.notifier.getById).mockResolvedValue(mockNotifier);
      const res = await app.inject({ method: 'GET', url: '/api/notifiers/1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'Test Webhook' });
    });

    it('returns 404 for missing notifier', async () => {
      vi.mocked(services.notifier.getById).mockResolvedValue(null);
      const res = await app.inject({ method: 'GET', url: '/api/notifiers/999' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/notifiers', () => {
    it('creates a notifier', async () => {
      vi.mocked(services.notifier.create).mockResolvedValue(mockNotifier);
      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers',
        payload: {
          name: 'Test Webhook',
          type: 'webhook',
          enabled: true,
          events: ['on_grab'],
          settings: { url: 'https://example.com/hook' },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ name: 'Test Webhook' });
    });

    it('validates required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers',
        payload: { type: 'webhook' }, // missing name, events, settings
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('PUT /api/notifiers/:id', () => {
    it('updates a notifier', async () => {
      vi.mocked(services.notifier.update).mockResolvedValue({ ...mockNotifier, name: 'Updated' });
      const res = await app.inject({
        method: 'PUT',
        url: '/api/notifiers/1',
        payload: { name: 'Updated' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'Updated' });
    });

    it('returns 404 for missing notifier', async () => {
      vi.mocked(services.notifier.update).mockResolvedValue(null);
      const res = await app.inject({
        method: 'PUT',
        url: '/api/notifiers/999',
        payload: { name: 'Nope' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/notifiers/:id', () => {
    it('deletes a notifier', async () => {
      vi.mocked(services.notifier.delete).mockResolvedValue(true);
      const res = await app.inject({ method: 'DELETE', url: '/api/notifiers/1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('returns 404 for missing notifier', async () => {
      vi.mocked(services.notifier.delete).mockResolvedValue(false);
      const res = await app.inject({ method: 'DELETE', url: '/api/notifiers/999' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/notifiers/:id/test', () => {
    it('tests a notifier', async () => {
      vi.mocked(services.notifier.test).mockResolvedValue({ success: true });
      const res = await app.inject({ method: 'POST', url: '/api/notifiers/1/test' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });

  describe('POST /api/notifiers/test', () => {
    it('tests notifier config', async () => {
      vi.mocked(services.notifier.testConfig).mockResolvedValue({ success: true });
      const res = await app.inject({
        method: 'POST',
        url: '/api/notifiers/test',
        payload: {
          name: 'Test',
          type: 'webhook',
          enabled: true,
          events: ['on_grab'],
          settings: { url: 'https://example.com/hook' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });
});
