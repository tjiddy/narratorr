import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePublicId } from '../utils/public-id.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, bookAuthors, authors, series, seriesMembers } from '@db/schema.js';
import { SeriesCardService } from './series-card.service.js';
import type { SettingsService } from './settings.service.js';
import { upsertSeriesLink } from './book-series-link.js';
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
  const [book] = await db.insert(books).values({ publicId: generatePublicId('bk'),
    title: opts.title,
    seriesName: opts.seriesName,
    seriesPosition: opts.seriesPosition ?? null,
  }).returning();
  if (opts.authorName) {
    const slug = opts.authorName.toLowerCase().replace(/\s+/g, '-');
    const existing = await db.select().from(authors).where(eq(authors.slug, slug)).limit(1);
    const authorId = existing[0]?.id ?? (await db.insert(authors).values({ publicId: generatePublicId('au'), name: opts.authorName, slug }).returning())[0]!.id;
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
      const [seedRow] = await db.insert(series).values({ publicId: generatePublicId('sr'),
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

      // AC5.3 regression: Hardcover `image.url` must still flow into the
      // persisted row AND the returned card even though the component no
      // longer renders thumbnails (#1139 Bug 5). Deleting the production
      // assignment `imageUrl: member.imageUrl` in `persistAndBuildCard` must
      // make these assertions fail; deleting the DB column or the read
      // mapping must also fail them.
      const kings = card!.members.find((m) => m.title === 'Kings of the Wyld')!;
      expect(kings.imageUrl).toBe('https://example.test/kw.jpg');
      expect(bloody.imageUrl).toBeNull();

      // Cache row persisted
      const persisted = await db.select().from(series).where(eq(series.hardcoverSeriesId, 5523));
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.authorName).toBe('Nicholas Eames');
      // #1443 — upsertHardcoverSeries creates the row with an opaque sr_ publicId.
      expect(persisted[0]!.publicId).toMatch(/^sr_/);
      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, persisted[0]!.id));
      expect(memberRows).toHaveLength(3);
      const kingsRow = memberRows.find((m) => m.title === 'Kings of the Wyld')!;
      expect(kingsRow.imageUrl).toBe('https://example.test/kw.jpg');
      const bloodyRow = memberRows.find((m) => m.title === 'Bloody Rose')!;
      expect(bloodyRow.imageUrl).toBeNull();
    });

    it('cache-hit returns persisted seriesAuthor without re-fetching Hardcover', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      const [row] = await db.insert(series).values({ publicId: generatePublicId('sr'),
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
      const [row] = await db.insert(series).values({ publicId: generatePublicId('sr'),
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

      // Stale member dropped, new member persisted.
      const final = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, row!.id));
      const hardcover = final.filter((m) => m.source === 'hardcover');
      expect(hardcover).toHaveLength(1);
      expect(hardcover[0]!.title).toBe('Kings of the Wyld');
      // The owned Bloody Rose pairs with no member in this payload, so #2144's
      // invariant gives it a local row of its own — it is still the operator's
      // book and still belongs on the card.
      const local = final.filter((m) => m.source === 'local');
      expect(local).toHaveLength(1);
      expect(local[0]!.bookId).toBe(bookId);
      expect(card!.members.map((m) => m.title)).toEqual(['Kings of the Wyld', 'Bloody Rose']);
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
      const [row] = await db.insert(series).values({ publicId: generatePublicId('sr'),
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
      const row = await seedStaleSeriesRow({ name: 'Shared Series', normalizedName: 'shared series', hardcoverSeriesId: null, authorName: null });
      // Give each candidate book observably distinct seriesName + author so the
      // GraphQL request the resolver issues proves WHICH book was picked. The
      // `lower` book is inserted first → gets the lower books.id; if
      // orderBy(asc(books.id)) is broken, the resolver will issue the
      // higher-id book's name/author instead and the assertions below will
      // fail. Both books still link to the same stale series row via
      // series_members.seriesId, so the sweep treats them as siblings.
      const lowerBookId = await seedBookWithSeries(db, {
        title: 'Kings of the Wyld',
        seriesName: 'Lower Series Name',
        seriesPosition: 1,
        authorName: 'Lower Author',
      });
      const higherBookId = await seedBookWithSeries(db, {
        title: 'Bloody Rose',
        seriesName: 'Higher Series Name',
        seriesPosition: 2,
        authorName: 'Higher Author',
      });
      // Insert series_members rows in the OPPOSITE order from books.id to
      // make sure the query's orderBy(asc(books.id)) is the load-bearing
      // signal, not the insertion order of the member rows.
      await db.insert(seriesMembers).values([
        { seriesId: row.id, bookId: higherBookId, title: 'Bloody Rose', normalizedTitle: 'bloody rose', authorName: 'Higher Author', position: 2, source: 'local' },
        { seriesId: row.id, bookId: lowerBookId, title: 'Kings of the Wyld', normalizedTitle: 'kings of the wyld', authorName: 'Lower Author', position: 1, source: 'local' },
      ]);
      expect(lowerBookId).toBeLessThan(higherBookId);

      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: { series: [{ id: 5523, name: 'Lower Series Name', slug: 'lower', author: { name: 'Lower Author' }, book_series: [] }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const result = await svc.runScheduledRefresh();

      expect(result.refreshed).toBe(1);
      // The GraphQL variables MUST come from the lower-id book. Reversing the
      // orderBy in the production code would send 'Higher Series Name' /
      // 'Higher Author' instead and fail both assertions.
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.variables.name).toBe('Lower Series Name');
      expect(body.variables.author).toBe('Lower Author');
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
      await db.insert(series).values({ publicId: generatePublicId('sr'),
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

  // #1139 polish: cross-cutting integration coverage for the dedup + ordering fixes.
  describe('#1139 polish — dedup, NULL ordering, post-create dedup', () => {
    /**
     * AC1.4: After the Hardcover cache is established, the book-create /
     * re-import path's `upsertSeriesLink` must NOT add a second local row for
     * a book already covered by a Hardcover member. The series card must
     * render that book exactly once.
     */
    it('AC1.4: upsertSeriesLink after Hardcover cache exists does not add a duplicate row', async () => {
      // Seed a Hardcover-cached series with one Hardcover member
      const [seedRow] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 5523,
        name: 'The Band',
        normalizedName: 'the band',
        authorName: 'Nicholas Eames',
        lastFetchedAt: new Date(),
      }).returning();
      await db.insert(seriesMembers).values({
        seriesId: seedRow!.id,
        hardcoverBookId: 1002,
        slug: 'bloody',
        title: 'Bloody Rose',
        normalizedTitle: 'bloody rose',
        authorName: 'Nicholas Eames',
        position: 2,
        source: 'hardcover',
      });

      // Now "create" a library book in this series — simulates the book-create / re-import path
      const bookId = await seedBookWithSeries(db, {
        title: 'Bloody Rose',
        seriesName: 'The Band',
        seriesPosition: 2,
        authorName: 'Nicholas Eames',
      });
      await upsertSeriesLink(db, log, bookId, {
        name: 'The Band',
        position: 2,
        title: 'Bloody Rose',
        authorName: 'Nicholas Eames',
      });

      // series_members must still hold exactly one row for this series
      const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seedRow!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe('hardcover');

      // The card view shows Bloody Rose exactly once, matched to the new library book
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);
      expect(card!.hardcoverSeriesId).toBe(5523);
      const matches = card!.members.filter((m) => m.title === 'Bloody Rose');
      expect(matches).toHaveLength(1);
      expect(matches[0]!.inLibrary).toBe(true);
      expect(matches[0]!.libraryBookId).toBe(bookId);
    });

    /**
     * AC2.4 + AC2.6: Two Hardcover members must not BOTH claim the same library
     * book during persist; only one row gets the `bookId` populated.
     *
     * The fixture uses two UNPOSITIONED members whose titles both pair with the
     * library book: since #2097 the adapter keeps at most one work per finite
     * position, so two same-position members no longer reach `persistMembers` —
     * while unpositioned works, which used to collapse under `DISTINCT ON`, now
     * all arrive, making the shared claim set more load-bearing than before.
     */
    it('AC2.6: persist path does not duplicate library bookId across rows in the same series', async () => {
      const bookId = await seedBookWithSeries(db, {
        title: 'Bloody Rose',
        seriesName: 'The Band',
        seriesPosition: 2,
        authorName: 'Nicholas Eames',
      });
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: {
          series: [{
            id: 5523, name: 'The Band', slug: 'the-band', author: { name: 'Nicholas Eames' },
            book_series: [
              { position: 1, book: { id: 1001, slug: 'kings', title: 'Kings of the Wyld', image: null, users_count: 100 } },
              { position: null, book: { id: 1002, slug: 'bloody-a', title: 'Bloody Rose: Part One', image: null, users_count: 80 } },
              { position: null, book: { id: 1003, slug: 'bloody-b', title: 'Bloody Rose: Part Two', image: null, users_count: 60 } },
            ],
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(bookId);

      // Pull every series_member row and check no bookId is duplicated
      const persisted = await db.select().from(series).where(eq(series.hardcoverSeriesId, 5523));
      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, persisted[0]!.id));
      const populatedBookIds = memberRows.map((m) => m.bookId).filter((v): v is number => v !== null);
      expect(populatedBookIds).toHaveLength(1);
      expect(populatedBookIds[0]).toBe(bookId);
    });

    /**
     * AC2.4: Same dedup must hold in the cache-driven render path — only the
     * first member processed claims the library book.
     */
    it('AC2.4: cache render does not mark two Hardcover members at the same position as both in-library', async () => {
      const bookId = await seedBookWithSeries(db, {
        title: 'Bloody Rose',
        seriesName: 'The Band',
        seriesPosition: 2,
        authorName: 'Nicholas Eames',
      });
      const [seedRow] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 5523, name: 'The Band', normalizedName: 'the band', authorName: 'Nicholas Eames', lastFetchedAt: new Date(),
      }).returning();
      // Two Hardcover rows at position 2 — only ONE should show inLibrary=true
      await db.insert(seriesMembers).values([
        { seriesId: seedRow!.id, hardcoverBookId: 1002, slug: 'a', title: 'Bloody Rose A', normalizedTitle: 'bloody rose a', authorName: 'Nicholas Eames', position: 2, source: 'hardcover' },
        { seriesId: seedRow!.id, hardcoverBookId: 1003, slug: 'b', title: 'Bloody Rose B', normalizedTitle: 'bloody rose b', authorName: 'Nicholas Eames', position: 2, source: 'hardcover' },
      ]);

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      const inLibraryMembers = card!.members.filter((m) => m.inLibrary);
      expect(inLibraryMembers).toHaveLength(1);
      expect(inLibraryMembers[0]!.libraryBookId).toBe(bookId);
    });

    /**
     * #2097 AC14 — the live prod case (2026-08-03), end to end against a real
     * migrated DB: World of Warcraft (hardcover_series_id 2375) position 15
     * carries the Russian work "…: Перед бурей" (62 readers) alongside the
     * English "Before the Storm" (7). Hasura used to collapse the pair by
     * readership, so the cached row and the card both showed the Cyrillic title.
     *
     * The assertions walk the whole chain — persisted row, its `book_id` link,
     * and the rendered member — because a picker that only fixed the mapped
     * member would still leave the wrong title in `series_members`.
     */
    it('#2097 AC14: persists and renders the English work at WoW position 15, not the more-read Russian one', async () => {
      const bookId = await seedBookWithSeries(db, {
        title: 'Before the Storm',
        seriesName: 'World of Warcraft',
        seriesPosition: 15,
        authorName: 'Christie Golden',
      });
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: {
          series: [{
            id: 2375, name: 'World of Warcraft', slug: 'world-of-warcraft', author: { name: 'Christie Golden' },
            book_series: [
              { position: 14, book: { id: 300, slug: 'illidan', title: 'Illidan', image: null, users_count: 200 } },
              { position: 15, book: { id: 465829, slug: 'pered-burey', title: 'World of Warcraft: Перед бурей', image: null, users_count: 62 } },
              { position: 15, book: { id: 331, slug: 'before-the-storm', title: 'Before the Storm', image: null, users_count: 7 } },
            ],
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      const persisted = await db.select().from(series).where(eq(series.hardcoverSeriesId, 2375));
      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, persisted[0]!.id));
      const atFifteen = memberRows.filter((m) => m.position === 15);
      expect(atFifteen).toHaveLength(1);
      expect(atFifteen[0]!.title).toBe('Before the Storm');
      expect(atFifteen[0]!.hardcoverBookId).toBe(331);
      expect(atFifteen[0]!.bookId).toBe(bookId);

      const rendered = card!.members.filter((m) => m.position === 15);
      expect(rendered).toHaveLength(1);
      expect(rendered[0]!.title).toBe('Before the Storm');
      expect(rendered[0]!.inLibrary).toBe(true);
      expect(rendered[0]!.libraryBookId).toBe(bookId);
    });

    /**
     * #2097 AC3 + AC12 — `DISTINCT ON` treated SQL NULLs as equal, so several
     * unpositioned works in one series used to arrive as a single row. Each now
     * persists on its own: `series_members` has no unique index on
     * `(series_id, position)` (the two unique indexes are keyed by Hardcover id
     * and by local book id), so there is no constraint violation and no silent
     * overwrite.
     */
    it('#2097 AC3: persists one row per unpositioned work instead of collapsing them', async () => {
      const bookId = await seedBookWithSeries(db, {
        title: 'Kings of the Wyld',
        seriesName: 'The Band',
        seriesPosition: 1,
        authorName: 'Nicholas Eames',
      });
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: {
          series: [{
            id: 5523, name: 'The Band', slug: 'the-band', author: { name: 'Nicholas Eames' },
            book_series: [
              { position: 1, book: { id: 1001, slug: 'kings', title: 'Kings of the Wyld', image: null, users_count: 100 } },
              { position: null, book: { id: 2001, slug: 'art-book', title: 'The Art of the Band', image: null, users_count: 9 } },
              { position: null, book: { id: 2002, slug: 'companion', title: 'A Band Companion', image: null, users_count: 4 } },
              { position: null, book: { id: 2003, slug: 'sketches', title: 'Sketches from the Road', image: null, users_count: 1 } },
            ],
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      const persisted = await db.select().from(series).where(eq(series.hardcoverSeriesId, 5523));
      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, persisted[0]!.id));
      expect(memberRows).toHaveLength(4);
      const unpositioned = memberRows.filter((m) => m.position === null);
      expect(unpositioned.map((m) => m.hardcoverBookId).sort((a, b) => a! - b!)).toEqual([2001, 2002, 2003]);
      expect(card!.members).toHaveLength(4);
    });

    /**
     * AC3.1: Cache mode places NULL positions LAST.
     */
    it('AC3.1: cache mode renders [1, 2.5, 4, null] order regardless of insertion order', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Anchor Book', seriesName: 'Test Series', seriesPosition: 1, authorName: 'Some Author' });
      const [seedRow] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 9999, name: 'Test Series', normalizedName: 'test series', authorName: 'Some Author', lastFetchedAt: new Date(),
      }).returning();
      // Insert in mixed order including NULL position
      await db.insert(seriesMembers).values([
        { seriesId: seedRow!.id, hardcoverBookId: 4, slug: 'd', title: 'Companion', normalizedTitle: 'companion', authorName: 'Some Author', position: null, source: 'hardcover' },
        { seriesId: seedRow!.id, hardcoverBookId: 3, slug: 'c', title: 'Book Four', normalizedTitle: 'book four', authorName: 'Some Author', position: 4, source: 'hardcover' },
        { seriesId: seedRow!.id, hardcoverBookId: 1, slug: 'a', title: 'Book One', normalizedTitle: 'book one', authorName: 'Some Author', position: 1, source: 'hardcover' },
        { seriesId: seedRow!.id, hardcoverBookId: 2, slug: 'b', title: 'Book Two-Five', normalizedTitle: 'book two-five', authorName: 'Some Author', position: 2.5, source: 'hardcover' },
      ]);

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      expect(card!.members.map((m) => m.position)).toEqual([1, 2.5, 4, null]);
    });

    /**
     * AC3.2: Library-only mode produces the same NULLS-LAST order.
     */
    it('AC3.2: library-only mode places NULL position last with the same comparator', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Anchor', seriesName: 'Test Series', seriesPosition: 1, authorName: 'Some Author' });
      await seedBookWithSeries(db, { title: 'Companion', seriesName: 'Test Series', seriesPosition: null, authorName: 'Some Author' });
      await seedBookWithSeries(db, { title: 'Book Four', seriesName: 'Test Series', seriesPosition: 4, authorName: 'Some Author' });
      await seedBookWithSeries(db, { title: 'Book Two-Five', seriesName: 'Test Series', seriesPosition: 2.5, authorName: 'Some Author' });

      const svc = new SeriesCardService(db, log, settingsServiceWith(''));
      const card = await svc.getSeriesForBook(bookId);

      // Anchor is position=1, then 2.5, then 4, then NULL Companion
      expect(card!.members.map((m) => m.position)).toEqual([1, 2.5, 4, null]);
      expect(card!.members.map((m) => m.title)).toEqual(['Anchor', 'Book Two-Five', 'Book Four', 'Companion']);
    });
  });

  // #2096: the live production case. A Hardcover member "Chapterhouse: Dune" at
  // position 6 against a library "Chapterhouse Dune" carrying a stale position 17
  // failed BOTH signals — the member colon-truncated to `chapterhouse`, and the
  // positions disagreed — so the bind left the stale position and the Series panel
  // offered "+Add" for a book the user already owned.
  describe('#2096 — colon-separated member titles', () => {
    function mockFetchHardcover(payload: unknown): ReturnType<typeof vi.fn> {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;
      return fetchMock;
    }

    function chapterhousePayload() {
      return {
        data: {
          series: [{
            id: 7701,
            name: 'Dune',
            slug: 'dune',
            author: { name: 'Frank Herbert' },
            book_series: [
              { position: 6, book: { id: 2001, slug: 'chapterhouse-dune', title: 'Chapterhouse: Dune', image: null, users_count: 50 } },
            ],
          }],
        },
      };
    }

    it('binds Chapterhouse: Dune to a stale-position library Chapterhouse Dune and syncs both fields', async () => {
      const bookId = await seedBookWithSeries(db, {
        title: 'Chapterhouse Dune',
        seriesName: 'Dune Chronicles',
        seriesPosition: 17,
        authorName: 'Frank Herbert',
      });
      mockFetchHardcover(chapterhousePayload());

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const bound = await svc.bindHardcoverSeries(bookId, 7701);

      expect(bound).not.toBeNull();
      const member = bound!.card.members.find((m) => m.title === 'Chapterhouse: Dune')!;
      expect(member.inLibrary).toBe(true);
      expect(member.libraryBookId).toBe(bookId);

      // The bind syncs BOTH durable fields — the stale 17 is rewritten to 6.
      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.seriesName).toBe('Dune');
      expect(row!.seriesPosition).toBe(6);
    });

    it('persistMembers writes the new colon-separated normalized form (no migration needed)', async () => {
      const bookId = await seedBookWithSeries(db, {
        title: 'Chapterhouse Dune',
        seriesName: 'Dune',
        seriesPosition: 17,
        authorName: 'Frank Herbert',
      });
      mockFetchHardcover(chapterhousePayload());

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(bookId);

      const memberRows = await db.select().from(seriesMembers);
      expect(memberRows).toHaveLength(1);
      // Pre-#2096 this column received `chapterhouse`; it now receives the full
      // separator form. The column has zero production read sites, so the value
      // simply changes shape with no backfill.
      expect(memberRows[0]!.normalizedTitle).toBe('chapterhouse dune');
    });

    it('inserts a member whose normalized title is empty (notNull but not non-empty)', async () => {
      const bookId = await seedBookWithSeries(db, {
        title: 'Anchor',
        seriesName: 'Odd Series',
        seriesPosition: 1,
        authorName: 'Some Author',
      });
      mockFetchHardcover({
        data: {
          series: [{
            id: 7702,
            name: 'Odd Series',
            slug: 'odd',
            author: { name: 'Some Author' },
            book_series: [
              { position: 1, book: { id: 3001, slug: 'anchor', title: 'Anchor', image: null, users_count: 10 } },
              { position: null, book: { id: 3002, slug: 'art', title: '[ ]', image: null, users_count: 5 } },
            ],
          }],
        },
      });

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      const rows = await db.select().from(seriesMembers);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.title === '[ ]')!.normalizedTitle).toBe('');
      // An empty variant set never claims a candidate on the title path, and this
      // member has no position to be rescued by either.
      expect(card!.members.find((m) => m.title === '[ ]')!.inLibrary).toBe(false);
    });
  });

  // #2108: `loadLibraryBooksForSeriesNames` pins `ORDER BY books.id`, because
  // `findInLibraryMatch` is first-claim-wins WITHIN a match-quality tier — so
  // pool order is the only deciding input when two candidates pair on the same
  // tier, and unordered that sequence is a query-planner accident.
  describe('#2108 — pinned candidate claim order', () => {
    // Both traps that would make this test green-but-vacuous are closed here:
    //
    //  - WITHOUT the forced index the planner emits `SCAN books` and rowid order
    //    falls out anyway, so the pool is id-ascending with or without the
    //    `.orderBy()`. The `CREATE INDEX` drives it onto
    //    `SEARCH … USING COVERING INDEX (series_name=?)`, which returns rows in
    //    series_name order instead — hence the deliberately INVERTED seeding
    //    (lower id → 'Zeta Series', higher id → 'Alpha Series').
    //  - With CROSS-TIER candidates the arm ranking would pick the winner
    //    regardless of order, and the `.orderBy()` could be deleted with the test
    //    still green. Both books therefore pair `full-equals-full` with the same
    //    member (both titles normalize to `chapterhouse dune`) — one tier, so
    //    only the SQL order decides.
    //
    // Counterfactuals, both run and recorded: deleting `.orderBy(asc(books.id))`
    // flips the claim to the higher id and this test FAILS; deleting the
    // `CREATE INDEX` below leaves it passing on both branches, which is exactly
    // what makes the index non-optional here.
    it('claims the lower-id book when two same-tier candidates compete under an index', async () => {
      const lowerId = await seedBookWithSeries(db, {
        title: 'Chapterhouse Dune',
        seriesName: 'Zeta Series',
        seriesPosition: null,
        authorName: 'Frank Herbert',
      });
      const higherId = await seedBookWithSeries(db, {
        title: 'Chapterhouse: Dune',
        seriesName: 'Alpha Series',
        seriesPosition: null,
        authorName: 'Frank Herbert',
      });
      expect(higherId).toBeGreaterThan(lowerId);

      // Not in the production schema (#2108 does not add it) — created here so
      // the planner reorders the pool, which is the whole point of the fixture.
      await db.run(sql`CREATE INDEX idx_books_series_name_2108 ON books (series_name)`);

      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: {
          series: [{
            id: 7703,
            name: 'Zeta Series',
            slug: 'zeta-series',
            author: { name: 'Frank Herbert' },
            book_series: [
              // Position null, so the position pass never fires and the title
              // pass — the pass this issue changes — is what decides.
              { position: null, book: { id: 4001, slug: 'chapterhouse-dune', title: 'Chapterhouse: Dune', image: null, users_count: 50 } },
            ],
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      // Bind from the HIGHER-id book, whose prior series name is 'Alpha Series':
      // `bindHardcoverSeries` passes `resolved.name` plus the initiating book's
      // prior name to `persistMembers`, so the pool is
      // `IN ('Zeta Series','Alpha Series')` and spans both books.
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const bound = await svc.bindHardcoverSeries(higherId, 7703);

      expect(bound).not.toBeNull();
      const memberRows = await db.select().from(seriesMembers);
      // The ONE Hardcover member claimed the lower-id book — the assertion this
      // fixture exists for. The higher-id initiating book adopted the canonical
      // name unmatched, so #2144 gives it its own local row; that row is a
      // consequence of the claim going the other way, not the claim itself.
      const hardcover = memberRows.filter((m) => m.source === 'hardcover');
      expect(hardcover).toHaveLength(1);
      expect(hardcover[0]!.bookId).toBe(lowerId);
      expect(memberRows.filter((m) => m.source === 'local').map((m) => m.bookId)).toEqual([higherId]);
      expect(bound!.card.members[0]!.hardcoverBookId).toBe(4001);
      expect(bound!.card.members[0]!.libraryBookId).toBe(lowerId);
    });
  });

  // #2144 — a library book with a series name must appear on that series' member
  // list regardless of what Hardcover thinks. Hardcover's member queries exclude
  // dateless works, so a "Planned book" stub leaves a hole the operator's own
  // book falls through: not paired (nothing to pair with), and not seeded (the
  // `upsertSeriesLink` canonical-series guard suppressed the local row).
  describe('#2144 — owned books Hardcover does not expose', () => {
    function mockFetchHardcover(payload: unknown): ReturnType<typeof vi.fn> {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;
      return fetchMock;
    }

    /** The live series: Hardcover exposes 1/3/4/5; position 2 is a dateless stub. */
    function azerothPayload(withPositionTwo: boolean): unknown {
      const members = [
        { position: 1, book: { id: 8001, slug: 'eastern-kingdoms', title: 'Exploring Azeroth: The Eastern Kingdoms', image: null, users_count: 90 } },
        { position: 3, book: { id: 8003, slug: 'northrend', title: 'Exploring Azeroth: Northrend', image: null, users_count: 70 } },
        { position: 4, book: { id: 8004, slug: 'pandaria', title: 'Exploring Azeroth: Pandaria', image: null, users_count: 60 } },
        { position: 5, book: { id: 8005, slug: 'outland', title: 'Exploring Azeroth: Outland', image: null, users_count: 50 } },
      ];
      if (withPositionTwo) {
        members.splice(1, 0, { position: 2, book: { id: 8002, slug: 'kalimdor', title: 'Exploring Azeroth: Kalimdor', image: null, users_count: 80 } });
      }
      return {
        data: {
          series: [{ id: 25106, name: 'Exploring Azeroth', slug: 'exploring-azeroth', author: { name: 'Christie Golden' }, book_series: members }],
        },
      };
    }

    it('renders and persists the owned position-2 book Hardcover only exposes as a dateless stub', async () => {
      const kalimdor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      await seedBookWithSeries(db, { title: 'Exploring Azeroth: The Eastern Kingdoms', seriesName: 'Exploring Azeroth', seriesPosition: 1, authorName: 'Christie Golden' });
      await seedBookWithSeries(db, { title: 'Exploring Azeroth: Northrend', seriesName: 'Exploring Azeroth', seriesPosition: 3, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(kalimdor);

      expect(card!.members.map((m) => m.position)).toEqual([1, 2, 3, 4, 5]);
      const owned = card!.members[1]!;
      expect(owned).toMatchObject({
        inLibrary: true,
        libraryBookId: kalimdor,
        hardcoverBookId: null,
        slug: null,
        imageUrl: null,
        title: 'Exploring Azeroth: Kalimdor',
      });

      const seriesRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 25106)))[0]!;
      const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow.id));
      expect(rows).toHaveLength(5);
      const local = rows.filter((r) => r.source === 'local');
      expect(local).toHaveLength(1);
      expect(local[0]!.bookId).toBe(kalimdor);
    });

    /**
     * F3 (spec review): the durable row's COMPLETE shape, not just its count and
     * source. Every field is independently required by AC6 — the provider columns
     * must be NULL so the partial local unique index constrains the row, the title
     * and normalized title must come from the book, the author must be the BOOK's
     * primary author rather than the series author, and the position must be
     * verbatim (position `0` is the case a falsy coercion would silently destroy).
     */
    it('F3: the seeded row carries the exact AC6 shape, including position 0 and the tie-broken primary author', async () => {
      // Two authors at the SAME `book_authors.position` — the defaulted/legacy
      // shape the `author_id` tie-break exists for. The lower author_id wins, and
      // it is deliberately NOT the alphabetically-first name, so an implementation
      // ordering by name instead of by id fails here.
      const prequel = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Prequel', seriesName: 'Exploring Azeroth', seriesPosition: 0, authorName: 'Zara Primary' });
      const [second] = await db.insert(authors).values({ publicId: generatePublicId('au'), name: 'Aaron Secondary', slug: 'aaron-secondary' }).returning();
      await db.insert(bookAuthors).values({ bookId: prequel, authorId: second!.id, position: 0 });
      // A second unclaimed book with no author link at all → authorName null.
      const orphan = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Orphan', seriesName: 'Exploring Azeroth', seriesPosition: 6, authorName: null });
      mockFetchHardcover(azerothPayload(false));

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(prequel);

      const seriesRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 25106)))[0]!;
      const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow.id));
      const prequelRow = rows.find((r) => r.bookId === prequel)!;
      expect(prequelRow).toMatchObject({
        seriesId: seriesRow.id,
        bookId: prequel,
        hardcoverBookId: null,
        slug: null,
        imageUrl: null,
        title: 'Exploring Azeroth: Prequel',
        normalizedTitle: 'exploring azeroth prequel',
        authorName: 'Zara Primary',
        position: 0,
        source: 'local',
      });
      expect(rows.find((r) => r.bookId === orphan)!.authorName).toBeNull();
    });

    /**
     * AC8 — supersession through the POSITION arm, via the existing
     * delete-and-rebuild. No "upgrade" code path exists or is wanted.
     */
    it('AC8: a later refresh carrying the real member leaves one canonical row and no local row', async () => {
      const kalimdor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kalimdor);

      // Positive control: the local row exists before the superseding refresh, so
      // the assertions below cannot pass against a fixture that never seeded.
      const seriesRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 25106)))[0]!;
      const before = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow.id));
      expect(before.filter((r) => r.source === 'local')).toHaveLength(1);

      // Hardcover has since given the stub a release date, so the member arrives.
      mockFetchHardcover(azerothPayload(true));
      const card = await svc.refreshSeriesForBook(kalimdor);

      const after = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow.id));
      expect(after).toHaveLength(5);
      expect(after.filter((r) => r.source === 'local')).toHaveLength(0);
      const forBook = after.filter((r) => r.bookId === kalimdor);
      expect(forBook).toHaveLength(1);
      expect(forBook[0]!).toMatchObject({ source: 'hardcover', hardcoverBookId: 8002 });
      expect(card!.members.map((m) => m.position)).toEqual([1, 2, 3, 4, 5]);
      expect(card!.members.filter((m) => m.libraryBookId === kalimdor)).toHaveLength(1);
    });

    /**
     * AC8 again, but the pairing rides the TITLE arm rather than position — the
     * `derived-equals-full` case where the member's whole title is a suffix
     * variant of the book's. Both sides are unpositioned, so the position pass
     * cannot fire and the outcome depends entirely on the matcher.
     */
    it('AC8: supersession also works when the later member pairs on the title arm at a null position', async () => {
      const kalimdor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: null, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kalimdor);
      const seriesRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 25106)))[0]!;
      expect((await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow.id))).filter((r) => r.source === 'local')).toHaveLength(1);

      globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: {
          series: [{
            id: 25106, name: 'Exploring Azeroth', slug: 'exploring-azeroth', author: { name: 'Christie Golden' },
            book_series: [
              { position: null, book: { id: 8002, slug: 'kalimdor', title: 'Kalimdor', image: null, users_count: 80 } },
            ],
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof globalThis.fetch;
      await svc.refreshSeriesForBook(kalimdor);

      const after = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow.id));
      expect(after).toHaveLength(1);
      expect(after[0]!).toMatchObject({ source: 'hardcover', hardcoverBookId: 8002, bookId: kalimdor });
    });

    /**
     * AC9 — the render path reconciles a book that entered the library AFTER the
     * last rebuild, on the very next GET: no Hardcover fetch, no cache-miss
     * resolve branch, and `series.last_fetched_at` untouched.
     */
    it('AC9: a cache-hit GET seeds a book imported after the rebuild, without fetching or touching last_fetched_at', async () => {
      const kings = await seedBookWithSeries(db, { title: 'Exploring Azeroth: The Eastern Kingdoms', seriesName: 'Exploring Azeroth', seriesPosition: 1, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kings);
      const seriesRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 25106)))[0]!;
      const fetchedAtBefore = seriesRow.lastFetchedAt!.getTime();

      // A new import lands in the already-canonical series. `upsertSeriesLink`'s
      // guard deliberately writes nothing — assert that first, or the GET below
      // could be passing on a row it never created.
      const kalimdor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      await upsertSeriesLink(db, log, kalimdor, { name: 'Exploring Azeroth', position: 2, title: 'Exploring Azeroth: Kalimdor', authorName: 'Christie Golden' });
      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, kalimdor))).toHaveLength(0);

      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;
      const card = await svc.getSeriesForBook(kalimdor);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(card!.members.filter((m) => m.libraryBookId === kalimdor)).toHaveLength(1);
      const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, kalimdor));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe('local');
      const after = (await db.select().from(series).where(eq(series.id, seriesRow.id)))[0]!;
      expect(after.lastFetchedAt!.getTime()).toBe(fetchedAtBefore);
    });

    /**
     * AC10 fast path — a card whose pool is fully claimed opens NO transaction.
     * The reconcile must not tax the ordinary GET, which is the overwhelmingly
     * common shape.
     */
    it('AC10: a fully-claimed pool opens no transaction and issues no write', async () => {
      const kings = await seedBookWithSeries(db, { title: 'Exploring Azeroth: The Eastern Kingdoms', seriesName: 'Exploring Azeroth', seriesPosition: 1, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kings);

      // Positive control: the same spy DOES see a transaction when a book is
      // unclaimed, so a zero count below means "fast path", not "spy never armed".
      const stray = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      const armed = vi.spyOn(db, 'transaction');
      await svc.getSeriesForBook(kings);
      expect(armed).toHaveBeenCalledTimes(1);
      armed.mockRestore();

      // Now every pool book is claimed (the stray got its row above).
      const spy = vi.spyOn(db, 'transaction');
      const card = await svc.getSeriesForBook(kings);
      expect(spy).not.toHaveBeenCalled();
      expect(card!.members.filter((m) => m.libraryBookId === stray)).toHaveLength(1);
      spy.mockRestore();
    });

    /**
     * AC10 / AC8 — the stale-snapshot race, driven DETERMINISTICALLY rather than
     * by timing. The card build computes its unclaimed snapshot, then a full
     * refresh rebuilds the series and pairs that book to a now-available Hardcover
     * member, and only THEN does the reconcile transaction run. Its in-transaction
     * re-read must observe the canonical row and write nothing — an implementation
     * that inserts from the snapshot resurrects a superseded local row, which the
     * disjoint partial indexes happily let coexist with the canonical one.
     */
    it('AC10: a refresh that lands between the snapshot and the reconcile makes the guard write nothing', async () => {
      const kalimdor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kalimdor);
      const seriesRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 25106)))[0]!;
      // Clear the seeded row so the next GET's snapshot sees the book unclaimed —
      // the state a fresh import produces, reached here without a second service.
      await db.delete(seriesMembers).where(eq(seriesMembers.source, 'local'));

      const openTransaction = db.transaction.bind(db);
      const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(async (callback) => {
        // Between the snapshot and the reconcile: Hardcover now exposes the
        // real position-2 member, and the rebuild pairs it with the book.
        mockFetchHardcover(azerothPayload(true));
        await svc.refreshSeriesForBook(kalimdor);
        return openTransaction(callback);
      });

      mockFetchHardcover(azerothPayload(false));
      const card = await svc.getSeriesForBook(kalimdor);
      spy.mockRestore();

      const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow.id));
      const forBook = rows.filter((r) => r.bookId === kalimdor);
      expect(forBook).toHaveLength(1);
      expect(forBook[0]!.source).toBe('hardcover');
      expect(rows.filter((r) => r.source === 'local')).toHaveLength(0);
      // The response is assembled from what the transaction returned, so it shows
      // the book once as an owned Hardcover entry — never a second '+ Add' row.
      const shown = card!.members.filter((m) => m.libraryBookId === kalimdor);
      expect(shown).toHaveLength(1);
      expect(shown[0]!.hardcoverBookId).toBe(8002);
      expect(card!.members.map((m) => m.position)).toEqual([1, 2, 3, 4, 5]);
    });

    /**
     * F1 (PR review) — AC10 requires re-reading the library POOL inside the
     * transaction, independently of the member rows. The refresh race above
     * changes only the rows, so an implementation that re-read rows but reused
     * the snapshot's pool would leave it green.
     *
     * Here the book LEAVES the pool between the two reads — the operator re-files
     * it under another series while the GET is in flight. The in-transaction pool
     * read no longer returns it, so it is not unclaimed and nothing is written.
     * Against a stale snapshot pool it is still unclaimed, and the insert lands a
     * durable local row binding a book to a series it no longer belongs to.
     */
    it('F1: a book that leaves the pool between the snapshot and the reconcile gets no row', async () => {
      const kalimdor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const observed = createMockLogger();
      const svc = new SeriesCardService(db, inject(observed), settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kalimdor);
      const seriesRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 25106)))[0]!;
      // Positive control: the seed DOES fire for this fixture, so a zero-row
      // assertion below means "the guard declined", not "nothing ever seeds".
      expect((await db.select().from(seriesMembers).where(eq(seriesMembers.source, 'local')))).toHaveLength(1);
      await db.delete(seriesMembers).where(eq(seriesMembers.source, 'local'));
      (observed.warn as ReturnType<typeof vi.fn>).mockClear();

      const openTransaction = db.transaction.bind(db);
      const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(async (callback) => {
        await db.update(books).set({ seriesName: 'Chronicles of the Horde' }).where(eq(books.id, kalimdor));
        return openTransaction(callback);
      });

      const card = await svc.getSeriesForBook(kalimdor);
      spy.mockRestore();

      const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow.id));
      expect(rows.filter((r) => r.source === 'local')).toHaveLength(0);
      expect(rows.filter((r) => r.bookId === kalimdor)).toHaveLength(0);
      // The transaction committed cleanly — no best-effort fallback was needed.
      expect(observed.warn).not.toHaveBeenCalled();
      expect(card!.members.map((m) => m.position)).toEqual([1, 3, 4, 5]);
      expect(card!.members.some((m) => m.libraryBookId === kalimdor)).toBe(false);
    });

    /**
     * F1's other branch — the book is DELETED between the two reads. The
     * in-transaction pool read drops it, so the insert never names a row that no
     * longer exists. Against a stale snapshot pool the insert violates the FK
     * ([[libsql-foreign-keys-on-by-default]]), the whole transaction rejects, and
     * the best-effort fallback renders the PRE-WRITE snapshot — a card still
     * advertising a book the operator just deleted. Both the silence of the log
     * and the absence of the entry are therefore load-bearing.
     */
    it('F1: a book deleted between the snapshot and the reconcile is dropped, not FK-rejected', async () => {
      const anchor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: The Eastern Kingdoms', seriesName: 'Exploring Azeroth', seriesPosition: 1, authorName: 'Christie Golden' });
      const doomed = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const observed = createMockLogger();
      const svc = new SeriesCardService(db, inject(observed), settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(anchor);
      expect((await db.select().from(seriesMembers).where(eq(seriesMembers.source, 'local')))).toHaveLength(1);
      await db.delete(seriesMembers).where(eq(seriesMembers.source, 'local'));
      (observed.warn as ReturnType<typeof vi.fn>).mockClear();

      const openTransaction = db.transaction.bind(db);
      const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(async (callback) => {
        await db.delete(books).where(eq(books.id, doomed));
        return openTransaction(callback);
      });

      const card = await svc.getSeriesForBook(anchor);
      spy.mockRestore();

      expect(observed.warn).not.toHaveBeenCalled();
      const rows = await db.select().from(seriesMembers);
      expect(rows.filter((r) => r.source === 'local')).toHaveLength(0);
      expect(card!.members.map((m) => m.position)).toEqual([1, 3, 4, 5]);
      expect(card!.members.some((m) => m.title === 'Exploring Azeroth: Kalimdor')).toBe(false);
    });

    it('AC10: the reverse order — reconcile first, refresh after — converges on the same single canonical row', async () => {
      const kalimdor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kalimdor);
      const seriesRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 25106)))[0]!;
      expect((await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow.id))).filter((r) => r.source === 'local')).toHaveLength(1);

      mockFetchHardcover(azerothPayload(true));
      await svc.refreshSeriesForBook(kalimdor);

      const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow.id));
      expect(rows.filter((r) => r.bookId === kalimdor)).toHaveLength(1);
      expect(rows.filter((r) => r.source === 'local')).toHaveLength(0);
    });

    /**
     * AC10 best-effort: the reconcile is a nicety, never a reason for the card to
     * fail. On any rejection the GET still resolves, the card still shows the
     * entry from the pre-write snapshot, and the failure is logged.
     */
    it('AC10: a failing reconcile is caught, logged once, and still returns the snapshot card', async () => {
      const kalimdor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const observed = createMockLogger();
      const svc = new SeriesCardService(db, inject(observed), settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kalimdor);
      await db.delete(seriesMembers).where(eq(seriesMembers.source, 'local'));
      (observed.warn as ReturnType<typeof vi.fn>).mockClear();

      const spy = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('reconcile boom'));
      const card = await svc.getSeriesForBook(kalimdor);
      spy.mockRestore();

      // Resolved, not rejected, and the owned book is still on the card.
      expect(card!.members.map((m) => m.position)).toEqual([1, 2, 3, 4, 5]);
      expect(card!.members[1]!.libraryBookId).toBe(kalimdor);
      // Nothing landed — the fallback renders the snapshot, it does not fake a write.
      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.source, 'local'))).toHaveLength(0);
      const warnCalls = (observed.warn as ReturnType<typeof vi.fn>).mock.calls;
      expect(warnCalls).toHaveLength(1);
      const meta = warnCalls[0]![0] as { error: { type?: unknown; message?: unknown } };
      expect(meta.error).not.toBeInstanceOf(Error);
      expect(meta.error.message).toBe('reconcile boom');
    });

    /**
     * AC5 — the seeded entry's position is `books.series_position` VERBATIM: `0`
     * sorts before `1` instead of coercing to null, and `null` sorts last.
     */
    it('AC5: unclaimed books at position 0 and null interleave as [0, 1, 2.5, null]', async () => {
      const zero = await seedBookWithSeries(db, { title: 'Origins', seriesName: 'Test Series', seriesPosition: 0, authorName: 'Some Author' });
      const nullPos = await seedBookWithSeries(db, { title: 'Zed Companion', seriesName: 'Test Series', seriesPosition: null, authorName: 'Some Author' });
      mockFetchHardcover({
        data: {
          series: [{
            id: 7777, name: 'Test Series', slug: 'test-series', author: { name: 'Some Author' },
            book_series: [
              { position: 1, book: { id: 6001, slug: 'one', title: 'Book One', image: null, users_count: 50 } },
              { position: 2.5, book: { id: 6002, slug: 'two-five', title: 'Book Two-Five', image: null, users_count: 40 } },
            ],
          }],
        },
      });

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(zero);

      expect(card!.members.map((m) => m.position)).toEqual([0, 1, 2.5, null]);
      expect(card!.members[0]!.libraryBookId).toBe(zero);
      expect(card!.members.at(-1)!.libraryBookId).toBe(nullPos);
      const rows = await db.select().from(seriesMembers);
      expect(rows.find((r) => r.bookId === zero)!.position).toBe(0);
      expect(rows.find((r) => r.bookId === nullPos)!.position).toBeNull();
    });

    /**
     * AC11 — a local row renders from the BOOK's CURRENT title, not the text
     * frozen into the row when it was seeded.
     */
    it('AC11: a local row whose stored title has drifted renders the book’s current title once', async () => {
      const kalimdor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kalimdor);

      await db.update(books).set({ title: 'Kalimdor (Renamed Edition)' }).where(eq(books.id, kalimdor));
      const card = await svc.getSeriesForBook(kalimdor);

      const owned = card!.members.filter((m) => m.libraryBookId === kalimdor);
      expect(owned).toHaveLength(1);
      expect(owned[0]!.title).toBe('Kalimdor (Renamed Edition)');
      expect(card!.members.some((m) => m.title === 'Exploring Azeroth: Kalimdor')).toBe(false);
      expect(card!.members.filter((m) => !m.inLibrary).map((m) => m.title)).not.toContain('Kalimdor (Renamed Edition)');
    });

    /**
     * F4 (spec review) — AC11's OTHER half: a local row owns its `book_id`, so it
     * cannot claim a different candidate even when its stored title and position
     * are a perfect match for one. Sharp observation point: the Hardcover member
     * pairs with book B by title, so an implementation that resolved local rows by
     * title would have the local row steal B, leave the member unmatched, and seed
     * a second local row for A.
     */
    it('F4: a local row claims its own book_id even when its stored title matches a sibling', async () => {
      const bookA = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
      const bookB = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      const [seedRow] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 5523, name: 'The Band', normalizedName: 'the band', authorName: 'Nicholas Eames', lastFetchedAt: new Date(),
      }).returning();
      await db.insert(seriesMembers).values([
        { seriesId: seedRow!.id, hardcoverBookId: 1002, slug: 'bloody', title: 'Bloody Rose', normalizedTitle: 'bloody rose', authorName: 'Nicholas Eames', position: 2, source: 'hardcover' },
        // Drifted local row: points at A, but its stored title/position describe B.
        { seriesId: seedRow!.id, bookId: bookA, title: 'Bloody Rose', normalizedTitle: 'bloody rose', authorName: 'Nicholas Eames', position: 2, source: 'local' },
      ]);

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      // Both books are claimed — by the local row and by the member — so the
      // build must take the fast path. Deleting the by-`book_id` claim entirely
      // (rather than swapping it for a title match) leaves A unclaimed, and this
      // is the assertion that sees it: the reconcile opens, its insert collides
      // with the existing row, and the failure is swallowed as best-effort.
      const txSpy = vi.spyOn(db, 'transaction');
      const card = await svc.getSeriesForBook(bookA);
      expect(txSpy).not.toHaveBeenCalled();
      txSpy.mockRestore();

      expect(card!.members).toHaveLength(2);
      const forA = card!.members.filter((m) => m.libraryBookId === bookA);
      const forB = card!.members.filter((m) => m.libraryBookId === bookB);
      expect(forA).toHaveLength(1);
      expect(forB).toHaveLength(1);
      // A renders from its own book, B stays with the Hardcover member that paired.
      expect(forA[0]!).toMatchObject({ title: 'Kings of the Wyld', position: 1, hardcoverBookId: null, inLibrary: true });
      expect(forB[0]!).toMatchObject({ title: 'Bloody Rose', hardcoverBookId: 1002, inLibrary: true });
      // Nothing was unclaimed, so no row was written and the drifted row survives.
      const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seedRow!.id));
      expect(rows.filter((r) => r.source === 'local').map((r) => r.bookId)).toEqual([bookA]);
    });

    /**
     * AC12 — residue is not a member. A local row that lost its book to the FK's
     * `ON DELETE SET NULL` renders nothing at all: not an owned row, and above all
     * not a '+ Add' row inviting the operator to re-acquire a book they deleted.
     */
    it('AC12: a local row whose book was deleted renders no entry and no + Add phantom', async () => {
      const anchor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: The Eastern Kingdoms', seriesName: 'Exploring Azeroth', seriesPosition: 1, authorName: 'Christie Golden' });
      const doomed = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(anchor);

      await db.delete(books).where(eq(books.id, doomed));
      const residue = (await db.select().from(seriesMembers)).filter((r) => r.source === 'local');
      expect(residue).toHaveLength(1);
      expect(residue[0]!.bookId).toBeNull();

      const card = await svc.getSeriesForBook(anchor);
      expect(card!.members.map((m) => m.position)).toEqual([1, 3, 4, 5]);
      expect(card!.members.some((m) => m.title === 'Exploring Azeroth: Kalimdor')).toBe(false);
    });

    /**
     * F5 (spec review) — AC12's other branch: the book still EXISTS and the row
     * still names it, but its `books.series_name` has moved outside this card's
     * pool. It is no longer a member here and must not render, in either shape.
     */
    it('F5: a local row naming a book that left the series renders no entry and no + Add phantom', async () => {
      const anchor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: The Eastern Kingdoms', seriesName: 'Exploring Azeroth', seriesPosition: 1, authorName: 'Christie Golden' });
      const mover = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(anchor);

      await db.update(books).set({ seriesName: 'Chronicles of the Horde' }).where(eq(books.id, mover));
      const stranded = (await db.select().from(seriesMembers)).filter((r) => r.source === 'local');
      expect(stranded).toHaveLength(1);
      expect(stranded[0]!.bookId).toBe(mover);

      const card = await svc.getSeriesForBook(anchor);
      expect(card!.members.map((m) => m.position)).toEqual([1, 3, 4, 5]);
      expect(card!.members.some((m) => m.libraryBookId === mover)).toBe(false);
      expect(card!.members.some((m) => m.title === 'Exploring Azeroth: Kalimdor')).toBe(false);
    });

    /**
     * AC13 — two owned books at one position, one Hardcover member there. The
     * member takes the lower-`books.id` candidate (#2108's pinned claim order) and
     * the other book gets its own entry at the same position; the two order by
     * title. The service performs no position-based dedup of its own.
     */
    it('AC13: two owned books at one position — the member claims the lower id, the other renders alongside', async () => {
      const lower = await seedBookWithSeries(db, { title: 'Zeta Chronicle', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      const higher = await seedBookWithSeries(db, { title: 'Alpha Chronicle', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      expect(higher).toBeGreaterThan(lower);
      mockFetchHardcover({
        data: {
          series: [{
            id: 5523, name: 'The Band', slug: 'the-band', author: { name: 'Nicholas Eames' },
            book_series: [{ position: 2, book: { id: 1002, slug: 'bloody', title: 'Bloody Rose', image: null, users_count: 80 } }],
          }],
        },
      });

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(lower);

      expect(card!.members.map((m) => m.title)).toEqual(['Alpha Chronicle', 'Bloody Rose']);
      expect(card!.members.every((m) => m.position === 2)).toBe(true);
      expect(card!.members.every((m) => m.inLibrary)).toBe(true);
      const claimed = card!.members.map((m) => m.libraryBookId);
      expect(claimed).toEqual([higher, lower]);
      expect(new Set(claimed).size).toBe(2);
    });

    /**
     * AC14 — multiplicity. Two unclaimed books with IDENTICAL titles are two
     * different books; the local unique index is keyed on `(series_id, book_id)`,
     * not on the title, so both rows land.
     */
    it('AC14: two unclaimed books with identical titles get one entry and one row each', async () => {
      const first = await seedBookWithSeries(db, { title: 'Twice Told', seriesName: 'The Band', seriesPosition: 4, authorName: 'Nicholas Eames' });
      const second = await seedBookWithSeries(db, { title: 'Twice Told', seriesName: 'The Band', seriesPosition: 5, authorName: 'Nicholas Eames' });
      mockFetchHardcover({
        data: {
          series: [{
            id: 5523, name: 'The Band', slug: 'the-band', author: { name: 'Nicholas Eames' },
            book_series: [{ position: 1, book: { id: 1001, slug: 'kings', title: 'Kings of the Wyld', image: null, users_count: 90 } }],
          }],
        },
      });

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(first);

      expect(card!.members.map((m) => m.title)).toEqual(['Kings of the Wyld', 'Twice Told', 'Twice Told']);
      expect(card!.members.filter((m) => m.title === 'Twice Told').map((m) => m.libraryBookId)).toEqual([first, second]);
      const local = (await db.select().from(seriesMembers)).filter((r) => r.source === 'local');
      expect(local.map((r) => r.bookId).sort((a, b) => a! - b!)).toEqual([first, second]);
    });

    /**
     * AC7 — the seed pool is the PRIMARY name only. On the bind path a sibling
     * still carrying the pre-bind (Audnexus) name that matched no member is not a
     * member of the canonical series, so it gets no row. Widening the seed to
     * `extraSeriesNames` would durably enrol it in a series the operator never
     * asserted it belongs to.
     */
    it('AC7: a bind seeds no row for a pre-bind-named sibling that matched no member', async () => {
      const initiating = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'The Earthsea Cycle', seriesPosition: 1, authorName: 'Ursula K. Le Guin' });
      const sibling = await seedBookWithSeries(db, { title: 'An Unrelated Sibling', seriesName: 'The Earthsea Cycle', seriesPosition: 9, authorName: 'Ursula K. Le Guin' });
      mockFetchHardcover({
        data: {
          series: [{
            id: 4242, name: 'The Earthsea Quartet', slug: 'earthsea-quartet', author: { name: 'Ursula K. Le Guin' },
            book_series: [{ position: 1, book: { id: 5001, slug: 'wizard', title: 'A Wizard of Earthsea', image: null, users_count: 90 } }],
          }],
        },
      });

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const bound = await svc.bindHardcoverSeries(initiating, 4242);

      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, sibling))).toHaveLength(0);
      expect((await db.select().from(books).where(eq(books.id, sibling)))[0]!.seriesName).toBe('The Earthsea Cycle');
      expect(bound!.card.members.map((m) => m.title)).toEqual(['A Wizard of Earthsea']);
    });
  });

  // #2098 — the route's post-bind sidecar pass iterates `syncedIds`, so the list must agree with
  // the COMMITTED artifact (the `books` rows whose series_name actually moved), not with a mock.
  describe('#2098 — the committed synced set', () => {
    it('a real bind over a seeded 3-book series reports all three ids', async () => {
      const ids = [
        await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'The Earthsea Cycle', seriesPosition: 1, authorName: 'Ursula K. Le Guin' }),
        await seedBookWithSeries(db, { title: 'The Tombs of Atuan', seriesName: 'The Earthsea Cycle', seriesPosition: 2, authorName: 'Ursula K. Le Guin' }),
        await seedBookWithSeries(db, { title: 'The Farthest Shore', seriesName: 'The Earthsea Cycle', seriesPosition: 3, authorName: 'Ursula K. Le Guin' }),
      ];
      // A fourth book in an unrelated series — it must NOT be reported.
      const unrelated = await seedBookWithSeries(db, { title: 'The Dispossessed', seriesName: 'Hainish Cycle', seriesPosition: 5, authorName: 'Ursula K. Le Guin' });

      globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: {
          series: [{
            id: 7801, name: 'The Earthsea Quartet', slug: 'earthsea-quartet', author: { name: 'Ursula K. Le Guin' },
            book_series: [
              { position: 1, book: { id: 5001, slug: 'wizard', title: 'A Wizard of Earthsea', image: null, users_count: 90 } },
              { position: 2, book: { id: 5002, slug: 'tombs', title: 'The Tombs of Atuan', image: null, users_count: 80 } },
              { position: 3, book: { id: 5003, slug: 'shore', title: 'The Farthest Shore', image: null, users_count: 70 } },
            ],
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const bound = await svc.bindHardcoverSeries(ids[0]!, 7801);

      expect(bound!.syncedIds).toEqual(ids);
      // Observed against the committed rows, not against the member set the bind built.
      const rewritten = (await db.select().from(books))
        .filter((b) => b.seriesName === 'The Earthsea Quartet').map((b) => b.id).sort((a, b) => a - b);
      expect([...bound!.syncedIds].sort((a, b) => a - b)).toEqual(rewritten);
      expect(bound!.syncedIds).not.toContain(unrelated);
    });
  });
});
