import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import {
  createTestApp,
  createAuthTestApp,
  createMockServices,
  createMockDb,
  inject,
  type ZodTestApp,
} from '../__tests__/helpers.js';
import type { Db } from '@db/index.js';
import type { Services } from './index.js';

const BOOK_ID = 1;
const URL = `/api/books/${BOOK_ID}/series/add-all`;

function seriesCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 500,
    name: 'The Expanse',
    hardcoverSeriesId: 900,
    seriesAuthor: 'James S. A. Corey',
    lastFetchedAt: null,
    members: [
      { hardcoverBookId: 1, slug: null, title: 'Leviathan Wakes', position: 1, imageUrl: null, inLibrary: false, libraryBookId: null },
    ],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((res) => { resolve = res; }), resolve };
}

describe('POST /api/books/:id/series/add-all', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeEach(async () => {
    services = createMockServices();
    (services.book.getById as Mock).mockResolvedValue({ id: BOOK_ID, title: 'Leviathan Wakes', status: 'imported' });
    (services.book.findDuplicate as Mock).mockResolvedValue({ verdict: 'different-recording', book: null, hasIncumbent: false });
    (services.book.create as Mock).mockImplementation((input: { title: string }) =>
      Promise.resolve({ id: 99, title: input.title, status: 'wanted', authors: [], narrators: [] }));
    (services.eventHistory.create as Mock).mockResolvedValue({ id: 1 });
    (services.seriesCard.getSeriesForBook as Mock).mockResolvedValue(seriesCard());
    app = await createTestApp(services);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('request validation', () => {
    it('404s an unknown book id without touching the series card or writing a row', async () => {
      (services.book.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'POST', url: URL, payload: { searchImmediately: false } });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Book not found' });
      expect(services.seriesCard.getSeriesForBook).not.toHaveBeenCalled();
      expect(services.book.create).not.toHaveBeenCalled();
    });

    it.each([
      ['an omitted searchImmediately', {}],
      ['a non-boolean searchImmediately', { searchImmediately: 'yes' }],
      ['an unknown key', { searchImmediately: true, includeNovellas: true }],
    ])('400s %s and creates nothing', async (_label, payload) => {
      const res = await app.inject({ method: 'POST', url: URL, payload });

      expect(res.statusCode).toBe(400);
      expect(services.book.create).not.toHaveBeenCalled();
    });

    it.each([true, false])('accepts searchImmediately: %s', async (searchImmediately) => {
      const res = await app.inject({ method: 'POST', url: URL, payload: { searchImmediately } });

      expect(res.statusCode).toBe(200);
      expect(res.json().created).toBe(1);
    });
  });

  describe('responses', () => {
    it('returns a zeroed batch when the book has no series card', async () => {
      (services.seriesCard.getSeriesForBook as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'POST', url: URL, payload: { searchImmediately: false } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ requested: 0, created: 0, owned: 0, held: 0, failed: 0, members: [] });
      expect(services.book.create).not.toHaveBeenCalled();
    });

    it('returns the per-member account for a completed batch', async () => {
      const res = await app.inject({ method: 'POST', url: URL, payload: { searchImmediately: false } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        requested: 1, created: 1, owned: 0, held: 0, failed: 0,
        members: [{ title: 'Leviathan Wakes', position: 1, disposition: 'created', bookId: 99 }],
      });
    });

    it('409s a second batch for the same series while one is in flight, and creates nothing for it', async () => {
      const gate = deferred<{ id: number; title: string; status: string; authors: []; narrators: [] }>();
      (services.book.create as Mock).mockReturnValueOnce(gate.promise);

      const first = app.inject({ method: 'POST', url: URL, payload: { searchImmediately: false } });
      await vi.waitFor(() => expect(services.book.create).toHaveBeenCalledTimes(1));

      const second = await app.inject({ method: 'POST', url: URL, payload: { searchImmediately: false } });

      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ error: 'Add All is already running for this series' });
      expect(services.book.create).toHaveBeenCalledTimes(1);

      gate.resolve({ id: 99, title: 'Leviathan Wakes', status: 'wanted', authors: [], narrators: [] });
      expect((await first).statusCode).toBe(200);
    });

    it('admits a second batch for the same series once the first has finished', async () => {
      expect((await app.inject({ method: 'POST', url: URL, payload: { searchImmediately: false } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: URL, payload: { searchImmediately: false } })).statusCode).toBe(200);
    });
  });

  describe('authenticated surface', () => {
    let authApp: ZodTestApp;
    let authHeader: string;

    beforeEach(async () => {
      const authServices = createMockServices();
      (authServices.book.getById as Mock).mockResolvedValue({ id: BOOK_ID, title: 'Leviathan Wakes', status: 'imported' });
      (authServices.seriesCard.getSeriesForBook as Mock).mockResolvedValue(null);

      ({ app: authApp, authHeader } = await createAuthTestApp(authServices, {
        db: inject<Db>(createMockDb()),
        routes: async (instance, svc, db) => {
          const { registerRoutes } = await import('./index.js');
          await registerRoutes(instance as never, svc, db);
        },
      }));
    });

    afterEach(async () => {
      await authApp.close();
    });

    it('401s an uncredentialed request and lets a credentialed one through', async () => {
      const anonymous = await authApp.inject({ method: 'POST', url: URL, payload: { searchImmediately: false } });
      expect(anonymous.statusCode).toBe(401);

      const authorized = await authApp.inject({
        method: 'POST',
        url: URL,
        headers: { authorization: authHeader, 'x-requested-with': 'XMLHttpRequest' },
        payload: { searchImmediately: false },
      });
      expect(authorized.statusCode).toBe(200);
    });

    it('403s a credentialed request that omits the CSRF header', async () => {
      const res = await authApp.inject({
        method: 'POST',
        url: URL,
        headers: { authorization: authHeader },
        payload: { searchImmediately: false },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
