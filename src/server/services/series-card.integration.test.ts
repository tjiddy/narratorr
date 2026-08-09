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

/** Unordered loader projection; proves forced planner order differs before testing production ORDER BY (#2175 AC7a). */
async function poolProbeIds(db: Db): Promise<number[]> {
  const rows = await db.all(sql`SELECT id, title, series_position, user_cleared_fields, series_name FROM books WHERE series_name IS NOT NULL`);
  return (rows as { id: number }[]).map((row) => row.id);
}

/**
 * Test-only covering index forces the IS NOT NULL scan into series_name order.
 * A narrow index leaves SCAN books/id order; covering projected columns yields
 * SEARCH ... COVERING INDEX (#2175 AC12).
 */
async function forcePoolReorderingIndex(db: Db): Promise<void> {
  await db.run(sql`CREATE INDEX idx_books_pool_covering_2175 ON books (series_name, title, series_position, user_cleared_fields)`);
}

/** Captures SQL and args: AC14 requires one pool statement with zero pool-derived parameters; count alone misses a dynamic IN query returning identical rows. */
function spyStatements(db: Db): { executed: { sql: string; args: unknown }[]; restore: () => void } {
  const client = db.$client as unknown as { execute: (...a: unknown[]) => unknown };
  const original = client.execute.bind(client);
  const executed: { sql: string; args: unknown }[] = [];
  client.execute = ((stmt: unknown, ...rest: unknown[]) => {
    const text = typeof stmt === 'string' ? stmt : (stmt as { sql?: string })?.sql ?? '';
    executed.push({ sql: text, args: typeof stmt === 'string' ? [] : (stmt as { args?: unknown })?.args ?? [] });
    return original(stmt as never, ...(rest as never[]));
  }) as typeof client.execute;
  return { executed, restore: () => { client.execute = original as typeof client.execute; } };
}

