import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import { createMockDbBookEvent } from '../__tests__/factories.js';
import type { Services } from './index.js';

describe('event-history routes', () => {
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

  describe('GET /api/event-history', () => {
    it('returns all events', async () => {
      const events = [createMockDbBookEvent(), createMockDbBookEvent({ id: 2 })];
      (services.eventHistory.getAll as Mock).mockResolvedValue(events);

      const res = await app.inject({ method: 'GET', url: '/api/event-history' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveLength(2);
    });

    it('passes eventType filter to service', async () => {
      (services.eventHistory.getAll as Mock).mockResolvedValue([]);

      await app.inject({ method: 'GET', url: '/api/event-history?eventType=grabbed' });

      expect(services.eventHistory.getAll).toHaveBeenCalledWith({ eventType: 'grabbed', search: undefined });
    });

    it('passes search filter to service', async () => {
      (services.eventHistory.getAll as Mock).mockResolvedValue([]);

      await app.inject({ method: 'GET', url: '/api/event-history?search=Kings' });

      expect(services.eventHistory.getAll).toHaveBeenCalledWith({ eventType: undefined, search: 'Kings' });
    });

    it('returns 500 on service error', async () => {
      (services.eventHistory.getAll as Mock).mockRejectedValue(new Error('DB down'));

      const res = await app.inject({ method: 'GET', url: '/api/event-history' });

      expect(res.statusCode).toBe(500);
    });
  });

  describe('GET /api/event-history/books/:bookId', () => {
    it('returns events for a book', async () => {
      const events = [createMockDbBookEvent()];
      (services.eventHistory.getByBookId as Mock).mockResolvedValue(events);

      const res = await app.inject({ method: 'GET', url: '/api/event-history/books/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toHaveLength(1);
      expect(services.eventHistory.getByBookId).toHaveBeenCalledWith(1);
    });

    it('returns 400 for invalid bookId', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/event-history/books/abc' });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/event-history/:id/mark-failed', () => {
    it('marks event as failed', async () => {
      (services.eventHistory.markFailed as Mock).mockResolvedValue({ success: true });

      const res = await app.inject({ method: 'POST', url: '/api/event-history/1/mark-failed' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: true });
      expect(services.eventHistory.markFailed).toHaveBeenCalledWith(1);
    });

    it('returns 404 when event not found', async () => {
      (services.eventHistory.markFailed as Mock).mockRejectedValue(new Error('Event not found'));

      const res = await app.inject({ method: 'POST', url: '/api/event-history/999/mark-failed' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 on non-actionable event type', async () => {
      (services.eventHistory.markFailed as Mock).mockRejectedValue(
        new Error("Event type 'deleted' does not support mark-as-failed"),
      );

      const res = await app.inject({ method: 'POST', url: '/api/event-history/1/mark-failed' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when event has no associated download', async () => {
      (services.eventHistory.markFailed as Mock).mockRejectedValue(
        new Error('Event has no associated download'),
      );

      const res = await app.inject({ method: 'POST', url: '/api/event-history/1/mark-failed' });

      expect(res.statusCode).toBe(400);
    });
  });
});
