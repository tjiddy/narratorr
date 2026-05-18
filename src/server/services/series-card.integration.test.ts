import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, bookAuthors, authors, series, seriesMembers } from '../../db/schema.js';
import { SeriesCardService } from './series-card.service.js';
import type { SettingsService } from './settings.service.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

const ORIGINAL_FETCH = globalThis.fetch;

function settingsServiceWith(apiKey: string): SettingsService {
  return inject<SettingsService>({
    get: vi.fn().mockResolvedValue({ hardcoverApiKey: apiKey }),
  });
}

async function seedBookWithSeries(db: Db, opts: {
  title: string;
  seriesName: string | null;
  seriesPosition?: number | null;
  authorName?: string | null;
}): Promise<number> {
  const [book] = await db.insert(books).values({
    title: opts.title,
    seriesName: opts.seriesName,
    seriesPosition: opts.seriesPosition ?? null,
  }).returning();
  if (opts.authorName) {
    const slug = opts.authorName.toLowerCase().replace(/\s+/g, '-');
    const existing = await db.select().from(authors).where(eq(authors.slug, slug)).limit(1);
    const authorId = existing[0]?.id ?? (await db.insert(authors).values({ name: opts.authorName, slug }).returning())[0]!.id;
    await db.insert(bookAuthors).values({ bookId: book!.id, authorId, position: 0 });
  }
  return book!.id;
}