function poolStatements(executed: { sql: string; args: unknown }[]): { sql: string; args: unknown }[] {
  return executed.filter((s) => /from "books"/i.test(s.sql) && /"series_position"/.test(s.sql) && /"user_cleared_fields"/.test(s.sql));
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
      // libsql may keep the file handle on Windows.
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
      const bloody = card!.members.find((m) => m.title === 'Bloody Rose')!;
      expect(bloody.inLibrary).toBe(true);
      expect(bloody.libraryBookId).toBe(bookId);

      // Image URL remains a persistence/DTO contract even though the UI no longer renders thumbnails (#1139 AC5.3).
      const kings = card!.members.find((m) => m.title === 'Kings of the Wyld')!;
      expect(kings.imageUrl).toBe('https://example.test/kw.jpg');
      expect(bloody.imageUrl).toBeNull();

      const persisted = await db.select().from(series).where(eq(series.hardcoverSeriesId, 5523));
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.authorName).toBe('Nicholas Eames');
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
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.query).toContain('GetSeriesMembersById');
      expect(body.variables.id).toBe(5523);

      const final = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, row!.id));
      const hardcover = final.filter((m) => m.source === 'hardcover');
      expect(hardcover).toHaveLength(1);
      expect(hardcover[0]!.title).toBe('Kings of the Wyld');
      // The unmatched owned book remains on the card as a local row (#2144).
      const local = final.filter((m) => m.source === 'local');
      expect(local).toHaveLength(1);
      expect(local[0]!.bookId).toBe(bookId);
      expect(card!.members.map((m) => m.title)).toEqual(['Kings of the Wyld', 'Bloody Rose']);
    });
  });

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
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.query).toContain('GetSeriesMembersById');
      expect(body.variables.id).toBe(5523);
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
      // Distinct names/authors expose which linked book the resolver chose; lower books.id must win.
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
      // Reverse member insertion order so books.id—not row insertion—decides.
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
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.variables.name).toBe('Lower Series Name');
      expect(body.variables.author).toBe('Lower Author');
    });

    it('no-qualifying-book branch: logs at info and skips, does not modify the row', async () => {
      const row = await seedStaleSeriesRow({ name: 'Ghost Series', normalizedName: 'ghost series', hardcoverSeriesId: null, authorName: null });
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
      const after = (await db.select().from(series).where(eq(series.id, row.id)))[0]!;
      expect(after.lastFetchedAt?.getTime()).toBe(row.lastFetchedAt?.getTime());
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

      expect(result.refreshed + result.skipped).toBe(2);
      expect(result.refreshed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const healthyAfter = (await db.select().from(series).where(eq(series.id, ok.id)))[0]!;
      expect(healthyAfter.authorName).toBe('Healthy Author');
      const failingAfter = (await db.select().from(series).where(eq(series.id, failing.id)))[0]!;
      expect(failingAfter.authorName).toBe('A');
    });

    it('stale-row selection: only rows with last_fetched_at older than STALE_AFTER_DAYS are picked', async () => {
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

  describe('#1139 polish — dedup, NULL ordering, post-create dedup', () => {
    it('AC1.4: upsertSeriesLink after Hardcover cache exists does not add a duplicate row', async () => {
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

      const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seedRow!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe('hardcover');

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);
      expect(card!.hardcoverSeriesId).toBe(5523);
      const matches = card!.members.filter((m) => m.title === 'Bloody Rose');
      expect(matches).toHaveLength(1);
      expect(matches[0]!.inLibrary).toBe(true);
      expect(matches[0]!.libraryBookId).toBe(bookId);
    });

    /**
     * Use two unpositioned title matches: finite-position duplicates collapse upstream,
     * while null-position works both reach persistMembers and exercise its shared claim set.
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

      const persisted = await db.select().from(series).where(eq(series.hardcoverSeriesId, 5523));
      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, persisted[0]!.id));
      const populatedBookIds = memberRows.map((m) => m.bookId).filter((v): v is number => v !== null);
      expect(populatedBookIds).toHaveLength(1);
      expect(populatedBookIds[0]).toBe(bookId);
    });

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
     * Live WoW position 15 has Russian (62 readers) and English (7) works. The old
     * picker selected Russian; assert the English work through persistence, link, and render (#2097).
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

    /** DISTINCT ON collapsed null positions; schema permits multiples because unique indexes key Hardcover ID/local book ID (#2097). */
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

    it('AC3.1: cache mode renders [1, 2.5, 4, null] order regardless of insertion order', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Anchor Book', seriesName: 'Test Series', seriesPosition: 1, authorName: 'Some Author' });
      const [seedRow] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 9999, name: 'Test Series', normalizedName: 'test series', authorName: 'Some Author', lastFetchedAt: new Date(),
      }).returning();
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

    it('AC3.2: library-only mode places NULL position last with the same comparator', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Anchor', seriesName: 'Test Series', seriesPosition: 1, authorName: 'Some Author' });
      await seedBookWithSeries(db, { title: 'Companion', seriesName: 'Test Series', seriesPosition: null, authorName: 'Some Author' });
      await seedBookWithSeries(db, { title: 'Book Four', seriesName: 'Test Series', seriesPosition: 4, authorName: 'Some Author' });
      await seedBookWithSeries(db, { title: 'Book Two-Five', seriesName: 'Test Series', seriesPosition: 2.5, authorName: 'Some Author' });

      const svc = new SeriesCardService(db, log, settingsServiceWith(''));
      const card = await svc.getSeriesForBook(bookId);

      expect(card!.members.map((m) => m.position)).toEqual([1, 2.5, 4, null]);
      expect(card!.members.map((m) => m.title)).toEqual(['Anchor', 'Book Two-Five', 'Book Four', 'Companion']);
    });
  });

  // Live case: "Chapterhouse: Dune" at position 6 failed title matching against "Chapterhouse Dune" with stale position 17, exposing +Add for an owned book (#2096).
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
      // This write-only column changes from "chapterhouse" to full separator form; no backfill needed.
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
      // Empty title variants and null position provide no matching arm.
      expect(card!.members.find((m) => m.title === '[ ]')!.inLibrary).toBe(false);
    });
  });

  describe('#2108 — pinned candidate claim order', () => {
    /**
     * Matching is first-claim-wins within one quality tier, so SQL pool order decides.
     * A test-only covering index forces the unordered projection into series_name order,
     * and the precondition proves it. Both candidates share one match tier so ranking
     * cannot mask a missing ORDER BY. Removing orderBy flips the winner; a narrow index
     * leaves SCAN books/id order and fails the precondition (#2175).
     */
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

      await forcePoolReorderingIndex(db);
      // Prove unordered projection is descending by ID before testing production ordering.
      expect(await poolProbeIds(db)).toEqual([higherId, lowerId]);

      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        data: {
          series: [{
            id: 7703,
            name: 'Zeta Series',
            slug: 'zeta-series',
            author: { name: 'Frank Herbert' },
            book_series: [
              // Null position disables position matching, leaving the title tier to decide.
              { position: null, book: { id: 4001, slug: 'chapterhouse-dune', title: 'Chapterhouse: Dune', image: null, users_count: 50 } },
            ],
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      // Bind from higher ID; resolved and prior series names make the pool span both books.
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const bound = await svc.bindHardcoverSeries(higherId, 7703);

      expect(bound).not.toBeNull();
      const memberRows = await db.select().from(seriesMembers);
      // Higher-ID initiator remains unclaimed and is preserved as a local #2144 row.
      const hardcover = memberRows.filter((m) => m.source === 'hardcover');
      expect(hardcover).toHaveLength(1);
      expect(hardcover[0]!.bookId).toBe(lowerId);
      expect(memberRows.filter((m) => m.source === 'local').map((m) => m.bookId)).toEqual([higherId]);
      expect(bound!.card.members[0]!.hardcoverBookId).toBe(4001);
      expect(bound!.card.members[0]!.libraryBookId).toBe(lowerId);
    });
  });

  // Owned series books must render when Hardcover omits dateless works; otherwise no member pairs and the canonical-series guard suppresses the local link (#2144).
  describe('#2144 — owned books Hardcover does not expose', () => {
    function mockFetchHardcover(payload: unknown): ReturnType<typeof vi.fn> {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;
      return fetchMock;
    }

    /** Hardcover exposes 1/3/4/5; position 2 is a dateless stub until requested. */
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
     * Pin complete local-row shape: provider fields null, book title/primary author,
     * and verbatim position 0. Same-position authors tie-break by lower author_id.
     */
    it('F3: the seeded row carries the exact AC6 shape, including position 0 and the tie-broken primary author', async () => {
      // Same author position forces lower author_id tie-break; lower ID is not alphabetical first.
      const prequel = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Prequel', seriesName: 'Exploring Azeroth', seriesPosition: 0, authorName: 'Zara Primary' });
      const [second] = await db.insert(authors).values({ publicId: generatePublicId('au'), name: 'Aaron Secondary', slug: 'aaron-secondary' }).returning();
      await db.insert(bookAuthors).values({ bookId: prequel, authorId: second!.id, position: 0 });
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

    /** Supersession uses delete-and-rebuild through position matching; no upgrade path is intended. */
    it('AC8: a later refresh carrying the real member leaves one canonical row and no local row', async () => {
      const kalimdor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kalimdor);

      // Prove the local row exists before supersession.
      const seriesRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 25106)))[0]!;
      const before = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seriesRow.id));
      expect(before.filter((r) => r.source === 'local')).toHaveLength(1);

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

    /** Both sides are unpositioned, so derived-equals-full title matching alone drives supersession. */
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

    it('AC9: a cache-hit GET seeds a book imported after the rebuild, without fetching or touching last_fetched_at', async () => {
      const kings = await seedBookWithSeries(db, { title: 'Exploring Azeroth: The Eastern Kingdoms', seriesName: 'Exploring Azeroth', seriesPosition: 1, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kings);
      const seriesRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 25106)))[0]!;
      const fetchedAtBefore = seriesRow.lastFetchedAt!.getTime();

      // Prove the import/upsert guard wrote nothing before GET reconciliation.
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

    /** Fully claimed cards must avoid reconciliation transaction overhead. */
    it('AC10: a fully-claimed pool opens no transaction and issues no write', async () => {
      const kings = await seedBookWithSeries(db, { title: 'Exploring Azeroth: The Eastern Kingdoms', seriesName: 'Exploring Azeroth', seriesPosition: 1, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kings);

      // Prove this spy observes a transaction when a book is unclaimed.
      const stray = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      const armed = vi.spyOn(db, 'transaction');
      await svc.getSeriesForBook(kings);
      expect(armed).toHaveBeenCalledTimes(1);
      armed.mockRestore();

      const spy = vi.spyOn(db, 'transaction');
      const card = await svc.getSeriesForBook(kings);
      expect(spy).not.toHaveBeenCalled();
      expect(card!.members.filter((m) => m.libraryBookId === stray)).toHaveLength(1);
      spy.mockRestore();
    });

    /**
     * Deterministically refresh between snapshot and transaction. The in-transaction
     * reread must see the canonical row; stale snapshot use would create a duplicate
     * local row because the partial indexes allow both.
     */
    it('AC10: a refresh that lands between the snapshot and the reconcile makes the guard write nothing', async () => {
      const kalimdor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kalimdor);
      const seriesRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 25106)))[0]!;
      // Clear the seed so the next snapshot sees a fresh-import-style unclaimed book.
      await db.delete(seriesMembers).where(eq(seriesMembers.source, 'local'));

      const openTransaction = db.transaction.bind(db);
      const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(async (callback) => {
        // Expose and pair the real member between snapshot and reconciliation.
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
      const shown = card!.members.filter((m) => m.libraryBookId === kalimdor);
      expect(shown).toHaveLength(1);
      expect(shown[0]!.hardcoverBookId).toBe(8002);
      expect(card!.members.map((m) => m.position)).toEqual([1, 2, 3, 4, 5]);
    });

    /**
     * Separately pins the in-transaction pool reread: the book leaves the pool
     * between snapshot and transaction. Reusing stale pool writes a local row for
     * the wrong series.
     */
    it('F1: a book that leaves the pool between the snapshot and the reconcile gets no row', async () => {
      const kalimdor = await seedBookWithSeries(db, { title: 'Exploring Azeroth: Kalimdor', seriesName: 'Exploring Azeroth', seriesPosition: 2, authorName: 'Christie Golden' });
      mockFetchHardcover(azerothPayload(false));
      const observed = createMockLogger();
      const svc = new SeriesCardService(db, inject(observed), settingsServiceWith('TEST_KEY'));
      await svc.getSeriesForBook(kalimdor);
      const seriesRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 25106)))[0]!;
      // Prove the fixture seeds before testing that the guard declines.
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
      expect(observed.warn).not.toHaveBeenCalled();
      expect(card!.members.map((m) => m.position)).toEqual([1, 3, 4, 5]);
      expect(card!.members.some((m) => m.libraryBookId === kalimdor)).toBe(false);
    });

    /**
     * Deletion between reads must disappear from the transaction pool. Reusing the
     * stale pool triggers an FK rejection and returns a stale snapshot card; silence
     * and absence both pin the reread.
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

    /** Reconciliation is best-effort: rejection logs once and returns the pre-write snapshot card. */
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

      expect(card!.members.map((m) => m.position)).toEqual([1, 2, 3, 4, 5]);
      expect(card!.members[1]!.libraryBookId).toBe(kalimdor);
      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.source, 'local'))).toHaveLength(0);
      const warnCalls = (observed.warn as ReturnType<typeof vi.fn>).mock.calls;
      expect(warnCalls).toHaveLength(1);
      const meta = warnCalls[0]![0] as { error: { type?: unknown; message?: unknown } };
      expect(meta.error).not.toBeInstanceOf(Error);
      expect(meta.error.message).toBe('reconcile boom');
    });

    /** Persist position 0 verbatim; null sorts last. */
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
     * Local rows own book_id, never title-match another candidate. Here a drifted
     * local row resembles book B; title resolution would steal B and seed duplicate A.
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
      // Both books must already be claimed; losing A's book_id claim opens a transaction and colliding best-effort insert.
      const txSpy = vi.spyOn(db, 'transaction');
      const card = await svc.getSeriesForBook(bookA);
      expect(txSpy).not.toHaveBeenCalled();
      txSpy.mockRestore();

      expect(card!.members).toHaveLength(2);
      const forA = card!.members.filter((m) => m.libraryBookId === bookA);
      const forB = card!.members.filter((m) => m.libraryBookId === bookB);
      expect(forA).toHaveLength(1);
      expect(forB).toHaveLength(1);
      expect(forA[0]!).toMatchObject({ title: 'Kings of the Wyld', position: 1, hardcoverBookId: null, inLibrary: true });
      expect(forB[0]!).toMatchObject({ title: 'Bloody Rose', hardcoverBookId: 1002, inLibrary: true });
      const rows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, seedRow!.id));
      expect(rows.filter((r) => r.source === 'local').map((r) => r.bookId)).toEqual([bookA]);
    });

    /** ON DELETE SET NULL residue renders neither owned entry nor +Add phantom. */
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

    /** A local row stops rendering when its surviving book moves outside this card's pool. */
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

    /** Position collisions do not dedup: member claims lower books.id; the other book renders beside it, title-sorted. */
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

    /** Multiplicity keys local rows by series/book ID, not title; identical titles both persist. */
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

    /** Seed only canonical primary-name pool; extra pre-bind names would durably enroll unmatched siblings. */
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

  // syncedIds must reflect committed books whose series_name moved, not the planned member set (#2098).
  describe('#2098 — the committed synced set', () => {
    it('a real bind over a seeded 3-book series reports all three ids', async () => {
      const ids = [
        await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'The Earthsea Cycle', seriesPosition: 1, authorName: 'Ursula K. Le Guin' }),
        await seedBookWithSeries(db, { title: 'The Tombs of Atuan', seriesName: 'The Earthsea Cycle', seriesPosition: 2, authorName: 'Ursula K. Le Guin' }),
        await seedBookWithSeries(db, { title: 'The Farthest Shore', seriesName: 'The Earthsea Cycle', seriesPosition: 3, authorName: 'Ursula K. Le Guin' }),
      ];
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
      const rewritten = (await db.select().from(books))
        .filter((b) => b.seriesName === 'The Earthsea Quartet').map((b) => b.id).sort((a, b) => a - b);
      expect([...bound!.syncedIds].sort((a, b) => a - b)).toEqual(rewritten);
      expect(bound!.syncedIds).not.toContain(unrelated);
    });
  });

  /** Series resolves by normalized name, so its library pool must too; exact spelling omitted owned siblings from sibling cards, refresh, and cron (#2175). */
  describe('#2175 — the library pool is keyed on the normalized series name', () => {
    function mockHardcover(payload: unknown): ReturnType<typeof vi.fn> {
      const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ));
      globalThis.fetch = fetchMock as typeof globalThis.fetch;
      return fetchMock;
    }

    function bandPayload(): unknown {
      return {
        data: {
          series: [{
            id: 5523, name: 'The Band', slug: 'the-band', author: { name: 'Nicholas Eames' },
            book_series: [
              { position: 1, book: { id: 7711, slug: 'kings', title: 'Kings of the Wyld', image: null, users_count: 100 } },
              { position: 2, book: { id: 7712, slug: 'bloody', title: 'Bloody Rose', image: null, users_count: 90 } },
            ],
          }],
        },
      };
    }

    function libraryOnly(): SeriesCardService {
      return new SeriesCardService(db, log, settingsServiceWith(''));
    }

    describe('the equivalence class', () => {
      it.each([
        ['case drift (the headline case)', 'The Band', 'the band'],
        ['whitespace drift', 'The Band', '  The   Band '],
        ['punctuation drift', 'Wax & Wayne', 'Wax Wayne'],
      ])('%s: BOTH books appear on BOTH cards', async (_label, nameA, nameB) => {
        const first = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: nameA, seriesPosition: 1, authorName: 'Nicholas Eames' });
        const second = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: nameB, seriesPosition: 2, authorName: 'Nicholas Eames' });

        for (const bookId of [first, second]) {
          const card = await libraryOnly().getSeriesForBook(bookId);
          expect(card!.members.map((m) => m.libraryBookId)).toEqual([first, second]);
          expect(card!.members.every((m) => m.inLibrary)).toBe(true);
        }
      });

      it.each([
        ['a trailing plural is a different series', 'The Band', 'The Bands'],
        ['a digit-separating space is significant', 'Series 2', 'Series2'],
      ])('control — %s', async (_label, nameA, nameB) => {
        const first = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: nameA, seriesPosition: 1, authorName: 'Nicholas Eames' });
        const second = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: nameB, seriesPosition: 2, authorName: 'Nicholas Eames' });

        expect((await libraryOnly().getSeriesForBook(first))!.members.map((m) => m.libraryBookId)).toEqual([first]);
        expect((await libraryOnly().getSeriesForBook(second))!.members.map((m) => m.libraryBookId)).toEqual([second]);
      });

      it('a drifted sibling pairs with its canonical Hardcover member on EITHER card', async () => {
        const kings = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        const bloody = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'the band', seriesPosition: 2, authorName: 'Nicholas Eames' });
        mockHardcover(bandPayload());
        const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));

        for (const bookId of [kings, bloody]) {
          const card = await svc.getSeriesForBook(bookId);
          expect(card!.hardcoverSeriesId).toBe(5523);
          expect(card!.members.map((m) => [m.hardcoverBookId, m.inLibrary, m.libraryBookId]))
            .toEqual([[7711, true, kings], [7712, true, bloody]]);
          expect(card!.members.some((m) => !m.inLibrary)).toBe(false);
        }
      });
    });

    describe('AC5 — an empty-normalized name falls back to exact matching', () => {
      it('three non-Latin/punctuation series do NOT pool together', async () => {
        const dozory = await seedBookWithSeries(db, { title: 'Ночной Дозор', seriesName: 'Дозоры', seriesPosition: 1, authorName: 'Sergei Lukyanenko' });
        const santi = await seedBookWithSeries(db, { title: '三体', seriesName: '三体', seriesPosition: 1, authorName: 'Liu Cixin' });
        const bangs = await seedBookWithSeries(db, { title: 'Punctuation Only', seriesName: '!!!', seriesPosition: 1, authorName: 'Someone' });

        for (const bookId of [dozory, santi, bangs]) {
          expect((await libraryOnly().getSeriesForBook(bookId))!.members.map((m) => m.libraryBookId)).toEqual([bookId]);
        }
      });

      it('a byte-identical second spelling of an empty-normalized name DOES pool', async () => {
        const first = await seedBookWithSeries(db, { title: '三体', seriesName: '三体', seriesPosition: 1, authorName: 'Liu Cixin' });
        const second = await seedBookWithSeries(db, { title: '黑暗森林', seriesName: '三体', seriesPosition: 2, authorName: 'Liu Cixin' });
        const drifted = await seedBookWithSeries(db, { title: '死神永生', seriesName: ' 三体 ', seriesPosition: 3, authorName: 'Liu Cixin' });

        const card = await libraryOnly().getSeriesForBook(first);
        expect(card!.members.map((m) => m.libraryBookId)).toEqual([first, second]);
        // Empty-normalized names use byte-exact matching; folding would pool unrelated non-Latin names.
        expect(card!.members.some((m) => m.libraryBookId === drifted)).toBe(false);
      });

      it("a book stored with series_name = '' joins no other empty-normalized bucket", async () => {
        const dozory = await seedBookWithSeries(db, { title: 'Ночной Дозор', seriesName: 'Дозоры', seriesPosition: 1, authorName: 'Sergei Lukyanenko' });
        const blank = await seedBookWithSeries(db, { title: 'Blank Series', seriesName: '', seriesPosition: 1, authorName: 'Someone' });

        expect((await libraryOnly().getSeriesForBook(dozory))!.members.map((m) => m.libraryBookId)).toEqual([dozory]);
        // Empty series_name is falsy, so its own card remains unreachable.
        expect(await libraryOnly().getSeriesForBook(blank)).toBeNull();
      });

      /** Widening an empty-normalized bind would rewrite every non-Latin series in its pool. */
      it('a bind on an empty-normalized name rewrites no other series', async () => {
        const santi = await seedBookWithSeries(db, { title: '三体', seriesName: '三体', authorName: 'Liu Cixin' });
        const dozory = await seedBookWithSeries(db, { title: 'Ночной Дозор', seriesName: 'Дозоры', authorName: 'Sergei Lukyanenko' });
        mockHardcover({
          data: {
            series: [{
              id: 9001, name: '三体', slug: 'santi', author: { name: 'Liu Cixin' },
              book_series: [{ position: 1, book: { id: 3001, slug: 'santi-1', title: '三体', image: null, users_count: 100 } }],
            }],
          },
        });

        const bound = await new SeriesCardService(db, log, settingsServiceWith('TEST_KEY')).bindHardcoverSeries(santi, 9001);

        expect(bound!.syncedIds).toEqual([santi]);
        expect((await db.select().from(books).where(eq(books.id, dozory)))[0]!.seriesName).toBe('Дозоры');
        // Widening must not enroll other non-Latin series through local-row seeding either.
        expect(await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, dozory))).toHaveLength(0);
      });
    });

    describe('AC7 — the pinned claim order survives the JS filter', () => {
      /** JS filtering preserves loader order; inverted BINARY-collated spellings make a missing lower-ID ORDER BY observable. */
      it('the lower-id book wins even when it is the drifted one', async () => {
        const lowerId = await seedBookWithSeries(db, { title: 'Chapterhouse Dune', seriesName: 'zeta series', seriesPosition: null, authorName: 'Frank Herbert' });
        const higherId = await seedBookWithSeries(db, { title: 'Chapterhouse: Dune', seriesName: 'Zeta Series', seriesPosition: null, authorName: 'Frank Herbert' });
        expect(higherId).toBeGreaterThan(lowerId);

        await forcePoolReorderingIndex(db);
        expect(await poolProbeIds(db)).toEqual([higherId, lowerId]);

        mockHardcover({
          data: {
            series: [{
              id: 7703, name: 'Zeta Series', slug: 'zeta-series', author: { name: 'Frank Herbert' },
              book_series: [{ position: null, book: { id: 4001, slug: 'chapterhouse-dune', title: 'Chapterhouse: Dune', image: null, users_count: 50 } }],
            }],
          },
        });

        const card = await new SeriesCardService(db, log, settingsServiceWith('TEST_KEY')).getSeriesForBook(higherId);

        const hardcover = (await db.select().from(seriesMembers)).filter((m) => m.source === 'hardcover');
        expect(hardcover).toHaveLength(1);
        expect(hardcover[0]!.bookId).toBe(lowerId);
        expect(card!.members.find((m) => m.hardcoverBookId === 4001)!.libraryBookId).toBe(lowerId);
      });
    });

    describe('AC14 — one statement, zero pool-derived parameters', () => {
      const SEPARATORS = ['-', '_', '.', ',', ':', ';', '/', '&'];

      /** Generates 512 raw spellings that all normalize to "the band". */
      function driftedSpelling(index: number): string {
        const a = SEPARATORS[index % 8]!;
        const b = SEPARATORS[Math.floor(index / 8) % 8]!;
        const c = SEPARATORS[Math.floor(index / 64) % 8]!;
        return `The${a}${b}${c}Band`;
      }

      /**
       * Schema does not bound raw spellings per equivalence class. Only zero args
       * distinguishes JS filtering from a dynamic IN query; count, results, and order match.
       */
      it('a pool spanning 300 distinct spellings loads in one parameterless statement', async () => {
        const anchor = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        const siblings: number[] = [];
        for (let i = 0; i < 300; i++) {
          siblings.push(await seedBookWithSeries(db, { title: `Drifted ${i}`, seriesName: driftedSpelling(i), seriesPosition: i + 2 }));
        }
        expect(new Set(Array.from({ length: 300 }, (_, i) => driftedSpelling(i))).size).toBe(300);

        const spy = spyStatements(db);
        const card = await libraryOnly().getSeriesForBook(anchor);
        spy.restore();

        const pool = poolStatements(spy.executed);
        expect(pool).toHaveLength(1);
        expect(pool[0]!.args).toEqual([]);
        expect(pool[0]!.sql).toMatch(/"series_name" is not null/i);
        expect(pool[0]!.sql).not.toMatch(/ in \(/i);
        expect(card!.members.map((m) => m.libraryBookId)).toEqual([anchor, ...siblings]);
      });

      it('an empty name list returns an empty pool without issuing a query', async () => {
        await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        const svc = libraryOnly() as unknown as {
          loadLibraryBooksForSeriesNames: (names: string[]) => Promise<{ books: unknown[]; positionClearedIds: Set<number> }>;
        };

        const spy = spyStatements(db);
        const pool = await svc.loadLibraryBooksForSeriesNames([]);
        spy.restore();

        expect(pool).toEqual({ books: [], positionClearedIds: new Set() });
        expect(poolStatements(spy.executed)).toHaveLength(0);
      });

      it('the seriesPosition tombstones ride on the pool statement', async () => {
        const anchor = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        const drifted = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'the band', seriesPosition: null, authorName: 'Nicholas Eames' });
        await db.update(books).set({ userClearedFields: '["seriesPosition"]' }).where(eq(books.id, drifted));
        mockHardcover(bandPayload());
        const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
        await svc.getSeriesForBook(anchor);

        const spy = spyStatements(db);
        const card = await svc.getSeriesForBook(anchor);
        spy.restore();

        const pool = poolStatements(spy.executed);
        expect(pool).toHaveLength(1);
        expect(pool[0]!.sql).toMatch(/"user_cleared_fields"/);
        // Claim plus null position proves the tombstone from this read reached rendering.
        const claimed = card!.members.find((m) => m.libraryBookId === drifted)!;
        expect(claimed.hardcoverBookId).toBe(7712);
        expect(claimed.position).toBeNull();
      });
    });

    describe('null and missing rows', () => {
      it('a seriesName-tombstoned book never enters the pool under any spelling', async () => {
        const anchor = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        const tombstoned = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: null, seriesPosition: null, authorName: 'Nicholas Eames' });
        await db.update(books).set({ userClearedFields: '["seriesName"]' }).where(eq(books.id, tombstoned));
        mockHardcover(bandPayload());
        const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));

        const card = await svc.getSeriesForBook(anchor);

        // Exact title match makes null seriesName the only exclusion.
        expect(card!.members.find((m) => m.hardcoverBookId === 7712)!.inLibrary).toBe(false);
        expect(await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, tombstoned))).toHaveLength(0);
      });

      it('a drifted sibling with position null and one with position 0 both render', async () => {
        const anchor = await seedBookWithSeries(db, { title: 'Anchor', seriesName: 'The Band', seriesPosition: 5, authorName: 'Nicholas Eames' });
        const zero = await seedBookWithSeries(db, { title: 'Prequel', seriesName: 'the band', seriesPosition: 0 });
        const none = await seedBookWithSeries(db, { title: 'Unnumbered', seriesName: 'THE BAND', seriesPosition: null });

        const card = await libraryOnly().getSeriesForBook(anchor);

        expect(card!.members.map((m) => [m.libraryBookId, m.position]))
          .toEqual([[zero, 0], [anchor, 5], [none, null]]);
      });
    });

    describe('the reconcile seeds and re-reads through the same widened rule', () => {
      function oneMemberPayload(): unknown {
        return {
          data: {
            series: [{
              id: 5523, name: 'The Band', slug: 'the-band', author: { name: 'Nicholas Eames' },
              book_series: [{ position: 1, book: { id: 7711, slug: 'kings', title: 'Kings of the Wyld', image: null, users_count: 100 } }],
            }],
          },
        };
      }

      it('a drifted unclaimed sibling gets exactly one local row, and a second GET adds none', async () => {
        const kings = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        const drifted = await seedBookWithSeries(db, { title: 'Outcast Sibling', seriesName: 'the band', seriesPosition: 9, authorName: 'Nicholas Eames' });
        mockHardcover(oneMemberPayload());
        const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));

        const first = await svc.getSeriesForBook(kings);
        expect(first!.members.map((m) => m.libraryBookId)).toEqual([kings, drifted]);
        const afterFirst = (await db.select().from(seriesMembers)).filter((m) => m.bookId === drifted);
        expect(afterFirst).toHaveLength(1);
        expect(afterFirst[0]!.source).toBe('local');

        const second = await svc.getSeriesForBook(kings);
        expect(second!.members.map((m) => m.libraryBookId)).toEqual([kings, drifted]);
        expect((await db.select().from(seriesMembers)).filter((m) => m.bookId === drifted)).toHaveLength(1);
      });

      it('a fully-claimed widened pool opens no transaction and issues no write', async () => {
        const kings = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        const drifted = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'the band', seriesPosition: 2, authorName: 'Nicholas Eames' });
        mockHardcover(bandPayload());
        const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
        await svc.getSeriesForBook(kings);

        const txSpy = vi.spyOn(db, 'transaction');
        const spy = spyStatements(db);
        const card = await svc.getSeriesForBook(kings);
        spy.restore();
        expect(txSpy).not.toHaveBeenCalled();
        txSpy.mockRestore();

        expect(spy.executed.filter((s) => /^update "books"/i.test(s.sql.trim()))).toHaveLength(0);
        expect(card!.members.map((m) => m.libraryBookId)).toEqual([kings, drifted]);
        expect((await db.select().from(books).where(eq(books.id, drifted)))[0]!.seriesName).toBe('the band');
      });

      /** Refresh between snapshot and transaction must prevent stale-pool resurrection of a local row beside the canonical one. */
      it('a refresh landing between the snapshot and the reconcile makes the guard write nothing', async () => {
        const kings = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        const drifted = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'the band', seriesPosition: 2, authorName: 'Nicholas Eames' });
        mockHardcover(oneMemberPayload());
        const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
        await svc.getSeriesForBook(kings);
        await db.delete(seriesMembers).where(eq(seriesMembers.source, 'local'));

        const openTransaction = db.transaction.bind(db);
        const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(async (callback) => {
          mockHardcover(bandPayload());
          await svc.refreshSeriesForBook(kings);
          return openTransaction(callback);
        });

        mockHardcover(oneMemberPayload());
        const card = await svc.getSeriesForBook(kings);
        spy.mockRestore();

        const forDrifted = (await db.select().from(seriesMembers)).filter((m) => m.bookId === drifted);
        expect(forDrifted).toHaveLength(1);
        expect(forDrifted[0]!.source).toBe('hardcover');
        expect(card!.members.filter((m) => m.libraryBookId === drifted)).toHaveLength(1);
      });

      it('a drifted book deleted between the snapshot and the reconcile is dropped, not FK-rejected', async () => {
        const kings = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        const doomed = await seedBookWithSeries(db, { title: 'Outcast Sibling', seriesName: 'the band', seriesPosition: 9, authorName: 'Nicholas Eames' });
        mockHardcover(oneMemberPayload());
        const observed = createMockLogger();
        const svc = new SeriesCardService(db, inject(observed), settingsServiceWith('TEST_KEY'));
        await svc.getSeriesForBook(kings);
        // Positive control: the seed fires before deletion during reconciliation.
        expect((await db.select().from(seriesMembers)).filter((m) => m.bookId === doomed)).toHaveLength(1);
        await db.delete(seriesMembers).where(eq(seriesMembers.source, 'local'));
        (observed.warn as ReturnType<typeof vi.fn>).mockClear();

        const openTransaction = db.transaction.bind(db);
        const spy = vi.spyOn(db, 'transaction').mockImplementationOnce(async (callback) => {
          await db.delete(books).where(eq(books.id, doomed));
          return openTransaction(callback);
        });

        const card = await svc.getSeriesForBook(kings);
        spy.mockRestore();

        expect(observed.warn).not.toHaveBeenCalled();
        expect((await db.select().from(seriesMembers)).filter((m) => m.source === 'local')).toHaveLength(0);
        expect(card!.members.map((m) => m.libraryBookId)).toEqual([kings]);
      });

      it('a failing reconcile over a widened pool still returns the pre-write snapshot card', async () => {
        const kings = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        const drifted = await seedBookWithSeries(db, { title: 'Outcast Sibling', seriesName: 'the band', seriesPosition: 9, authorName: 'Nicholas Eames' });
        mockHardcover(oneMemberPayload());
        const observed = createMockLogger();
        const svc = new SeriesCardService(db, inject(observed), settingsServiceWith('TEST_KEY'));
        await svc.getSeriesForBook(kings);
        await db.delete(seriesMembers).where(eq(seriesMembers.source, 'local'));
        (observed.warn as ReturnType<typeof vi.fn>).mockClear();

        const spy = vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('reconcile boom'));
        const card = await svc.getSeriesForBook(kings);
        spy.mockRestore();

        expect(card!.members.map((m) => m.libraryBookId)).toEqual([kings, drifted]);
        expect((await db.select().from(seriesMembers)).filter((m) => m.source === 'local')).toHaveLength(0);
        expect((observed.warn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      });

      /** Local book_id claims precede title matching; otherwise a drifted same-title book appears twice. */
      it('a local row claims its drifted book by id before the title matcher runs', async () => {
        const kings = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        const drifted = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'the band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        mockHardcover(oneMemberPayload());
        const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));

        const card = await svc.getSeriesForBook(kings);

        expect(card!.members.find((m) => m.hardcoverBookId === 7711)!.libraryBookId).toBe(kings);
        expect(card!.members.filter((m) => m.libraryBookId === drifted)).toHaveLength(1);
        expect((await db.select().from(seriesMembers)).filter((m) => m.bookId === drifted)).toHaveLength(1);
      });
    });

    describe('AC3 — refresh and cron agree with the book’s own card', () => {
      it('a manual refresh on the non-drifted book resolves the drifted sibling', async () => {
        const kings = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        const drifted = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'the band', seriesPosition: 2, authorName: 'Nicholas Eames' });
        mockHardcover(bandPayload());

        const card = await new SeriesCardService(db, log, settingsServiceWith('TEST_KEY')).refreshSeriesForBook(kings);

        expect(card!.members.map((m) => [m.hardcoverBookId, m.libraryBookId])).toEqual([[7711, kings], [7712, drifted]]);
      });

      it('the cron cached-id branch (pool keyed on series.name) resolves the drifted book', async () => {
        const drifted = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'the band', seriesPosition: 2, authorName: 'Nicholas Eames' });
        await db.insert(series).values({
          publicId: generatePublicId('sr'),
          name: 'The Band',
          normalizedName: 'the band',
          hardcoverSeriesId: 5523,
          authorName: 'Nicholas Eames',
          lastFetchedAt: new Date(Date.now() - 30 * 86_400_000),
        });
        mockHardcover(bandPayload());

        const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
        expect(await svc.runScheduledRefresh()).toEqual({ refreshed: 1, skipped: 0 });

        const rows = await db.select().from(seriesMembers);
        expect(rows.find((r) => r.hardcoverBookId === 7712)!.bookId).toBe(drifted);
        // Refresh must not canonicalize series_name.
        expect((await db.select().from(books).where(eq(books.id, drifted)))[0]!.seriesName).toBe('the band');
      });

      it('the cron null-id branch (pool keyed on a linked book’s own spelling) resolves its drifted sibling', async () => {
        const drifted = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'the band', seriesPosition: 2, authorName: 'Nicholas Eames' });
        const kings = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
        const [row] = await db.insert(series).values({
          publicId: generatePublicId('sr'),
          name: 'The Band',
          normalizedName: 'the band',
          hardcoverSeriesId: null,
          authorName: null,
          lastFetchedAt: new Date(Date.now() - 30 * 86_400_000),
        }).returning();
        // Lowest-ID linked book supplies its own spelling to refreshByLinkedBook.
        await db.insert(seriesMembers).values({
          seriesId: row!.id, bookId: drifted, title: 'Bloody Rose', normalizedTitle: 'bloody rose', authorName: 'Nicholas Eames', position: 2, source: 'local',
        });
        const fetchMock = mockHardcover(bandPayload());

        const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
        expect(await svc.runScheduledRefresh()).toEqual({ refreshed: 1, skipped: 0 });

        expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).variables.name).toBe('the band');
        const rows = await db.select().from(seriesMembers);
        expect(rows.find((r) => r.hardcoverBookId === 7711)!.bookId).toBe(kings);
        expect(rows.find((r) => r.hardcoverBookId === 7712)!.bookId).toBe(drifted);
        expect((await db.select().from(books).where(eq(books.id, kings)))[0]!.seriesName).toBe('The Band');
      });
    });
  });
});
