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
    it('returns events in { data, total } envelope', async () => {
      const events = [createMockDbBookEvent(), createMockDbBookEvent({ id: 2 })];
      (services.eventHistory.getAll as Mock).mockResolvedValue({ data: events, total: 2 });

      const res = await app.inject({ method: 'GET', url: '/api/event-history' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it('passes eventType filter and pagination to service', async () => {
      (services.eventHistory.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/event-history?eventType=grabbed' });

      expect(services.eventHistory.getAll).toHaveBeenCalledWith({ eventType: 'grabbed', search: undefined }, { limit: 50, offset: undefined });
    });

    it('passes search filter to service', async () => {
      (services.eventHistory.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/event-history?search=Kings' });

      expect(services.eventHistory.getAll).toHaveBeenCalledWith({ eventType: undefined, search: 'Kings' }, { limit: 50, offset: undefined });
    });

    it('forwards limit and offset to service', async () => {
      (services.eventHistory.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/event-history?limit=10&offset=20' });

      expect(services.eventHistory.getAll).toHaveBeenCalledWith(
        { eventType: undefined, search: undefined },
        { limit: 10, offset: 20 },
      );
    });

    it('rejects limit=0 with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/event-history?limit=0' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects negative offset with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/event-history?offset=-1' });
      expect(res.statusCode).toBe(400);
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

  describe('DELETE /api/event-history/:id', () => {
    it('deletes event and returns { success: true }', async () => {
      (services.eventHistory.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/event-history/1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ success: true });
      expect(services.eventHistory.delete).toHaveBeenCalledWith(1);
    });

    it('returns 404 for nonexistent event', async () => {
      (services.eventHistory.delete as Mock).mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/event-history/999' });

      expect(res.statusCode).toBe(404);
    });

    it('returns 500 on service error', async () => {
      (services.eventHistory.delete as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'DELETE', url: '/api/event-history/1' });

      expect(res.statusCode).toBe(500);
    });
  });

  describe('DELETE /api/event-history (bulk)', () => {
    it('deletes all events and returns count', async () => {
      (services.eventHistory.deleteAll as Mock).mockResolvedValue(5);

      const res = await app.inject({ method: 'DELETE', url: '/api/event-history' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ deleted: 5 });
    });

    it('deletes only matching eventType', async () => {
      (services.eventHistory.deleteAll as Mock).mockResolvedValue(2);

      const res = await app.inject({ method: 'DELETE', url: '/api/event-history?eventType=download_failed' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ deleted: 2 });
      expect(services.eventHistory.deleteAll).toHaveBeenCalledWith({ eventType: 'download_failed' });
    });

    it('rejects unsupported eventType with 400 without calling service', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/event-history?eventType=invalid' });

      expect(res.statusCode).toBe(400);
      expect(services.eventHistory.deleteAll).not.toHaveBeenCalled();
    });

    it('returns 500 on service error', async () => {
      (services.eventHistory.deleteAll as Mock).mockRejectedValue(new Error('DB error'));

      const res = await app.inject({ method: 'DELETE', url: '/api/event-history' });

      expect(res.statusCode).toBe(500);
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

  // #372 — Default pagination enforcement
  describe('GET /api/event-history — default pagination', () => {
    it('applies default limit=50 when no limit param provided', async () => {
      (services.eventHistory.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/event-history' });

      expect(services.eventHistory.getAll).toHaveBeenCalledWith(
        { eventType: undefined, search: undefined },
        { limit: 50, offset: undefined },
      );
    });

    it('applies default limit when offset provided without limit', async () => {
      (services.eventHistory.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/event-history?offset=20' });

      expect(services.eventHistory.getAll).toHaveBeenCalledWith(
        { eventType: undefined, search: undefined },
        { limit: 50, offset: 20 },
      );
    });

    it('allows explicit limit to override default', async () => {
      (services.eventHistory.getAll as Mock).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/event-history?limit=10' });

      expect(services.eventHistory.getAll).toHaveBeenCalledWith(
        { eventType: undefined, search: undefined },
        { limit: 10, offset: undefined },
      );
    });
  });
});
