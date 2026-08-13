import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockServices, installMockAppLog, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockExclusion = {
  id: 1,
  asin: 'B0ABC12345',
  title: 'The Reckoning',
  authorName: 'Jane Doe',
  authorSlug: 'jane-doe',
  importListId: 5,
  importListName: 'NYT Bestsellers',
  createdAt: new Date(),
};

describe('import list exclusion routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;
  let logSpies: ReturnType<typeof installMockAppLog>['spies'];
  let restoreLog: () => void;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
    const installed = installMockAppLog(app);
    logSpies = installed.spies;
    restoreLog = installed.restore;
  });

  afterAll(async () => {
    restoreLog();
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
    for (const s of Object.values(logSpies)) s.mockClear();
  });

  describe('GET /api/import-list-exclusions', () => {
    it('returns exclusions in a { data, total } envelope', async () => {
      vi.mocked(services.importListExclusion.getAll).mockResolvedValue({ data: [mockExclusion], total: 1 });

      const res = await app.inject({ method: 'GET', url: '/api/import-list-exclusions' });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(1);
      expect(res.json().total).toBe(1);
    });

    it('coerces limit and offset from the querystring', async () => {
      vi.mocked(services.importListExclusion.getAll).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/import-list-exclusions?limit=10&offset=20' });

      expect(services.importListExclusion.getAll).toHaveBeenCalledWith({ limit: 10, offset: 20 });
    });

    it('falls back to the shared default limit when neither param is supplied', async () => {
      vi.mocked(services.importListExclusion.getAll).mockResolvedValue({ data: [], total: 0 });

      await app.inject({ method: 'GET', url: '/api/import-list-exclusions' });

      expect(services.importListExclusion.getAll).toHaveBeenCalledWith({ limit: 100 });
    });

    it('rejects limit=0 with 400 and never reaches the service', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/import-list-exclusions?limit=0' });

      expect(res.statusCode).toBe(400);
      expect(services.importListExclusion.getAll).not.toHaveBeenCalled();
    });

    it('rejects limit=501 with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/import-list-exclusions?limit=501' });

      expect(res.statusCode).toBe(400);
      expect(services.importListExclusion.getAll).not.toHaveBeenCalled();
    });

    it('rejects a negative offset with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/import-list-exclusions?offset=-1' });

      expect(res.statusCode).toBe(400);
      expect(services.importListExclusion.getAll).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/import-list-exclusions/:id', () => {
    it('removes the exclusion and reports success', async () => {
      vi.mocked(services.importListExclusion.delete).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/import-list-exclusions/7' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(services.importListExclusion.delete).toHaveBeenCalledWith(7);
    });

    it('returns 404 naming the entity for an unknown id', async () => {
      vi.mocked(services.importListExclusion.delete).mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/import-list-exclusions/999' });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Import list exclusion not found' });
    });

    it('rejects a non-numeric id with 400 before the service is touched', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/import-list-exclusions/abc' });

      expect(res.statusCode).toBe(400);
      expect(services.importListExclusion.delete).not.toHaveBeenCalled();
    });

    it('returns 500 and logs a serialized error when the service throws', async () => {
      vi.mocked(services.importListExclusion.delete).mockRejectedValue(new Error('db is locked'));

      const res = await app.inject({ method: 'DELETE', url: '/api/import-list-exclusions/7' });

      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'db is locked' });
      expect(logSpies.error).toHaveBeenCalledWith(
        { error: expect.objectContaining({ message: 'db is locked' }) },
        'Failed to remove import list exclusion',
      );
    });
  });

  // AC7: exclusions have exactly one writer, so no create contract exists to validate.
  it('registers no POST route — an exclusion cannot be created over HTTP', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/import-list-exclusions',
      payload: { title: 'The Reckoning' },
    });

    expect(res.statusCode).toBe(404);
  });
});
