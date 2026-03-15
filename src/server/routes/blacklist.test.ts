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
  blacklistType: 'permanent' as const,
  expiresAt: null,
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
    it('returns blacklist entries in { data, total } envelope', async () => {
      vi.mocked(services.blacklist.getAll).mockResolvedValue({ data: [mockEntry], total: 1 });
      const res = await app.inject({ method: 'GET', url: '/api/blacklist' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it('forwards limit and offset to service', async () => {
      vi.mocked(services.blacklist.getAll).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/blacklist?limit=10&offset=20' });

      expect(services.blacklist.getAll).toHaveBeenCalledWith({ limit: 10, offset: 20 });
    });

    it('rejects limit=0 with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/blacklist?limit=0' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects negative offset with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/blacklist?offset=-1' });
      expect(res.statusCode).toBe(400);
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

    // L-4: reason is now required in the blacklist contract
    it('rejects payload with missing reason', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/blacklist',
        payload: {
          infoHash: 'abc123def456',
          title: 'Bad Release [Unabridged]',
          // no reason — should be rejected
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('accepts payload with valid reason value', async () => {
      vi.mocked(services.blacklist.create).mockResolvedValue(mockEntry);
      const res = await app.inject({
        method: 'POST',
        url: '/api/blacklist',
        payload: {
          infoHash: 'abc123def456',
          title: 'Bad Release [Unabridged]',
          reason: 'bad_quality',
        },
      });
      expect(res.statusCode).toBe(201);
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

  describe('PATCH /api/blacklist/:id', () => {
    it('toggles to permanent — sets expires_at null', async () => {
      const permanentEntry = { ...mockEntry, blacklistType: 'permanent' as const, expiresAt: null };
      vi.mocked(services.blacklist.toggleType).mockResolvedValue(permanentEntry);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/blacklist/1',
        payload: { blacklistType: 'permanent' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ blacklistType: 'permanent' });
      expect(services.blacklist.toggleType).toHaveBeenCalledWith(1, 'permanent');
    });

    it('toggles to temporary — sets expires_at from TTL setting', async () => {
      const temporaryEntry = {
        ...mockEntry,
        blacklistType: 'temporary' as const,
        expiresAt: new Date('2026-04-08T00:00:00Z'),
      };
      vi.mocked(services.blacklist.toggleType).mockResolvedValue(temporaryEntry);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/blacklist/1',
        payload: { blacklistType: 'temporary' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ blacklistType: 'temporary' });
      expect(services.blacklist.toggleType).toHaveBeenCalledWith(1, 'temporary');
    });

    it('returns 404 for non-existent entry', async () => {
      vi.mocked(services.blacklist.toggleType).mockResolvedValue(null);

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/blacklist/999',
        payload: { blacklistType: 'permanent' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 500 when toggleType service throws', async () => {
      vi.mocked(services.blacklist.toggleType).mockRejectedValue(new Error('DB connection lost'));

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/blacklist/1',
        payload: { blacklistType: 'permanent' },
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ error: 'DB connection lost' });
    });

    it('returns 400 for invalid blacklistType value', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/blacklist/1',
        payload: { blacklistType: 'invalid' },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
