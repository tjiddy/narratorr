import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { RecyclingBinError } from '../services/recycling-bin.service.js';

describe('recycling-bin routes', () => {
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

  describe('GET /api/system/recycling-bin', () => {
    it('returns list of recycling bin entries', async () => {
      const entries = [
        { id: 1, title: 'Book A', deletedAt: new Date().toISOString() },
        { id: 2, title: 'Book B', deletedAt: new Date().toISOString() },
      ];
      (services.recyclingBin.list as Mock).mockResolvedValue(entries);

      const res = await app.inject({ method: 'GET', url: '/api/system/recycling-bin' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveLength(2);
      expect(body[0].title).toBe('Book A');
    });

    it('returns empty array when bin is empty', async () => {
      (services.recyclingBin.list as Mock).mockResolvedValue([]);

      const res = await app.inject({ method: 'GET', url: '/api/system/recycling-bin' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual([]);
    });
  });

  describe('POST /api/system/recycling-bin/:id/restore', () => {
    it('restores entry and returns 200 with restored book', async () => {
      (services.recyclingBin.restore as Mock).mockResolvedValue({ bookId: 42 });

      const res = await app.inject({ method: 'POST', url: '/api/system/recycling-bin/1/restore' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ bookId: 42 });
    });

    it('returns 404 when entry does not exist', async () => {
      (services.recyclingBin.restore as Mock).mockRejectedValue(
        new RecyclingBinError('Recycling bin entry not found', 'NOT_FOUND'),
      );

      const res = await app.inject({ method: 'POST', url: '/api/system/recycling-bin/999/restore' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).error).toContain('not found');
    });

    it('returns 409 when original path is occupied', async () => {
      (services.recyclingBin.restore as Mock).mockRejectedValue(
        new RecyclingBinError('Original path is occupied by "Other Book"', 'CONFLICT'),
      );

      const res = await app.inject({ method: 'POST', url: '/api/system/recycling-bin/1/restore' });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload).error).toContain('occupied');
    });

    it('returns 500 when restore fails (filesystem error)', async () => {
      (services.recyclingBin.restore as Mock).mockRejectedValue(
        new RecyclingBinError('Recycled files not found on disk', 'FILESYSTEM'),
      );

      const res = await app.inject({ method: 'POST', url: '/api/system/recycling-bin/1/restore' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toContain('not found on disk');
    });
  });

  describe('DELETE /api/system/recycling-bin/:id', () => {
    it('permanently deletes entry and returns 204', async () => {
      (services.recyclingBin.purge as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/system/recycling-bin/1' });

      expect(res.statusCode).toBe(204);
    });

    it('returns 404 when entry does not exist', async () => {
      (services.recyclingBin.purge as Mock).mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/system/recycling-bin/999' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/system/recycling-bin/empty', () => {
    it('purges all entries and returns 200', async () => {
      (services.recyclingBin.purgeAll as Mock).mockResolvedValue({ purged: 5, failed: 0 });

      const res = await app.inject({ method: 'POST', url: '/api/system/recycling-bin/empty' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ purged: 5, failed: 0 });
    });

    it('returns partial success info when some items fail', async () => {
      (services.recyclingBin.purgeAll as Mock).mockResolvedValue({ purged: 3, failed: 2 });

      const res = await app.inject({ method: 'POST', url: '/api/system/recycling-bin/empty' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.purged).toBe(3);
      expect(body.failed).toBe(2);
    });
  });

  describe('positive-integer idParamSchema validation', () => {
    it('rejects non-numeric id on restore with 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/system/recycling-bin/abc/restore' });
      expect(res.statusCode).toBe(400);
      expect(services.recyclingBin.restore).not.toHaveBeenCalled();
    });

    it('rejects id=0 on restore with 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/system/recycling-bin/0/restore' });
      expect(res.statusCode).toBe(400);
      expect(services.recyclingBin.restore).not.toHaveBeenCalled();
    });

    it('rejects id=-1 on restore with 400', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/system/recycling-bin/-1/restore' });
      expect(res.statusCode).toBe(400);
      expect(services.recyclingBin.restore).not.toHaveBeenCalled();
    });

    it('rejects non-numeric id on delete with 400', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/system/recycling-bin/abc' });
      expect(res.statusCode).toBe(400);
      expect(services.recyclingBin.purge).not.toHaveBeenCalled();
    });

    it('rejects id=0 on delete with 400', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/system/recycling-bin/0' });
      expect(res.statusCode).toBe(400);
      expect(services.recyclingBin.purge).not.toHaveBeenCalled();
    });

    it('accepts valid positive integer id on restore', async () => {
      (services.recyclingBin.restore as Mock).mockResolvedValue({ id: 5, success: true });
      const res = await app.inject({ method: 'POST', url: '/api/system/recycling-bin/5/restore' });
      expect(res.statusCode).toBe(200);
      expect(services.recyclingBin.restore).toHaveBeenCalledWith(5);
    });
  });
});

describe('GET /api/system/recycling-bin array contract (issue #79)', () => {
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

  it('returns authorName as string[] for a two-author book (not a joined string)', async () => {
    (services.recyclingBin.list as Mock).mockResolvedValue([
      { id: 1, title: 'Dune', authorName: ['Frank Herbert', 'Brian Herbert'], narrator: null, deletedAt: new Date().toISOString() },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/system/recycling-bin' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body[0].authorName).toEqual(['Frank Herbert', 'Brian Herbert']);
  });

  it('returns narrator as string[] for a book with a comma-containing narrator name', async () => {
    (services.recyclingBin.list as Mock).mockResolvedValue([
      { id: 2, title: 'Dune', authorName: null, narrator: ['Kate Reading, Michael Kramer'], deletedAt: new Date().toISOString() },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/system/recycling-bin' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body[0].narrator).toEqual(['Kate Reading, Michael Kramer']);
  });
});
