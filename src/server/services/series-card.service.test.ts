import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books, bookAuthors, authors, series, seriesMembers } from '../../db/schema.js';
import { SeriesCardService, STALE_AFTER_DAYS } from './series-card.service.js';
import type { SettingsService } from './settings.service.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

const ORIGINAL_FETCH = globalThis.fetch;

/** Settings stub returning an arbitrary `metadata` shape from `get('metadata')`. */
function settingsServiceWithMetadata(metadata: Record<string, unknown>): SettingsService {
  return inject<SettingsService>({
    get: vi.fn().mockResolvedValue(metadata),
  });
}

function settingsServiceWith(apiKey: string): SettingsService {
  return settingsServiceWithMetadata({ hardcoverApiKey: apiKey });
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

interface MemberInput {
  position: number | null;
  id: number;
  slug: string;
  title: string;
  imageUrl?: string | null;
  usersCount?: number;
}

/** Build a Hardcover GraphQL `series` envelope for the canned fetch boundary. */
function hardcoverSeriesPayload(opts: {
  id: number;
  name: string;
  slug?: string;
  author: string | null;
  members: MemberInput[];
}): unknown {
  return {
    data: {
      series: [{
        id: opts.id,
        name: opts.name,
        slug: opts.slug ?? opts.name.toLowerCase().replace(/\s+/g, '-'),
        author: opts.author === null ? null : { name: opts.author },
        book_series: opts.members.map((m) => ({
          position: m.position,
          book: {
            id: m.id,
            slug: m.slug,
            title: m.title,
            image: m.imageUrl ? { url: m.imageUrl } : null,
            users_count: m.usersCount ?? 50,
          },
        })),
      }],
    },
  };
}

/** Install a `globalThis.fetch` stub returning a single canned 200 GraphQL response. */
function mockFetchOnce(payload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  globalThis.fetch = fetchMock as typeof globalThis.fetch;
  return fetchMock;
}

describe('SeriesCardService — unit', () => {
  let dir: string;
  let db: Db;
  let rawLog: ReturnType<typeof createMockLogger>;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'series-card-unit-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    rawLog = createMockLogger();
    log = inject<FastifyBaseLogger>(rawLog);
  });

  afterEach(() => {
    db.$client.close();
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may keep the file handle on Windows
    }
  });

  // --- Public-method early-return guards (AC2) ---------------------------------

  describe('early-return guards', () => {
    it('getSeriesForBook returns null for a non-existent book id', async () => {
      const svc = new SeriesCardService(db, log, settingsServiceWith('KEY'));
      expect(await svc.getSeriesForBook(987654)).toBeNull();
    });

    it('getSeriesForBook returns null when the book has no seriesName', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Standalone', seriesName: null, authorName: 'Someone' });
      const svc = new SeriesCardService(db, log, settingsServiceWith('KEY'));
      expect(await svc.getSeriesForBook(bookId)).toBeNull();
    });

    it('refreshSeriesForBook returns null for a non-existent book id', async () => {
      const svc = new SeriesCardService(db, log, settingsServiceWith('KEY'));
      expect(await svc.refreshSeriesForBook(987654)).toBeNull();
    });

    it('refreshSeriesForBook returns null when the book has no seriesName', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Standalone', seriesName: null, authorName: 'Someone' });
      const svc = new SeriesCardService(db, log, settingsServiceWith('KEY'));
      expect(await svc.refreshSeriesForBook(bookId)).toBeNull();
    });
  });

  // --- Scenario 1: happy path --------------------------------------------------

  describe('happy path (cache-miss → resolve → persist)', () => {
    it('returns members in compareByPositionThenTitle order with inLibrary / libraryBookId computed', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      const fetchMock = mockFetchOnce(hardcoverSeriesPayload({
        id: 5523,
        name: 'The Band',
        author: 'Nicholas Eames',
        members: [
          // Deliberately out of order in the payload — service must sort.
          { position: 3, id: 1003, slug: 'heretic', title: 'Heretic' },
          { position: 1, id: 1001, slug: 'kings', title: 'Kings of the Wyld', imageUrl: 'https://example.test/kw.jpg' },
          { position: 2, id: 1002, slug: 'bloody', title: 'Bloody Rose' },
        ],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      expect(card).not.toBeNull();
      expect(card!.hardcoverSeriesId).toBe(5523);
      expect(card!.seriesAuthor).toBe('Nicholas Eames');
      expect(card!.members.map((m) => m.title)).toEqual(['Kings of the Wyld', 'Bloody Rose', 'Heretic']);
      expect(card!.members.map((m) => m.position)).toEqual([1, 2, 3]);

      const bloody = card!.members.find((m) => m.title === 'Bloody Rose')!;
      expect(bloody.inLibrary).toBe(true);
      expect(bloody.libraryBookId).toBe(bookId);
      const kings = card!.members.find((m) => m.title === 'Kings of the Wyld')!;
      expect(kings.inLibrary).toBe(false);
      expect(kings.libraryBookId).toBeNull();
      expect(kings.imageUrl).toBe('https://example.test/kw.jpg');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('orders positions [1, 2.5, null, 4] with null last and localeCompare tie-break on equal positions', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Anchor', seriesName: 'Test Series', seriesPosition: 1, authorName: 'Some Author' });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 9999,
        name: 'Test Series',
        author: 'Some Author',
        members: [
          { position: null, id: 5, slug: 'companion', title: 'Companion' },
          { position: 4, id: 4, slug: 'four', title: 'Book Four' },
          { position: 1, id: 1, slug: 'one', title: 'Book One' },
          { position: 2.5, id: 2, slug: 'two-five', title: 'Book Two-Five' },
          // Equal positions → title tie-break (Alpha before Beta).
          { position: 1, id: 6, slug: 'alpha', title: 'Alpha' },
        ],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      expect(card!.members.map((m) => m.position)).toEqual([1, 1, 2.5, 4, null]);
      // Position 1 tie broken by title: 'Alpha' < 'Book One'
      expect(card!.members.slice(0, 2).map((m) => m.title)).toEqual(['Alpha', 'Book One']);
      expect(card!.members.at(-1)!.title).toBe('Companion');
    });
  });

  // --- Scenario 2: Hardcover failure -------------------------------------------

  describe('Hardcover failure → library-only fallback', () => {
    it.each([
      // The mapped error type proves serializeError() ran: 401 → MetadataError,
      // 5xx and network throws → TransientError (see hardcover.ts mapHttpError /
      // mapNetworkError). A raw `Error` logged as `{ error }` would have neither
      // a `.type` field nor the mapped name, and would still be an Error instance.
      { label: '401 unauthorized', expectedType: 'MetadataError', makeFetch: () => vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })) },
      { label: '500 server error', expectedType: 'TransientError', makeFetch: () => vi.fn().mockResolvedValue(new Response('boom', { status: 500 })) },
      { label: 'thrown network error', expectedType: 'TransientError', makeFetch: () => vi.fn().mockRejectedValue(new Error('ECONNRESET')) },
    ])('degrades to library-only and does not persist a partial row on $label', async ({ makeFetch, expectedType }) => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      globalThis.fetch = makeFetch() as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      expect(card).not.toBeNull();
      expect(card!.id).toBeNull();
      expect(card!.hardcoverSeriesId).toBeNull();
      expect(card!.members).toHaveLength(1);
      expect(card!.members[0]!.title).toBe('Bloody Rose');
      expect(card!.members[0]!.inLibrary).toBe(true);

      // No partial cache row persisted on failure.
      expect(await db.select().from(series)).toHaveLength(0);

      // Error logged via serializeError() — assert the serialized contract, not
      // just "is an object". Deleting `serializeError(error)` from the catch
      // would log the raw Error (an Error instance with no `.type`/`.message`
      // own-enumerable serialized shape), failing these assertions.
      expect(rawLog.warn).toHaveBeenCalled();
      const warnedWithError = (rawLog.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        ([meta]) => typeof meta === 'object' && meta !== null && 'error' in (meta as object),
      );
      expect(warnedWithError).toBeDefined();
      const logged = (warnedWithError![0] as { error: unknown }).error;
      expect(logged).not.toBeInstanceOf(Error);
      const serialized = logged as { type?: unknown; message?: unknown; stack?: unknown };
      expect(serialized.type).toBe(expectedType);
      expect(typeof serialized.message).toBe('string');
      expect(typeof serialized.stack).toBe('string');
    });
  });

  // --- Scenario 3: missing-key vs failure distinction --------------------------

  describe('missing / empty / whitespace API key → library-only, no fetch', () => {
    it.each(['', '   ', '\t\n'])('getSeriesForBook degrades without a Hardcover fetch for key %j', async (apiKey) => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith(apiKey));
      const card = await svc.getSeriesForBook(bookId);

      expect(card!.id).toBeNull();
      expect(card!.hardcoverSeriesId).toBeNull();
      expect(card!.members.map((m) => m.title)).toEqual(['Kings of the Wyld', 'Bloody Rose']);
      expect(card!.members.every((m) => m.inLibrary)).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'the hardcoverApiKey field is absent', metadata: {} },
      { label: 'hardcoverApiKey is explicitly undefined', metadata: { hardcoverApiKey: undefined } },
    ])('getSeriesForBook degrades without a Hardcover fetch when $label', async ({ metadata }) => {
      // Guards the `(metadata.hardcoverApiKey ?? '')` nullish coalesce: a
      // regression to `metadata.hardcoverApiKey.trim()` would throw here on an
      // absent/undefined key instead of degrading to library-only.
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'The Band', seriesPosition: 1, authorName: 'Nicholas Eames' });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWithMetadata(metadata));
      const card = await svc.getSeriesForBook(bookId);

      expect(card!.id).toBeNull();
      expect(card!.hardcoverSeriesId).toBeNull();
      expect(card!.members.map((m) => m.title)).toEqual(['Kings of the Wyld', 'Bloody Rose']);
      expect(card!.members.every((m) => m.inLibrary)).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('runScheduledRefresh returns { refreshed: 0, skipped: 0 } and never fetches when no key', async () => {
      // Seed a stale row that WOULD be swept if a key were present.
      await db.insert(series).values({
        name: 'The Band', normalizedName: 'the band', hardcoverSeriesId: 5523, authorName: 'Nicholas Eames',
        lastFetchedAt: new Date(Date.now() - 30 * 86_400_000),
      });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('  '));
      const result = await svc.runScheduledRefresh();

      expect(result).toEqual({ refreshed: 0, skipped: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // --- Scenario 4: in-library detection ----------------------------------------

  describe('in-library detection', () => {
    it('matches case-insensitively by title, falls through on empty normalized title, and never double-claims a library book', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      // Cache-hit path: hardcoverSeriesId present → buildCardFromCache.
      const [row] = await db.insert(series).values({
        hardcoverSeriesId: 5523, name: 'The Band', normalizedName: 'the band', authorName: 'Nicholas Eames', lastFetchedAt: new Date(),
      }).returning();
      await db.insert(seriesMembers).values([
        // Case differs and position is null → must still match by normalized title.
        { seriesId: row!.id, hardcoverBookId: 1002, slug: 'bloody', title: 'BLOODY ROSE', normalizedTitle: 'bloody rose', authorName: 'Nicholas Eames', position: null, source: 'hardcover' },
        // Punctuation/brackets only → normalized title empty, position null → falls through (not in library).
        { seriesId: row!.id, hardcoverBookId: 1099, slug: 'art', title: '[ ]', normalizedTitle: '', authorName: 'Nicholas Eames', position: null, source: 'hardcover' },
      ]);

      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;
      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      expect(fetchSpy).not.toHaveBeenCalled();
      const matched = card!.members.find((m) => m.title === 'BLOODY ROSE')!;
      expect(matched.inLibrary).toBe(true);
      expect(matched.libraryBookId).toBe(bookId);
      const empty = card!.members.find((m) => m.title === '[ ]')!;
      expect(empty.inLibrary).toBe(false);
      expect(empty.libraryBookId).toBeNull();

      // No library book id claimed by more than one member.
      const claimed = card!.members.map((m) => m.libraryBookId).filter((v): v is number => v !== null);
      expect(claimed).toEqual([...new Set(claimed)]);
    });
  });

  // --- Scenario 5: STALE_AFTER_DAYS sweep (clock frozen) -----------------------

  describe('runScheduledRefresh — stale boundary (lt, not lte; clock frozen)', () => {
    it('refreshes rows strictly older than the cutoff and skips rows at or younger than it', async () => {
      const fixedNow = new Date('2026-01-15T00:00:00.000Z').getTime();
      vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
      const cutoff = fixedNow - STALE_AFTER_DAYS * 86_400_000;

      // Strictly older than cutoff → swept. Has a hardcoverSeriesId so it takes
      // the refreshById path with a successful fetch.
      await db.insert(series).values({
        name: 'Stale', normalizedName: 'stale', hardcoverSeriesId: 5523, authorName: 'A',
        lastFetchedAt: new Date(cutoff - 1),
      });
      // Exactly at the cutoff → NOT swept (lt is strict).
      await db.insert(series).values({
        name: 'Boundary', normalizedName: 'boundary', hardcoverSeriesId: 6000, authorName: 'B',
        lastFetchedAt: new Date(cutoff),
      });
      // Younger than the cutoff → NOT swept.
      await db.insert(series).values({
        name: 'Fresh', normalizedName: 'fresh', hardcoverSeriesId: 7000, authorName: 'C',
        lastFetchedAt: new Date(cutoff + 1),
      });

      const fetchMock = mockFetchOnce(hardcoverSeriesPayload({
        id: 5523, name: 'Stale', author: 'A', members: [{ position: 1, id: 1, slug: 's1', title: 'Stale One' }],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const result = await svc.runScheduledRefresh();

      // Only the strictly-older row was processed.
      expect(result).toEqual({ refreshed: 1, skipped: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.variables.id).toBe(5523);
    });
  });

  // --- Scenario 6: cache re-resolution / scheduled-refresh branch --------------

  describe('cache re-resolution branches', () => {
    it('cache hit (hardcoverSeriesId present) is served without a fetch', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      const [row] = await db.insert(series).values({
        hardcoverSeriesId: 5523, name: 'The Band', normalizedName: 'the band', authorName: 'Cached Author', lastFetchedAt: new Date(),
      }).returning();
      await db.insert(seriesMembers).values({
        seriesId: row!.id, hardcoverBookId: 1002, slug: 'bloody', title: 'Bloody Rose', normalizedTitle: 'bloody rose', authorName: 'Cached Author', position: 2, source: 'hardcover',
      });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      expect(card!.hardcoverSeriesId).toBe(5523);
      expect(card!.seriesAuthor).toBe('Cached Author');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('cached row with null hardcoverSeriesId falls through to a fresh resolve + persist', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      // Cache exists but is unresolved (null hardcoverSeriesId) → cache miss path.
      await db.insert(series).values({
        hardcoverSeriesId: null, name: 'The Band', normalizedName: 'the band', authorName: null, lastFetchedAt: new Date(),
      });
      const fetchMock = mockFetchOnce(hardcoverSeriesPayload({
        id: 5523, name: 'The Band', author: 'Nicholas Eames', members: [{ position: 2, id: 1002, slug: 'bloody', title: 'Bloody Rose' }],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(card!.hardcoverSeriesId).toBe(5523);
      const persisted = await db.select().from(series).where(eq(series.normalizedName, 'the band'));
      expect(persisted).toHaveLength(1);
      expect(persisted[0]!.hardcoverSeriesId).toBe(5523);
    });

    it('runScheduledRefresh takes the by-id path for a stale row with a hardcoverSeriesId', async () => {
      const [row] = await db.insert(series).values({
        name: 'The Band', normalizedName: 'the band', hardcoverSeriesId: 5523, authorName: 'Old Author',
        lastFetchedAt: new Date(Date.now() - 30 * 86_400_000),
      }).returning();
      const fetchMock = mockFetchOnce(hardcoverSeriesPayload({
        id: 5523, name: 'The Band', author: 'New Author', members: [{ position: 1, id: 1001, slug: 'kings', title: 'Kings of the Wyld' }],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const result = await svc.runScheduledRefresh();

      expect(result).toEqual({ refreshed: 1, skipped: 0 });
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.query).toContain('GetSeriesMembersById');
      expect(body.variables.id).toBe(5523);
      const after = (await db.select().from(series).where(eq(series.id, row!.id)))[0]!;
      expect(after.authorName).toBe('New Author');
    });

    it('runScheduledRefresh resolves a null-id row via its lowest-books.id linked book', async () => {
      const [row] = await db.insert(series).values({
        name: 'Shared Series', normalizedName: 'shared series', hardcoverSeriesId: null, authorName: null,
        lastFetchedAt: new Date(Date.now() - 30 * 86_400_000),
      }).returning();
      // Two linked books with observably distinct seriesName + author. The
      // lower-id book is inserted first; the resolver issues a by-name request
      // whose variables prove WHICH book `orderBy(asc(books.id))` selected.
      // Reversing or removing that ordering would send the higher-id book's
      // name/author and fail the assertions below.
      const lowerBookId = await seedBookWithSeries(db, { title: 'Kings of the Wyld', seriesName: 'Lower Series Name', seriesPosition: 1, authorName: 'Lower Author' });
      const higherBookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'Higher Series Name', seriesPosition: 2, authorName: 'Higher Author' });
      expect(lowerBookId).toBeLessThan(higherBookId);
      // Insert series_members in the OPPOSITE order from books.id, so the
      // load-bearing signal is the query's orderBy, not member insertion order.
      await db.insert(seriesMembers).values([
        { seriesId: row!.id, bookId: higherBookId, title: 'Bloody Rose', normalizedTitle: 'bloody rose', authorName: 'Higher Author', position: 2, source: 'local' },
        { seriesId: row!.id, bookId: lowerBookId, title: 'Kings of the Wyld', normalizedTitle: 'kings of the wyld', authorName: 'Lower Author', position: 1, source: 'local' },
      ]);
      const fetchMock = mockFetchOnce(hardcoverSeriesPayload({
        id: 5523, name: 'Lower Series Name', author: 'Lower Author', members: [{ position: 1, id: 1001, slug: 'kings', title: 'Kings of the Wyld' }],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const result = await svc.runScheduledRefresh();

      expect(result).toEqual({ refreshed: 1, skipped: 0 });
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.query).toContain('GetSeriesMembers');
      expect(body.query).not.toContain('GetSeriesMembersById');
      // Variables MUST come from the lower-books.id book.
      expect(body.variables.name).toBe('Lower Series Name');
      expect(body.variables.author).toBe('Lower Author');
    });

    it('runScheduledRefresh counts a null-id row with no qualifying linked book as skipped', async () => {
      await db.insert(series).values({
        name: 'Ghost', normalizedName: 'ghost', hardcoverSeriesId: null, authorName: null,
        lastFetchedAt: new Date(Date.now() - 30 * 86_400_000),
      });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const result = await svc.runScheduledRefresh();

      expect(result).toEqual({ refreshed: 0, skipped: 1 });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // --- Scenario 7 & 8: member dedup + omnibus collapse (service boundary) ------

  describe('member dedup and no card inflation', () => {
    it('two Hardcover members at the same position never both claim one library book', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 5523,
        name: 'The Band',
        author: 'Nicholas Eames',
        members: [
          { position: 1, id: 1001, slug: 'kings', title: 'Kings of the Wyld' },
          // Two members at position 2 — only one may claim the single library book.
          { position: 2, id: 1002, slug: 'bloody-a', title: 'Bloody Rose A' },
          { position: 2, id: 1003, slug: 'bloody-b', title: 'Bloody Rose B' },
        ],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      const claimed = card!.members.map((m) => m.libraryBookId).filter((v): v is number => v !== null);
      expect(claimed).toEqual([bookId]);
      expect(claimed).toEqual([...new Set(claimed)]);
      // Persisted series_members must likewise carry the bookId on exactly one row.
      const persisted = await db.select().from(series).where(eq(series.hardcoverSeriesId, 5523));
      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, persisted[0]!.id));
      const populated = memberRows.map((m) => m.bookId).filter((v): v is number => v !== null);
      expect(populated).toEqual([bookId]);
    });

    it('does not inflate the card beyond the canonical Hardcover member list or add local members', async () => {
      // A library book exists in the series but is NOT in the canonical Hardcover
      // list — the service must not append it as an extra member.
      const bookId = await seedBookWithSeries(db, { title: 'Local Only', seriesName: 'The Band', seriesPosition: 9, authorName: 'Nicholas Eames' });
      const canonical: MemberInput[] = [
        { position: 1, id: 1001, slug: 'kings', title: 'Kings of the Wyld' },
        { position: 2, id: 1002, slug: 'bloody', title: 'Bloody Rose' },
        { position: 3, id: 1003, slug: 'heretic', title: 'Heretic' },
      ];
      mockFetchOnce(hardcoverSeriesPayload({ id: 5523, name: 'The Band', author: 'Nicholas Eames', members: canonical }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      expect(card!.members).toHaveLength(canonical.length);
      expect(card!.members.map((m) => m.title)).toEqual(['Kings of the Wyld', 'Bloody Rose', 'Heretic']);
      // The local-only book at position 9 was not appended.
      expect(card!.members.some((m) => m.title === 'Local Only')).toBe(false);
    });
  });

  // --- refreshSeriesForBook primary + fallback branches (AC2) ------------------

  describe('refreshSeriesForBook', () => {
    it('re-fetches via GetSeriesMembersById when a cached hardcoverSeriesId exists', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      await db.insert(series).values({
        hardcoverSeriesId: 5523, name: 'The Band', normalizedName: 'the band', authorName: 'Old Author', lastFetchedAt: new Date(0),
      });
      const fetchMock = mockFetchOnce(hardcoverSeriesPayload({
        id: 5523, name: 'The Band', author: 'New Author', members: [{ position: 1, id: 1001, slug: 'kings', title: 'Kings of the Wyld' }],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const card = await svc.refreshSeriesForBook(bookId);

      expect(card!.seriesAuthor).toBe('New Author');
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.query).toContain('GetSeriesMembersById');
      expect(body.variables.id).toBe(5523);
    });

    it('resolves via the by-name resolver when no cached hardcoverSeriesId exists', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      const fetchMock = mockFetchOnce(hardcoverSeriesPayload({
        id: 5523, name: 'The Band', author: 'Nicholas Eames', members: [{ position: 2, id: 1002, slug: 'bloody', title: 'Bloody Rose' }],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const card = await svc.refreshSeriesForBook(bookId);

      expect(card!.hardcoverSeriesId).toBe(5523);
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.query).toContain('GetSeriesMembers');
      expect(body.query).not.toContain('GetSeriesMembersById');
      expect(body.variables.name).toBe('The Band');
    });

    it('returns the library-only card without a fetch when no key is configured', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith(''));
      const card = await svc.refreshSeriesForBook(bookId);

      expect(card!.id).toBeNull();
      expect(card!.hardcoverSeriesId).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // --- #1228: manual Hardcover series search + bind --------------------------

  describe('searchSeriesCandidates', () => {
    function searchPayload(hits: unknown[]): unknown {
      return { data: { search: { results: hits } } };
    }

    it('returns candidates from Hardcover and passes the query through verbatim', async () => {
      const fetchMock = mockFetchOnce(searchPayload([
        { document: { id: '4242', name: 'The Earthsea Quartet', author_name: 'Ursula K. Le Guin', books_count: 4, slug: 'earthsea-quartet' } },
      ]));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const candidates = await svc.searchSeriesCandidates('earthsea');

      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.id).toBe(4242);
      expect(candidates[0]!.name).toBe('The Earthsea Quartet');
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.variables.query).toBe('earthsea');
    });

    it('returns an empty list when Hardcover yields no results', async () => {
      mockFetchOnce(searchPayload([]));
      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      expect(await svc.searchSeriesCandidates('nothing')).toEqual([]);
    });

    it('returns an empty list without fetching when no API key is configured', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;
      const svc = new SeriesCardService(db, log, settingsServiceWith(''));
      expect(await svc.searchSeriesCandidates('earthsea')).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('bindHardcoverSeries', () => {
    it('persists the chosen id and the card subsequently refreshes by id (not name)', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'The Earthsea Cycle', seriesPosition: 1, authorName: 'Ursula K. Le Guin' });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [{ position: 1, id: 1, slug: 'wizard', title: 'A Wizard of Earthsea' }],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const card = await svc.bindHardcoverSeries(bookId, 4242);

      expect(card!.hardcoverSeriesId).toBe(4242);
      expect(card!.name).toBe('The Earthsea Quartet');
      const rows = await db.select().from(series).where(eq(series.hardcoverSeriesId, 4242));
      expect(rows).toHaveLength(1);

      // A follow-up refresh resolves by id, proving the card is id-sourced now.
      const fetchMock = mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [{ position: 1, id: 1, slug: 'wizard', title: 'A Wizard of Earthsea' }],
      }));
      await svc.refreshSeriesForBook(bookId);
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.query).toContain('GetSeriesMembersById');
      expect(body.variables.id).toBe(4242);
    });

    it('syncs books.seriesName to canonical and adopts the member position (matched by normalized title, differing positions)', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'The Tombs of Atuan', seriesName: 'Earthsea', seriesPosition: 2, authorName: 'Ursula K. Le Guin' });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        // Title matches the book, but the position differs — exercises the title fallback.
        members: [{ position: 5, id: 99, slug: 'tombs', title: 'The Tombs of Atuan' }],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      await svc.bindHardcoverSeries(bookId, 4242);

      const book = (await db.select().from(books).where(eq(books.id, bookId)))[0]!;
      expect(book.seriesName).toBe('The Earthsea Quartet');
      expect(book.seriesPosition).toBe(5);
      // The book is represented by the Hardcover member set — no duplicate local row.
      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]!.source).toBe('hardcover');
    });

    it('preserves books.seriesPosition and seeds no local member when the book is not a member', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Unrelated Book', seriesName: 'Earthsea', seriesPosition: 7, authorName: 'Ursula K. Le Guin' });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [{ position: 1, id: 1, slug: 'wizard', title: 'A Wizard of Earthsea' }],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      await svc.bindHardcoverSeries(bookId, 4242);

      const book = (await db.select().from(books).where(eq(books.id, bookId)))[0]!;
      expect(book.seriesName).toBe('The Earthsea Quartet');
      expect(book.seriesPosition).toBe(7);
      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
      expect(memberRows).toHaveLength(0);
    });

    it('sets books.seriesPosition to 0 for a position-0 member (no falsy coercion)', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Prequel', seriesName: 'Earthsea', seriesPosition: 3, authorName: 'Ursula K. Le Guin' });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [{ position: 0, id: 1, slug: 'prequel', title: 'Prequel' }],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      await svc.bindHardcoverSeries(bookId, 4242);

      const book = (await db.select().from(books).where(eq(books.id, bookId)))[0]!;
      expect(book.seriesPosition).toBe(0);
    });

    it('re-links the book to the canonical series and deletes the emptied old series row', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'The Earthsea Cycle', seriesPosition: 1, authorName: 'Ursula K. Le Guin' });
      const [oldRow] = await db.insert(series).values({
        name: 'The Earthsea Cycle', normalizedName: normalizeSeriesName('The Earthsea Cycle'),
      }).returning();
      await db.insert(seriesMembers).values({
        seriesId: oldRow!.id, bookId, title: 'A Wizard of Earthsea', normalizedTitle: 'a wizard of earthsea', position: 1, source: 'local',
      });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [{ position: 1, id: 1, slug: 'wizard', title: 'A Wizard of Earthsea' }],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      await svc.bindHardcoverSeries(bookId, 4242);

      // Old row removed (orphan cleanup) and no members point at it anymore.
      expect(await db.select().from(series).where(eq(series.id, oldRow!.id))).toHaveLength(0);
      const allMembers = await db.select().from(seriesMembers);
      expect(allMembers.every((m) => m.seriesId !== oldRow!.id)).toBe(true);
      // The book is now carried by the new Hardcover row's member set.
      const newRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 4242)))[0]!;
      const newMembers = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, newRow.id));
      expect(newMembers).toHaveLength(1);
      expect(newMembers[0]!.bookId).toBe(bookId);
    });

    it('merges onto a pre-existing row already bound to the chosen id with no unique-index collision', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'The Earthsea Cycle', seriesPosition: 1, authorName: 'Ursula K. Le Guin' });
      const [oldRow] = await db.insert(series).values({
        name: 'The Earthsea Cycle', normalizedName: normalizeSeriesName('The Earthsea Cycle'),
      }).returning();
      await db.insert(seriesMembers).values({
        seriesId: oldRow!.id, bookId, title: 'A Wizard of Earthsea', normalizedTitle: 'a wizard of earthsea', position: 1, source: 'local',
      });
      // A separate row ALREADY carries the chosen Hardcover id.
      const [targetRow] = await db.insert(series).values({
        hardcoverSeriesId: 4242, name: 'The Earthsea Quartet', normalizedName: normalizeSeriesName('The Earthsea Quartet'), authorName: 'Ursula K. Le Guin', lastFetchedAt: new Date(),
      }).returning();
      mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [{ position: 1, id: 1, slug: 'wizard', title: 'A Wizard of Earthsea' }],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      await svc.bindHardcoverSeries(bookId, 4242);

      // Exactly one row bound to the id — the pre-existing target.
      const bound = await db.select().from(series).where(eq(series.hardcoverSeriesId, 4242));
      expect(bound).toHaveLength(1);
      expect(bound[0]!.id).toBe(targetRow!.id);
      // Old row deleted.
      expect(await db.select().from(series).where(eq(series.id, oldRow!.id))).toHaveLength(0);
      // Book fields + linkage moved onto the target.
      const book = (await db.select().from(books).where(eq(books.id, bookId)))[0]!;
      expect(book.seriesName).toBe('The Earthsea Quartet');
      expect(book.seriesPosition).toBe(1);
      const targetMembers = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, targetRow!.id));
      expect(targetMembers.some((m) => m.bookId === bookId)).toBe(true);
    });

    it('rolls back ALL writes when a failure occurs mid-bind (book fields + series row)', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'The Earthsea Cycle', seriesPosition: 1, authorName: 'Ursula K. Le Guin' });
      // Two members sharing a hardcover book id violate the (series_id, hardcover_book_id)
      // unique index on the second insert — forcing a throw mid-transaction.
      mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [
          { position: 1, id: 1, slug: 'wizard', title: 'A Wizard of Earthsea' },
          { position: 2, id: 1, slug: 'dup', title: 'Duplicate Id' },
        ],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      await expect(svc.bindHardcoverSeries(bookId, 4242)).rejects.toThrow();

      // Book fields reverted.
      const book = (await db.select().from(books).where(eq(books.id, bookId)))[0]!;
      expect(book.seriesName).toBe('The Earthsea Cycle');
      expect(book.seriesPosition).toBe(1);
      // No series row persisted for the chosen id.
      expect(await db.select().from(series).where(eq(series.hardcoverSeriesId, 4242))).toHaveLength(0);
    });

    it('returns null without binding when no API key is configured', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'The Earthsea Cycle', seriesPosition: 1, authorName: 'Ursula K. Le Guin' });
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as typeof globalThis.fetch;

      const svc = new SeriesCardService(db, log, settingsServiceWith(''));
      expect(await svc.bindHardcoverSeries(bookId, 4242)).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
      const book = (await db.select().from(books).where(eq(books.id, bookId)))[0]!;
      expect(book.seriesName).toBe('The Earthsea Cycle');
    });
  });
});
