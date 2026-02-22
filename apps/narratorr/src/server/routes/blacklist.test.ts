import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockEntry = {
  id: 1,
  bookId: null,
  infoHash: 'abc123def456',
  title: 'Bad Release [Unabridged]',
  reason: 'wrong_content' as const,
  note: 'Not the right book',
  blacklistedAt: new Date(),
};

describe('blacklist routes', () => {
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

  describe('GET /api/blacklist', () => {
    it('returns all blacklist entries', async () => {
      vi.mocked(services.blacklist.getAll).mockResolvedValue([mockEntry]);
      const res = await app.inject({ method: 'GET', url: '/api/blacklist' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
    });
  });

  describe('POST /api/blacklist', () => {
    it('creates a blacklist entry', async () => {
      vi.mocked(services.blacklist.create).mockResolvedValue(mockEntry);
      const res = await app.inject({
        method: 'POST',
        url: '/api/blacklist',
        payload: {
          infoHash: 'abc123def456',
          title: 'Bad Release [Unabridged]',
          reason: 'wrong_content',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ title: 'Bad Release [Unabridged]' });
    });

    it('validates required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/blacklist',
        payload: { reason: 'spam' }, // missing infoHash and title
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/blacklist/:id', () => {
    it('deletes a blacklist entry', async () => {
      vi.mocked(services.blacklist.delete).mockResolvedValue(true);
      const res = await app.inject({ method: 'DELETE', url: '/api/blacklist/1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('returns 404 for missing entry', async () => {
      vi.mocked(services.blacklist.delete).mockResolvedValue(false);
      const res = await app.inject({ method: 'DELETE', url: '/api/blacklist/999' });
      expect(res.statusCode).toBe(404);
    });
  });
});