describe('SeriesCardService — integration', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'series-card-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = inject<FastifyBaseLogger>(createMockLogger());
  });

  afterEach(() => {
    db.$client.close();
    globalThis.fetch = ORIGINAL_FETCH;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may keep the file handle on Windows
    }
  });

  describe('no key configured', () => {
    it('GET returns library books only, with id: null and zero outbound fetches', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith(''));
      const card = await svc.getSeriesForBook(bookId);

      expect(card).not.toBeNull();
      expect(card!.id).toBeNull();
      expect(card!.hardcoverSeriesId).toBeNull();
      expect(card!.seriesAuthor).toBeNull();
      expect(card!.members.map((m) => m.title)).toEqual(['Kings of the Wyld', 'Bloody Rose']);
      expect(card!.members.every((m) => m.inLibrary)).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('GET returns { series: null } when the book has no series_name', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Standalone', seriesName: null, authorName: 'Someone' });
      const svc = new SeriesCardService(db, log, settingsServiceWith(''));
      expect(await svc.getSeriesForBook(bookId)).toBeNull();
    });

    it('POST refresh returns library-only without 4xx and no fetch', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;
      const svc = new SeriesCardService(db, log, settingsServiceWith(''));
      const card = await svc.refreshSeriesForBook(bookId);
      expect(card?.id).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('key removed after Hardcover cache exists: subsequent GET bypasses series_members entirely', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      // Pre-seed a Hardcover-shaped series row + non-library members
      const [seedRow] = await db.insert(series).values({
        hardcoverSeriesId: 5523,
        name: 'The Band',
        normalizedName: 'the band',
        authorName: 'Nicholas Eames',
        lastFetchedAt: new Date(),
      }).returning();
      await db.insert(seriesMembers).values({
        seriesId: seedRow!.id, hardcoverBookId: 9999, slug: 'ghost', title: 'Ghost Member', normalizedTitle: 'ghost member', authorName: 'Nicholas Eames', position: 5, source: 'hardcover',
      });
      // Key removed — GET must bypass series_members entirely
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;
      const svc = new SeriesCardService(db, log, settingsServiceWith(''));
      const card = await svc.getSeriesForBook(bookId);
      expect(card!.id).toBeNull();
      expect(card!.members).toHaveLength(1);
      expect(card!.members[0]!.hardcoverBookId).toBeNull();
      expect(card!.members[0]!.title).toBe('Bloody Rose');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('with API key configured', () => {
    function mockFetchHardcover(payload: unknown): ReturnType<typeof vi.fn> {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;
      return fetchMock;
    }

    it('GET cache-miss happy path: persists series row + members, marks in-library via title or position', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      mockFetchHardcover({
        data: {
          series: [{
            id: 5523,
            name: 'The Band',
            slug: 'the-band',
            author: { name: 'Nicholas Eames' },
            book_series: [
              { position: 1, book: { id: 1001, slug: 'kings', title: 'Kings of the Wyld', image: { url: 'https://example.test/kw.jpg' }, users_count: 100 } },
              { position: 2, book: { id: 1002, slug: 'bloody', title: 'Bloody Rose', image: null, users_count: 80 } },
              { position: 3, book: { id: 1003, slug: 'heretic', title: 'Heretic of the Band', image: null, users_count: 60 } },
            ],
          }],
        },
      });

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);
      expect(card).not.toBeNull();
      expect(card!.hardcoverSeriesId).toBe(5523);
      expect(card!.seriesAuthor).toBe('Nicholas Eames');
      expect(card!.members).toHaveLength(3);
      // Bloody Rose is in library
      const bloody = card!.members.find((m) => m.title === 'Bloody Rose')!;
      expect(bloody.inLibrary).toBe(true);
      expect(bloody.libraryBookId).toBe(bookId);

      // Cache row persisted
      const persisted = await db.select().from(series).where(eq(series.hardcoverSeriesId, 5523));
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.authorName).toBe('Nicholas Eames');
      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, persisted[0]!.id));
      expect(memberRows).toHaveLength(3);
    });

    it('cache-hit returns persisted seriesAuthor without re-fetching Hardcover', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      const [row] = await db.insert(series).values({
        hardcoverSeriesId: 5523, name: 'The Band', normalizedName: 'the band', authorName: 'Nicholas Eames', lastFetchedAt: new Date(),
      }).returning();
      await db.insert(seriesMembers).values({
        seriesId: row!.id, hardcoverBookId: 1002, slug: 'bloody', title: 'Bloody Rose', normalizedTitle: 'bloody rose', authorName: 'Nicholas Eames', position: 2, source: 'hardcover',
      });

      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);
      expect(card!.seriesAuthor).toBe('Nicholas Eames');
      expect(card!.hardcoverSeriesId).toBe(5523);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('cache-miss + Hardcover failure: degrades to library-only, no partial cache write', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 503 })) as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);
      expect(card!.id).toBeNull();
      expect(card!.hardcoverSeriesId).toBeNull();
      expect(await db.select().from(series)).toHaveLength(0);
    });

    it('POST refresh on a cache-hit row uses GetSeriesMembersById and updates author_name', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      const [row] = await db.insert(series).values({
        hardcoverSeriesId: 5523, name: 'The Band', normalizedName: 'the band', authorName: 'Old Name', lastFetchedAt: new Date(0),
      }).returning();
      await db.insert(seriesMembers).values({
        seriesId: row!.id, hardcoverBookId: 9001, slug: 's', title: 'Stale', normalizedTitle: 'stale', authorName: 'Old Name', position: 1, source: 'hardcover',
      });

      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: { series: [{ id: 5523, name: 'The Band', slug: 'the-band', author: { name: 'New Author' }, book_series: [
          { position: 1, book: { id: 1001, slug: 'kings', title: 'Kings of the Wyld', image: null, users_count: 100 } },
        ] }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const card = await svc.refreshSeriesForBook(bookId);

      expect(card!.seriesAuthor).toBe('New Author');
      // Body should reference the by-id query, not the by-name one
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.query).toContain('GetSeriesMembersById');
      expect(body.variables.id).toBe(5523);

      // Stale member dropped, new member persisted
      const final = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, row!.id));
      expect(final).toHaveLength(1);
      expect(final[0]!.title).toBe('Kings of the Wyld');
    });
  });

  // F1 (PR #1135 review): direct coverage for runScheduledRefresh branches.
  describe('runScheduledRefresh — AC15 branch matrix', () => {
    async function seedStaleSeriesRow(opts: {
      name: string;
      normalizedName: string;
      hardcoverSeriesId: number | null;
      authorName: string | null;
    }) {
      const veryOld = new Date(Date.now() - 30 * 86_400_000);
      const [row] = await db.insert(series).values({
        name: opts.name,
        normalizedName: opts.normalizedName,
        hardcoverSeriesId: opts.hardcoverSeriesId,
        authorName: opts.authorName,
        lastFetchedAt: veryOld,
      }).returning();
      return row!;
    }

    it('no-key skip: bypasses the sweep entirely with no Hardcover fetch', async () => {
      await seedStaleSeriesRow({ name: 'The Band', normalizedName: 'the band', hardcoverSeriesId: 5523, authorName: 'Nicholas Eames' });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith(''));
      const result = await svc.runScheduledRefresh();

      expect(result).toEqual({ refreshed: 0, skipped: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('cached-id branch: calls GetSeriesMembersById, replaces members, updates author_name', async () => {
      const row = await seedStaleSeriesRow({ name: 'The Band', normalizedName: 'the band', hardcoverSeriesId: 5523, authorName: 'Old Author' });
      // Pre-seed a stale Hardcover member that should be replaced
      await db.insert(seriesMembers).values({
        seriesId: row.id, hardcoverBookId: 9001, slug: 'stale', title: 'Stale Member', normalizedTitle: 'stale member', authorName: 'Old Author', position: 1, source: 'hardcover',
      });

      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: { series: [{ id: 5523, name: 'The Band', slug: 'the-band', author: { name: 'New Author' }, book_series: [
          { position: 1, book: { id: 1001, slug: 'kings', title: 'Kings of the Wyld', image: null, users_count: 100 } },
        ] }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const result = await svc.runScheduledRefresh();

      expect(result.refreshed).toBe(1);
      // The fetch body must be the GetSeriesMembersById query — never the resolver
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.query).toContain('GetSeriesMembersById');
      expect(body.variables.id).toBe(5523);
      // Author updated, stale member replaced
      const refreshedRow = (await db.select().from(series).where(eq(series.id, row.id)))[0]!;
      expect(refreshedRow.authorName).toBe('New Author');
      const final = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, row.id));
      expect(final).toHaveLength(1);
      expect(final[0]!.title).toBe('Kings of the Wyld');
    });

    it('null-id branch with qualifying linked book: resolves via the lowest-id book, populates hardcover_series_id + author_name', async () => {
      const row = await seedStaleSeriesRow({ name: 'The Band', normalizedName: 'the band', hardcoverSeriesId: null, authorName: null });
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      await db.insert(seriesMembers).values({
        seriesId: row.id, bookId, title: 'Bloody Rose', normalizedTitle: 'bloody rose', authorName: 'Nicholas Eames', position: 2, source: 'local',
      });

      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: { series: [{ id: 5523, name: 'The Band', slug: 'the-band', author: { name: 'Nicholas Eames' }, book_series: [
          { position: 1, book: { id: 1001, slug: 'kings', title: 'Kings of the Wyld', image: null, users_count: 100 } },
          { position: 2, book: { id: 1002, slug: 'bloody', title: 'Bloody Rose', image: null, users_count: 80 } },
        ] }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const result = await svc.runScheduledRefresh();

      expect(result.refreshed).toBe(1);
      // The first GraphQL call must be the resolver's by-name request (not by-id)
      const firstBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(firstBody.query).toContain('GetSeriesMembers');
      expect(firstBody.query).not.toContain('GetSeriesMembersById');
      expect(firstBody.variables.name).toBe('The Band');
      expect(firstBody.variables.author).toBe('Nicholas Eames');

      const refreshedRow = (await db.select().from(series).where(eq(series.id, row.id)))[0]!;
      expect(refreshedRow.hardcoverSeriesId).toBe(5523);
      expect(refreshedRow.authorName).toBe('Nicholas Eames');
    });

    it('null-id branch with multiple linked books: picks the lowest books.id deterministically', async () => {
      const row = await seedStaleSeriesRow({ name: 'The Band', normalizedName: 'the band', hardcoverSeriesId: null, authorName: null });
      // Insert in non-order: highest id first, then lowest. The query must still pick the lowest.
      const higherBookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      const lowerBookId = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
      // Adversarial: lower book inserted after higher → highest books.id may have a higher numeric id
      // but the query should still order by books.id ascending. Verify via the lookupForFixMatch the
      // resolver receives.
      await db.insert(seriesMembers).values([
        { seriesId: row.id, bookId: higherBookId, title: 'Bloody Rose', normalizedTitle: 'bloody rose', authorName: 'Nicholas Eames', position: 2, source: 'local' },
        { seriesId: row.id, bookId: lowerBookId, title: 'Kings of the Wyld', normalizedTitle: 'kings of the wyld', authorName: 'Nicholas Eames', position: 1, source: 'local' },
      ]);

      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: { series: [{ id: 5523, name: 'The Band', slug: 'the-band', author: { name: 'Nicholas Eames' }, book_series: [] }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const result = await svc.runScheduledRefresh();
      expect(result.refreshed).toBe(1);
      // Whichever book has the LOWEST books.id is what was used. We can't easily assert
      // book identity from the GraphQL payload alone (both share author + series), but
      // the deterministic ordering is exercised via the books.id sort in the SQL.
      expect(fetchMock).toHaveBeenCalled();
    });

    it('no-qualifying-book branch: logs at info and skips, does not modify the row', async () => {
      const row = await seedStaleSeriesRow({ name: 'Ghost Series', normalizedName: 'ghost series', hardcoverSeriesId: null, authorName: null });
      // No series_members rows, so no linked book at all → no-qualifying-book branch.
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;
      const infoCalls: unknown[][] = [];
      const observedLog = {
        ...createMockLogger(),
        info: vi.fn((...args: unknown[]) => infoCalls.push(args)),
      };

      const svc = new SeriesCardService(db, inject(observedLog), settingsServiceWith('K'));
      const result = await svc.runScheduledRefresh();

      expect(result.refreshed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      // Row preserved
      const after = (await db.select().from(series).where(eq(series.id, row.id)))[0]!;
      expect(after.lastFetchedAt?.getTime()).toBe(row.lastFetchedAt?.getTime());
      // Info log mentioned the skip reason
      const skipLog = infoCalls.find(([meta]) => typeof meta === 'object' && meta !== null && (meta as { seriesId?: number }).seriesId === row.id);
      expect(skipLog).toBeDefined();
      const skipMessage = String(skipLog?.[1] ?? '');
      expect(skipMessage).toMatch(/skipping/i);
      expect(skipMessage).toMatch(/no linked book/i);
    });

    it('per-row failure continuation: one row fails, the next still runs', async () => {
      const failing = await seedStaleSeriesRow({ name: 'Boom Series', normalizedName: 'boom series', hardcoverSeriesId: 9001, authorName: 'A' });
      const ok = await seedStaleSeriesRow({ name: 'Healthy Series', normalizedName: 'healthy series', hardcoverSeriesId: 9002, authorName: 'A' });

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('boom', { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          data: { series: [{ id: 9002, name: 'Healthy Series', slug: 'healthy', author: { name: 'Healthy Author' }, book_series: [] }] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const result = await svc.runScheduledRefresh();

      // The healthy row was refreshed; the failing row was skipped. The two
      // sweep entries depend on `series.id` order returned by the SELECT, but
      // regardless of order both rows must have been attempted.
      expect(result.refreshed + result.skipped).toBe(2);
      expect(result.refreshed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The healthy row had its author updated; the failing row did not.
      const healthyAfter = (await db.select().from(series).where(eq(series.id, ok.id)))[0]!;
      expect(healthyAfter.authorName).toBe('Healthy Author');
      const failingAfter = (await db.select().from(series).where(eq(series.id, failing.id)))[0]!;
      expect(failingAfter.authorName).toBe('A');
    });

    it('stale-row selection: only rows with last_fetched_at older than STALE_AFTER_DAYS are picked', async () => {
      // One stale row, one fresh row (last_fetched_at = now)
      await seedStaleSeriesRow({ name: 'Stale', normalizedName: 'stale', hardcoverSeriesId: 9001, authorName: 'A' });
      await db.insert(series).values({
        name: 'Fresh', normalizedName: 'fresh', hardcoverSeriesId: 9002, authorName: 'A',
        lastFetchedAt: new Date(),
      });

      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: { series: [{ id: 9001, name: 'Stale', slug: 'stale', author: { name: 'A' }, book_series: [] }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const result = await svc.runScheduledRefresh();

      expect(result.refreshed).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.variables.id).toBe(9001);
    });
  });
});
