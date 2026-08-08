import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePublicId } from '../utils/public-id.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, bookAuthors, authors, series, seriesMembers } from '@db/schema.js';
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

    it('orders positions [1, 2.5, 4, null] with null last regardless of payload order', async () => {
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
        ],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      expect(card!.members.map((m) => m.position)).toEqual([1, 2.5, 4, null]);
      expect(card!.members.at(-1)!.title).toBe('Companion');
    });

    /**
     * The comparator's equal-position title tie-break, seeded straight into the
     * cache. It cannot be driven from a Hardcover payload any more: since #2097
     * the adapter keeps at most one work per finite position, so two same-position
     * members only ever reach the card from rows persisted by an earlier version.
     * The comparator still has to order them, hence this test.
     */
    it('breaks an equal-position tie on title when the cache holds two rows at one position', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Anchor', seriesName: 'Test Series', seriesPosition: 1, authorName: 'Some Author' });
      const [seedRow] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        hardcoverSeriesId: 9999, name: 'Test Series', normalizedName: normalizeSeriesName('Test Series'), authorName: 'Some Author', lastFetchedAt: new Date(),
      }).returning();
      await db.insert(seriesMembers).values([
        { seriesId: seedRow!.id, hardcoverBookId: 1, slug: 'one', title: 'Book One', normalizedTitle: 'book one', authorName: 'Some Author', position: 1, source: 'hardcover' },
        { seriesId: seedRow!.id, hardcoverBookId: 6, slug: 'alpha', title: 'Alpha', normalizedTitle: 'alpha', authorName: 'Some Author', position: 1, source: 'hardcover' },
        { seriesId: seedRow!.id, hardcoverBookId: 5, slug: 'companion', title: 'Companion', normalizedTitle: 'companion', authorName: 'Some Author', position: null, source: 'hardcover' },
      ]);

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      expect(card!.members.map((m) => m.position)).toEqual([1, 1, null]);
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
      await db.insert(series).values({ publicId: generatePublicId('sr'),
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
      const [row] = await db.insert(series).values({ publicId: generatePublicId('sr'),
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
      await db.insert(series).values({ publicId: generatePublicId('sr'),
        name: 'Stale', normalizedName: 'stale', hardcoverSeriesId: 5523, authorName: 'A',
        lastFetchedAt: new Date(cutoff - 1),
      });
      // Exactly at the cutoff → NOT swept (lt is strict).
      await db.insert(series).values({ publicId: generatePublicId('sr'),
        name: 'Boundary', normalizedName: 'boundary', hardcoverSeriesId: 6000, authorName: 'B',
        lastFetchedAt: new Date(cutoff),
      });
      // Younger than the cutoff → NOT swept.
      await db.insert(series).values({ publicId: generatePublicId('sr'),
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
      const [row] = await db.insert(series).values({ publicId: generatePublicId('sr'),
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
      await db.insert(series).values({ publicId: generatePublicId('sr'),
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
      const [row] = await db.insert(series).values({ publicId: generatePublicId('sr'),
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
      const [row] = await db.insert(series).values({ publicId: generatePublicId('sr'),
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
      await db.insert(series).values({ publicId: generatePublicId('sr'),
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
    /**
     * The shared `matchedLibraryIds` claim set, driven from a payload shape the
     * adapter still emits. Two members at ONE position can no longer reach the
     * service (#2097 collapses them in `mapSeries`), but two UNPOSITIONED members
     * whose titles both pair with the same library book can — and #2097 made that
     * shape MORE common, because unpositioned works no longer collapse either.
     */
    it('two Hardcover members whose titles both pair never both claim one library book', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 5523,
        name: 'The Band',
        author: 'Nicholas Eames',
        members: [
          { position: 1, id: 1001, slug: 'kings', title: 'Kings of the Wyld' },
          // Both carry 'Bloody Rose' as their prefix(1) variant, so both pair with
          // the library book on the title tier — only one may claim it.
          { position: null, id: 1002, slug: 'bloody-a', title: 'Bloody Rose: Part One' },
          { position: null, id: 1003, slug: 'bloody-b', title: 'Bloody Rose: Part Two' },
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

    /**
     * #2144 NARROWS the #1139 no-inflation rule rather than deleting it. Adding an
     * owned book Hardcover does not list is now REQUIRED — that is the whole
     * issue. Adding anything else is still forbidden: the card's only two sources
     * are the canonical member list and the library pool, so a title that appears
     * in neither can never reach it.
     */
    it('adds owned books missing from the canonical list but nothing beyond the two sources', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Local Only', seriesName: 'The Band', seriesPosition: 9, authorName: 'Nicholas Eames' });
      const canonical: MemberInput[] = [
        { position: 1, id: 1001, slug: 'kings', title: 'Kings of the Wyld' },
        { position: 2, id: 1002, slug: 'bloody', title: 'Bloody Rose' },
        { position: 3, id: 1003, slug: 'heretic', title: 'Heretic' },
      ];
      mockFetchOnce(hardcoverSeriesPayload({ id: 5523, name: 'The Band', author: 'Nicholas Eames', members: canonical }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('TEST_KEY'));
      const card = await svc.getSeriesForBook(bookId);

      // Canonical count + the one owned book, interleaved by position — not
      // appended as an "extras" block that happens to land last.
      expect(card!.members).toHaveLength(canonical.length + 1);
      expect(card!.members.map((m) => m.title)).toEqual(['Kings of the Wyld', 'Bloody Rose', 'Heretic', 'Local Only']);
      const owned = card!.members.find((m) => m.title === 'Local Only')!;
      expect(owned).toMatchObject({ position: 9, inLibrary: true, libraryBookId: bookId, hardcoverBookId: null });
      // Nothing that is neither a canonical member nor a library book appears.
      const allowed = new Set([...canonical.map((m) => m.title), 'Local Only']);
      expect(card!.members.every((m) => allowed.has(m.title))).toBe(true);
    });
  });

  // --- refreshSeriesForBook primary + fallback branches (AC2) ------------------

  describe('refreshSeriesForBook', () => {
    it('re-fetches via GetSeriesMembersById when a cached hardcoverSeriesId exists', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Bloody Rose', seriesName: 'The Band', seriesPosition: 2, authorName: 'Nicholas Eames' });
      await db.insert(series).values({ publicId: generatePublicId('sr'),
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

    it('caps the picker display to ≤10 candidates in readers_count-desc order (#1239)', async () => {
      // Adapter returns the full ranked pool; the picker enforces the ≤10 cap.
      // Hits arrive low-to-high readers_count so the cap must keep the top 10.
      const hits = Array.from({ length: 15 }, (_, i) => ({
        document: { id: String(i + 1), name: `Series ${i + 1}`, author_name: 'A', books_count: 2, readers_count: i, slug: `s${i + 1}` },
      }));
      mockFetchOnce(searchPayload(hits));
      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const candidates = await svc.searchSeriesCandidates('many');

      expect(candidates).toHaveLength(10);
      // Highest readers_count first; the cap drops the 5 lowest-readership hits.
      expect(candidates[0]!.readersCount).toBe(14);
      expect(candidates.map((c) => c.readersCount)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
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
      const bound = await svc.bindHardcoverSeries(bookId, 4242);

      expect(bound!.card.hardcoverSeriesId).toBe(4242);
      expect(bound!.card.name).toBe('The Earthsea Quartet');
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

    it('preserves books.seriesPosition and seeds exactly one local member when the book is not a member', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Unrelated Book', seriesName: 'Earthsea', seriesPosition: 7, authorName: 'Ursula K. Le Guin' });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [{ position: 1, id: 1, slug: 'wizard', title: 'A Wizard of Earthsea' }],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      const bound = await svc.bindHardcoverSeries(bookId, 4242);

      const book = (await db.select().from(books).where(eq(books.id, bookId)))[0]!;
      expect(book.seriesName).toBe('The Earthsea Quartet');
      expect(book.seriesPosition).toBe(7);
      // #2144: the bind adopted the canonical name for a book that matched no
      // member, so it is now an owned book of that series with nothing to pair
      // with — exactly the shape that must get a local row.
      const memberRows = await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, bookId));
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]!.source).toBe('local');
      const owned = bound!.card.members.find((m) => m.title === 'Unrelated Book')!;
      expect(owned).toMatchObject({ position: 7, inLibrary: true, libraryBookId: bookId, hardcoverBookId: null });
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

    it('syncs ALL matched library books in the bound series, not just the initiating book', async () => {
      // Two siblings both on the pre-bind (Audnexus) name. Binding from one must
      // sync the other too — otherwise the sibling keeps the stale name and the
      // series splits in the Library view (#1228 AC correction: series-wide sync).
      const bookA = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'The Earthsea Cycle', seriesPosition: 1, authorName: 'Ursula K. Le Guin' });
      const bookB = await seedBookWithSeries(db, { title: 'The Tombs of Atuan', seriesName: 'The Earthsea Cycle', seriesPosition: 2, authorName: 'Ursula K. Le Guin' });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [
          { position: 1, id: 1, slug: 'wizard', title: 'A Wizard of Earthsea' },
          { position: 5, id: 2, slug: 'tombs', title: 'The Tombs of Atuan' },
        ],
      }));

      const svc = new SeriesCardService(db, log, settingsServiceWith('K'));
      await svc.bindHardcoverSeries(bookA, 4242); // bind initiated from book A only

      const a = (await db.select().from(books).where(eq(books.id, bookA)))[0]!;
      const b = (await db.select().from(books).where(eq(books.id, bookB)))[0]!;
      // Initiating book synced.
      expect(a.seriesName).toBe('The Earthsea Quartet');
      expect(a.seriesPosition).toBe(1);
      // SIBLING synced to the canonical name AND its own matched member position.
      expect(b.seriesName).toBe('The Earthsea Quartet');
      expect(b.seriesPosition).toBe(5);
      // Both carried by the new Hardcover row's member set, exactly once each.
      const newRow = (await db.select().from(series).where(eq(series.hardcoverSeriesId, 4242)))[0]!;
      const members = await db.select().from(seriesMembers).where(eq(seriesMembers.seriesId, newRow.id));
      expect(members.filter((m) => m.bookId === bookA)).toHaveLength(1);
      expect(members.filter((m) => m.bookId === bookB)).toHaveLength(1);
    });

    it('re-links the book to the canonical series and deletes the emptied old series row', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'The Earthsea Cycle', seriesPosition: 1, authorName: 'Ursula K. Le Guin' });
      const [oldRow] = await db.insert(series).values({ publicId: generatePublicId('sr'),
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
      const [oldRow] = await db.insert(series).values({ publicId: generatePublicId('sr'),
        name: 'The Earthsea Cycle', normalizedName: normalizeSeriesName('The Earthsea Cycle'),
      }).returning();
      await db.insert(seriesMembers).values({
        seriesId: oldRow!.id, bookId, title: 'A Wizard of Earthsea', normalizedTitle: 'a wizard of earthsea', position: 1, source: 'local',
      });
      // A separate row ALREADY carries the chosen Hardcover id.
      const [targetRow] = await db.insert(series).values({ publicId: generatePublicId('sr'),
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

  // ─── #2098: the ids the transaction actually rewrote cross the boundary ───
  //
  // The route's post-commit pass refreshes each rewritten book's `metadata.opf` and
  // embedded tags, so it needs to know WHICH books the transaction touched — and it
  // must learn that from the transaction's own resolved value, never from an outer
  // accumulator that would survive a rollback.
  describe('bindHardcoverSeries — the synced id list (#2098)', () => {
    it('returns the card alongside the ids it rewrote', async () => {
      const bookA = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'The Earthsea Cycle', seriesPosition: 1, authorName: 'Ursula K. Le Guin' });
      const bookB = await seedBookWithSeries(db, { title: 'The Tombs of Atuan', seriesName: 'The Earthsea Cycle', seriesPosition: 2, authorName: 'Ursula K. Le Guin' });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [
          { position: 1, id: 1, slug: 'wizard', title: 'A Wizard of Earthsea' },
          { position: 5, id: 2, slug: 'tombs', title: 'The Tombs of Atuan' },
        ],
      }));

      const bound = await new SeriesCardService(db, log, settingsServiceWith('K')).bindHardcoverSeries(bookA, 4242);

      expect(bound!.card.name).toBe('The Earthsea Quartet');
      // Both siblings were rewritten, in matched-member order.
      expect(bound!.syncedIds).toEqual([bookA, bookB]);
      // The ids are exactly the rows whose series_name moved to the canonical name.
      const rewritten = (await db.select().from(books)).filter((b) => b.seriesName === 'The Earthsea Quartet').map((b) => b.id);
      expect([...bound!.syncedIds].sort()).toEqual([...rewritten].sort());
    });

    it('an unmatched initiating book still appears in syncedIds', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Unrelated Book', seriesName: 'Earthsea', seriesPosition: 7, authorName: 'Ursula K. Le Guin' });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [{ position: 1, id: 1, slug: 'wizard', title: 'A Wizard of Earthsea' }],
      }));

      const bound = await new SeriesCardService(db, log, settingsServiceWith('K')).bindHardcoverSeries(bookId, 4242);

      // It matched no member, but the bind still adopted the canonical name for it — so its
      // sidecar is stale too and the pass owes it a refresh.
      expect(bound!.syncedIds).toEqual([bookId]);
      expect(bound!.card).not.toBeNull();
    });

    it('syncedIds carries no duplicate when the initiating book is itself a matched member', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'The Earthsea Cycle', seriesPosition: 1, authorName: 'Ursula K. Le Guin' });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [{ position: 1, id: 1, slug: 'wizard', title: 'A Wizard of Earthsea' }],
      }));

      const bound = await new SeriesCardService(db, log, settingsServiceWith('K')).bindHardcoverSeries(bookId, 4242);

      expect(bound!.syncedIds).toEqual([bookId]);
      expect(new Set(bound!.syncedIds).size).toBe(bound!.syncedIds.length);
    });

    it('a rolled-back bind returns no synced ids', async () => {
      const seed = async () => seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'The Earthsea Cycle', seriesPosition: 1, authorName: 'Ursula K. Le Guin' });
      const payload = () => hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [{ position: 1, id: 1, slug: 'wizard', title: 'A Wizard of Earthsea' }],
      });
      const link = await import('./book-series-link.js');

      // Positive control FIRST, so the negative below is not vacuous: this fixture DOES report
      // an id when the transaction commits.
      const okId = await seed();
      mockFetchOnce(payload());
      const ok = await new SeriesCardService(db, log, settingsServiceWith('K')).bindHardcoverSeries(okId, 4242);
      expect(ok!.syncedIds).toEqual([okId]);

      // Now fail the transaction at `relinkBookToBoundSeries` — AFTER the id-collecting
      // `UPDATE books` has been issued, which is the only point at which a returned-from-tx list
      // is distinguishable from an outer accumulator.
      const rollbackId = await seed();
      mockFetchOnce(payload());
      vi.spyOn(link, 'relinkBookToBoundSeries').mockRejectedValueOnce(new Error('relink boom'));

      const call = new SeriesCardService(db, log, settingsServiceWith('K')).bindHardcoverSeries(rollbackId, 4242);
      await expect(call).rejects.toThrow('relink boom');
      // Nothing observable reports a synced id: the call produced no value at all, and the
      // book's series fields are back where they were.
      const row = (await db.select().from(books).where(eq(books.id, rollbackId)))[0]!;
      expect(row.seriesName).toBe('The Earthsea Cycle');
    });

    it('the three null exits still resolve null, not a result object', async () => {
      const svc = (key: string) => new SeriesCardService(db, log, settingsServiceWith(key));

      // 1. Book missing.
      expect(await svc('K').bindHardcoverSeries(999_999, 4242)).toBeNull();

      // 2. No Hardcover key configured.
      const noKeyId = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'Earthsea', authorName: 'Ursula K. Le Guin' });
      globalThis.fetch = vi.fn() as typeof globalThis.fetch;
      expect(await svc('').bindHardcoverSeries(noKeyId, 4242)).toBeNull();

      // 3. `fetchById` returned nothing.
      mockFetchOnce({ data: { series: [] } });
      expect(await svc('K').bindHardcoverSeries(noKeyId, 4242)).toBeNull();
    });
  });
  // ─── #2069 AC24: binding is an operator re-assertion of the SERIES ───
  //
  // It removes the initiating book's `seriesName` tombstone in the SAME transaction
  // as the scalar write (otherwise a stored series would coexist with a live
  // tombstone), and only that entry — binding asserts nothing about the other
  // clearable fields.
  describe('bindHardcoverSeries — user-cleared fields (#2069 AC24)', () => {
    /** Set the tombstone column out of band, the way a prior PUT would have. */
    async function setTombstones(bookId: number, raw: string | null): Promise<void> {
      await db.update(books).set({ userClearedFields: raw }).where(eq(books.id, bookId));
    }

    async function readBook(bookId: number) {
      return (await db.select().from(books).where(eq(books.id, bookId)))[0]!;
    }

    const earthseaPayload = (title: string) => hardcoverSeriesPayload({
      id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
      members: [{ position: 1, id: 1, slug: 'wizard', title }],
    });

    it('removes the seriesName entry and leaves every other tombstone in place', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: null, authorName: 'Ursula K. Le Guin' });
      await setTombstones(bookId, '["genres","seriesName"]');
      mockFetchOnce(earthseaPayload('A Wizard of Earthsea'));

      await new SeriesCardService(db, log, settingsServiceWith('K')).bindHardcoverSeries(bookId, 4242);

      // Both asserted from ONE read, so a write that lands the series without the
      // removal (or vice versa) cannot pass.
      const book = await readBook(bookId);
      expect(book.seriesName).toBe('The Earthsea Quartet');
      expect(book.userClearedFields).toBe('["genres"]');
    });

    it('persists the empty set as SQL NULL when seriesName was the only tombstone', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: null, authorName: 'Ursula K. Le Guin' });
      await setTombstones(bookId, '["seriesName"]');
      mockFetchOnce(earthseaPayload('A Wizard of Earthsea'));

      await new SeriesCardService(db, log, settingsServiceWith('K')).bindHardcoverSeries(bookId, 4242);

      expect((await readBook(bookId)).userClearedFields).toBeNull();
    });

    it('F13: re-reads the set INSIDE the transaction, so a clear committed during the fetch survives', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: null, authorName: 'Ursula K. Le Guin' });
      await setTombstones(bookId, '["seriesName","subtitle"]');

      // An unrelated `genres` clear commits while the Hardcover fetch is in flight.
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        await setTombstones(bookId, '["genres","seriesName","subtitle"]');
        return new Response(JSON.stringify(earthseaPayload('A Wizard of Earthsea')), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof globalThis.fetch;

      await new SeriesCardService(db, log, settingsServiceWith('K')).bindHardcoverSeries(bookId, 4242);

      // An implementation that drops `seriesName` from the PRE-fetch snapshot and
      // writes that back yields '["subtitle"]', silently erasing the concurrent clear.
      expect((await readBook(bookId)).userClearedFields).toBe('["genres","subtitle"]');
    });

    it('a seriesName-tombstoned sibling is structurally absent from the sibling pool and keeps its tombstone', async () => {
      // The pool comes from `WHERE series_name IN (…)`, and a tombstoned book has
      // `series_name = NULL` — SQL `IN` never matches NULL. Pinned here rather than
      // defended by a guard branch.
      const bookA = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: 'Earthsea', authorName: 'Ursula K. Le Guin' });
      const sibling = await seedBookWithSeries(db, { title: 'The Tombs of Atuan', seriesName: null, authorName: 'Ursula K. Le Guin' });
      await setTombstones(sibling, '["seriesName"]');
      mockFetchOnce(hardcoverSeriesPayload({
        id: 4242, name: 'The Earthsea Quartet', author: 'Ursula K. Le Guin',
        members: [
          { position: 1, id: 1, slug: 'wizard', title: 'A Wizard of Earthsea' },
          { position: 2, id: 2, slug: 'tombs', title: 'The Tombs of Atuan' },
        ],
      }));

      await new SeriesCardService(db, log, settingsServiceWith('K')).bindHardcoverSeries(bookA, 4242);

      const siblingRow = await readBook(sibling);
      expect(siblingRow.seriesName).toBeNull();
      expect(siblingRow.userClearedFields).toBe('["seriesName"]');
    });

    it('rolls the tombstone removal back with the scalar write when a later step in the transaction fails', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'A Wizard of Earthsea', seriesName: null, authorName: 'Ursula K. Le Guin' });
      await setTombstones(bookId, '["seriesName"]');
      mockFetchOnce(earthseaPayload('A Wizard of Earthsea'));

      const link = await import('./book-series-link.js');
      vi.spyOn(link, 'relinkBookToBoundSeries').mockRejectedValueOnce(new Error('relink boom'));

      await expect(
        new SeriesCardService(db, log, settingsServiceWith('K')).bindHardcoverSeries(bookId, 4242),
      ).rejects.toThrow('relink boom');

      const book = await readBook(bookId);
      expect(book.seriesName).toBeNull();
      expect(book.userClearedFields).toBe('["seriesName"]');
    });
  });

  // ─── #2152 AC9 / AC9a: a bind never undoes a position clear ───
  describe('bindHardcoverSeries — seriesPosition tombstones (#2152 AC9/AC9a)', () => {
    async function setTombstones(bookId: number, raw: string | null): Promise<void> {
      await db.update(books).set({ userClearedFields: raw }).where(eq(books.id, bookId));
    }

    async function readBook(bookId: number) {
      return (await db.select().from(books).where(eq(books.id, bookId)))[0]!;
    }

    /** Two-member Dune payload; member 7 is the one an operator unnumbered. */
    const dunePayload = () => hardcoverSeriesPayload({
      id: 4242, name: 'Dune', author: 'Frank Herbert',
      members: [
        { position: 1, id: 1, slug: 'dune', title: 'Dune' },
        { position: 7, id: 7, slug: 'hunters', title: 'Hunters of Dune' },
      ],
    });

    function svc() {
      return new SeriesCardService(db, log, settingsServiceWith('K'));
    }

    it('a matched SIBLING cleared in-app adopts the name and keeps its NULL position, while an untombstoned sibling gets its own', async () => {
      const initiating = await seedBookWithSeries(db, { title: 'Dune', seriesName: 'Dune (Audible)', authorName: 'Frank Herbert' });
      const cleared = await seedBookWithSeries(db, { title: 'Hunters of Dune', seriesName: 'Dune (Audible)', seriesPosition: null, authorName: 'Frank Herbert' });
      await setTombstones(cleared, '["seriesPosition"]');
      mockFetchOnce(dunePayload());

      await svc().bindHardcoverSeries(initiating, 4242);

      const clearedRow = await readBook(cleared);
      expect(clearedRow.seriesName).toBe('Dune');
      expect(clearedRow.seriesPosition).toBeNull();
      expect(clearedRow.userClearedFields).toBe('["seriesPosition"]');
      // The control that makes the assertion above non-vacuous.
      const initiatingRow = await readBook(initiating);
      expect(initiatingRow.seriesName).toBe('Dune');
      expect(initiatingRow.seriesPosition).toBe(1);
    });

    it('the INITIATING book cleared in-app keeps its NULL position; its seriesName tombstone lifts and its seriesPosition tombstone survives', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Hunters of Dune', seriesName: null, seriesPosition: null, authorName: 'Frank Herbert' });
      await setTombstones(bookId, '["seriesName","seriesPosition"]');
      mockFetchOnce(dunePayload());

      await svc().bindHardcoverSeries(bookId, 4242);

      const row = await readBook(bookId);
      expect(row.seriesName).toBe('Dune');
      expect(row.seriesPosition).toBeNull();
      expect(row.userClearedFields).toBe('["seriesPosition"]');
    });

    it('an unmatched initiating book cleared in-app still adopts the canonical name with no position write', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Some Unrelated Companion', seriesName: 'Dune (Audible)', seriesPosition: null, authorName: 'Frank Herbert' });
      await setTombstones(bookId, '["seriesPosition"]');
      mockFetchOnce(dunePayload());

      await svc().bindHardcoverSeries(bookId, 4242);

      const row = await readBook(bookId);
      expect(row.seriesName).toBe('Dune');
      expect(row.seriesPosition).toBeNull();
    });

    /**
     * AC9's "UNCHANGED, not normalized" — the out-of-band decoupled state
     * (`series_position = 7` beside a live tombstone), seeded directly because
     * AC6a shows no in-app path can produce it. Three assertions, one per
     * consumer, because they deliberately disagree.
     */
    it('decoupled state: bind leaves the stale column alone, the card still renders —, and the fast path still claims it', async () => {
      const initiating = await seedBookWithSeries(db, { title: 'Dune', seriesName: 'Dune (Audible)', seriesPosition: 1, authorName: 'Frank Herbert' });
      const decoupled = await seedBookWithSeries(db, { title: 'Hunters of Dune', seriesName: 'Dune (Audible)', seriesPosition: 7, authorName: 'Frank Herbert' });
      await setTombstones(decoupled, '["seriesPosition"]');
      mockFetchOnce(dunePayload());

      const bound = await svc().bindHardcoverSeries(initiating, 4242);

      // 1. The column: neither overwritten with the member position nor normalized.
      expect((await readBook(decoupled)).seriesPosition).toBe(7);
      // 2. The card: this fixture is on the MATCHED-Hardcover projection path,
      //    which is tombstone-keyed, so the member renders `—`.
      const member = bound!.card.members.find((m) => m.title === 'Hunters of Dune')!;
      expect(member.position).toBeNull();
      expect(member.libraryBookId).toBe(decoupled);
      // 3. The matcher: untouched, so the position fast path still claims the book
      //    and no separate owned entry is emitted for it.
      expect(bound!.card.members.filter((m) => m.libraryBookId === decoupled)).toHaveLength(1);
    });

    it('F2: the card the bind RETURNS, and a later getSeriesForBook, both expose the owned member at position null', async () => {
      const initiating = await seedBookWithSeries(db, { title: 'Dune', seriesName: 'Dune (Audible)', seriesPosition: 1, authorName: 'Frank Herbert' });
      const cleared = await seedBookWithSeries(db, { title: 'Hunters of Dune', seriesName: 'Dune (Audible)', seriesPosition: null, authorName: 'Frank Herbert' });
      await setTombstones(cleared, '["seriesPosition"]');
      mockFetchOnce(dunePayload());

      const bound = await svc().bindHardcoverSeries(initiating, 4242);

      // The cached Hardcover member row still stores position 7 — the residue AC9a
      // deliberately does not rewrite. The projection is what must read `—`.
      const cachedRow = (await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, cleared)))[0]!;
      expect(cachedRow.position).toBe(7);

      const inBound = bound!.card.members.find((m) => m.libraryBookId === cleared)!;
      expect(inBound.position).toBeNull();
      // Control in the same assertion: the untombstoned sibling keeps its number.
      expect(bound!.card.members.find((m) => m.libraryBookId === initiating)!.position).toBe(1);

      const later = await svc().getSeriesForBook(cleared);
      expect(later!.members.find((m) => m.libraryBookId === cleared)!.position).toBeNull();
      expect(later!.members.find((m) => m.libraryBookId === initiating)!.position).toBe(1);
    });

    it('the reconcile/seed path returns the same projection', async () => {
      // A book the Hardcover member set does NOT cover reaches the card through
      // `reconcileUnclaimedMembers`. Its entry is column-keyed and rule **b**
      // leaves the column NULL for an in-app clear, so it renders `—` too.
      const initiating = await seedBookWithSeries(db, { title: 'Dune', seriesName: 'Dune (Audible)', seriesPosition: 1, authorName: 'Frank Herbert' });
      const unclaimed = await seedBookWithSeries(db, { title: 'Paul of Dune', seriesName: 'Dune', seriesPosition: null, authorName: 'Frank Herbert' });
      await setTombstones(unclaimed, '["seriesPosition"]');
      mockFetchOnce(dunePayload());

      await svc().bindHardcoverSeries(initiating, 4242);
      const card = await svc().getSeriesForBook(unclaimed);

      const seeded = (await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, unclaimed)))[0]!;
      expect(seeded.source).toBe('local');
      expect(card!.members.find((m) => m.libraryBookId === unclaimed)!.position).toBeNull();
    });

    it('F5: reads the whole synced batch in ONE query on the transaction handle, not one per book', async () => {
      const initiating = await seedBookWithSeries(db, { title: 'Dune', seriesName: 'Dune (Audible)', seriesPosition: 1, authorName: 'Frank Herbert' });
      const sibling = await seedBookWithSeries(db, { title: 'Hunters of Dune', seriesName: 'Dune (Audible)', seriesPosition: null, authorName: 'Frank Herbert' });
      await setTombstones(sibling, '["seriesPosition"]');
      mockFetchOnce(dunePayload());

      const link = await import('./book-series-link.js');
      const spy = vi.spyOn(link, 'readPositionClearedBookIds');

      await svc().bindHardcoverSeries(initiating, 4242);

      // ONE call covering every synced id — the batched read. A per-book
      // implementation would show up as one call per synced book.
      expect(spy).toHaveBeenCalledTimes(1);
      expect([...new Set(spy.mock.calls[0]![2])].sort((a, b) => a - b)).toEqual([initiating, sibling].sort((a, b) => a - b));
    });

    it('reads the tombstones INSIDE the transaction, so a position clear committed during the fetch is honored', async () => {
      const bookId = await seedBookWithSeries(db, { title: 'Hunters of Dune', seriesName: 'Dune (Audible)', seriesPosition: null, authorName: 'Frank Herbert' });

      // The operator clears the position while the Hardcover fetch is in flight.
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        await setTombstones(bookId, '["seriesPosition"]');
        return new Response(JSON.stringify(dunePayload()), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof globalThis.fetch;

      await svc().bindHardcoverSeries(bookId, 4242);

      // An implementation reading the set from the pre-fetch `loadBook` snapshot
      // would see no tombstone and write the member position 7 over the clear.
      const row = await readBook(bookId);
      expect(row.seriesName).toBe('Dune');
      expect(row.seriesPosition).toBeNull();
    });
  });

  /**
   * #2175 — the bind path shares the pool loader, so keying it on the normalized
   * series name widens what a bind WRITES: normalized-equal siblings are now
   * matched, their `books.series_name` / `series_position` rewritten, and their
   * ids returned in `syncedIds` — which the route iterates to rewrite each book's
   * `metadata.opf` and embedded tags ([[caller-owned-tx-drops-post-commit-effects]]).
   * That is the desired canonicalization, but it is a durable, on-disk-visible
   * widening of an existing write, so it gets its own cases rather than riding
   * along untested.
   */
  describe('bindHardcoverSeries — the widened normalized pool (#2175)', () => {
    async function readBookRow(bookId: number) {
      return (await db.select().from(books).where(eq(books.id, bookId)))[0]!;
    }

    function svc() {
      return new SeriesCardService(db, log, settingsServiceWith('K'));
    }

    const dunePayload = () => hardcoverSeriesPayload({
      id: 4242, name: 'Dune', author: 'Frank Herbert',
      members: [
        { position: 1, id: 1, slug: 'dune', title: 'Dune' },
        { position: 2, id: 2, slug: 'messiah', title: 'Dune Messiah' },
      ],
    });

    it('AC8: a case-drifted sibling is matched, rewritten, and reported in syncedIds', async () => {
      const initiating = await seedBookWithSeries(db, { title: 'Dune', seriesName: 'Dune (Audible)', seriesPosition: 1, authorName: 'Frank Herbert' });
      const drifted = await seedBookWithSeries(db, { title: 'Dune Messiah', seriesName: 'dune  (audible)', seriesPosition: 9, authorName: 'Frank Herbert' });
      mockFetchOnce(dunePayload());

      const bound = await svc().bindHardcoverSeries(initiating, 4242);

      expect(bound!.syncedIds).toEqual([initiating, drifted]);
      const row = await readBookRow(drifted);
      expect(row.seriesName).toBe('Dune');
      expect(row.seriesPosition).toBe(2);
      expect(bound!.card.members.map((m) => m.libraryBookId)).toEqual([initiating, drifted]);
    });

    it('AC8: an unrelated series is neither matched nor rewritten', async () => {
      const initiating = await seedBookWithSeries(db, { title: 'Dune', seriesName: 'Dune (Audible)', seriesPosition: 1, authorName: 'Frank Herbert' });
      const unrelated = await seedBookWithSeries(db, { title: 'Dune Messiah', seriesName: 'Dune Chronicles', seriesPosition: 2, authorName: 'Frank Herbert' });
      mockFetchOnce(dunePayload());

      const bound = await svc().bindHardcoverSeries(initiating, 4242);

      expect(bound!.syncedIds).toEqual([initiating]);
      expect((await readBookRow(unrelated)).seriesName).toBe('Dune Chronicles');
    });

    /**
     * AC9 — the canonical name and the pre-bind name are BOTH targets, and the
     * dedupe collapses on the normalized form. A pair differing only by case is
     * one equivalence class, not two entries.
     */
    it('AC9: a canonical/prior pair differing only by case is one target class', async () => {
      const initiating = await seedBookWithSeries(db, { title: 'Dune', seriesName: 'dune', seriesPosition: 1, authorName: 'Frank Herbert' });
      const sibling = await seedBookWithSeries(db, { title: 'Dune Messiah', seriesName: 'DUNE', seriesPosition: 2, authorName: 'Frank Herbert' });
      mockFetchOnce(dunePayload());

      const bound = await svc().bindHardcoverSeries(initiating, 4242);

      expect(bound!.syncedIds).toEqual([initiating, sibling]);
      expect((await readBookRow(sibling)).seriesName).toBe('Dune');
    });

    /**
     * AC5 + AC9 — a bind whose canonical name normalizes non-empty and whose
     * PRIOR name normalizes empty. The pool is the union of the two rules with
     * neither leaking into the other's bucket.
     */
    it('AC5: mixed target kinds — a non-Latin prior name matches only itself, the canonical name its whole class', async () => {
      const initiating = await seedBookWithSeries(db, { title: 'Dune', seriesName: '三体', seriesPosition: 1, authorName: 'Frank Herbert' });
      const priorSpelling = await seedBookWithSeries(db, { title: 'Dune Messiah', seriesName: '三体', seriesPosition: 2, authorName: 'Frank Herbert' });
      const otherNonLatin = await seedBookWithSeries(db, { title: 'Дозор', seriesName: 'Дозоры', seriesPosition: 1, authorName: 'Sergei Lukyanenko' });
      const canonicalClass = await seedBookWithSeries(db, { title: 'Children of Dune', seriesName: 'dune', seriesPosition: 3, authorName: 'Frank Herbert' });
      mockFetchOnce(dunePayload());

      const bound = await svc().bindHardcoverSeries(initiating, 4242);

      // Matched: the byte-identical prior-name sibling. Not matched: the other
      // empty-normalizing series.
      expect(bound!.syncedIds).toEqual([initiating, priorSpelling]);
      expect((await readBookRow(otherNonLatin)).seriesName).toBe('Дозоры');
      expect(await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, otherNonLatin))).toHaveLength(0);
      // The canonical name's own class is in the pool: it matched no member here,
      // but it is enrolled as an owned local row rather than ignored.
      expect((await db.select().from(seriesMembers).where(eq(seriesMembers.bookId, canonicalClass)))[0]!.source).toBe('local');
    });

    it('AC5: the reverse mix — an empty-normalizing CANONICAL name with a Latin prior name', async () => {
      const initiating = await seedBookWithSeries(db, { title: '三体', seriesName: 'Remembrance', seriesPosition: 1, authorName: 'Liu Cixin' });
      const priorClass = await seedBookWithSeries(db, { title: '黑暗森林', seriesName: 'remembrance', seriesPosition: 2, authorName: 'Liu Cixin' });
      const otherNonLatin = await seedBookWithSeries(db, { title: 'Дозор', seriesName: 'Дозоры', seriesPosition: 1, authorName: 'Sergei Lukyanenko' });
      mockFetchOnce(hardcoverSeriesPayload({
        id: 9001, name: '三体', author: 'Liu Cixin',
        members: [
          { position: 1, id: 1, slug: 'santi', title: '三体' },
          { position: 2, id: 2, slug: 'dark-forest', title: '黑暗森林' },
        ],
      }));

      const bound = await svc().bindHardcoverSeries(initiating, 9001);

      expect(bound!.syncedIds).toEqual([initiating, priorClass]);
      expect((await readBookRow(priorClass)).seriesName).toBe('三体');
      expect((await readBookRow(otherNonLatin)).seriesName).toBe('Дозоры');
    });

    it('a seriesPosition tombstone on a DRIFTED sibling still suppresses the position write', async () => {
      const initiating = await seedBookWithSeries(db, { title: 'Dune', seriesName: 'Dune (Audible)', seriesPosition: 1, authorName: 'Frank Herbert' });
      const drifted = await seedBookWithSeries(db, { title: 'Dune Messiah', seriesName: 'dune (audible)', seriesPosition: null, authorName: 'Frank Herbert' });
      await db.update(books).set({ userClearedFields: '["seriesPosition"]' }).where(eq(books.id, drifted));
      mockFetchOnce(dunePayload());

      const bound = await svc().bindHardcoverSeries(initiating, 4242);

      expect(bound!.syncedIds).toContain(drifted);
      const row = await readBookRow(drifted);
      expect(row.seriesName).toBe('Dune');
      expect(row.seriesPosition).toBeNull();
      // The control that makes the assertion above non-vacuous.
      expect((await readBookRow(initiating)).seriesPosition).toBe(1);
    });

    it('a seriesName-tombstoned book is absent from the widened pool under every spelling', async () => {
      const initiating = await seedBookWithSeries(db, { title: 'Dune', seriesName: 'Dune (Audible)', seriesPosition: 1, authorName: 'Frank Herbert' });
      const tombstoned = await seedBookWithSeries(db, { title: 'Dune Messiah', seriesName: null, seriesPosition: null, authorName: 'Frank Herbert' });
      await db.update(books).set({ userClearedFields: '["seriesName"]' }).where(eq(books.id, tombstoned));
      mockFetchOnce(dunePayload());

      const bound = await svc().bindHardcoverSeries(initiating, 4242);

      expect(bound!.syncedIds).toEqual([initiating]);
      const row = await readBookRow(tombstoned);
      expect(row.seriesName).toBeNull();
      expect(row.userClearedFields).toBe('["seriesName"]');
    });

    /**
     * The widened pool is read on the `tx` handle, so it participates in the same
     * transaction: a rollback yields no `syncedIds` at all and no drifted sibling
     * keeps a half-applied canonical name.
     */
    it('a rolled-back bind rewrites no drifted sibling and reports no ids', async () => {
      const link = await import('./book-series-link.js');

      // Positive control FIRST — this fixture DOES widen when it commits.
      const okInitiating = await seedBookWithSeries(db, { title: 'Dune', seriesName: 'Dune (Audible)', seriesPosition: 1, authorName: 'Frank Herbert' });
      const okDrifted = await seedBookWithSeries(db, { title: 'Dune Messiah', seriesName: 'dune (audible)', seriesPosition: 9, authorName: 'Frank Herbert' });
      mockFetchOnce(dunePayload());
      expect((await svc().bindHardcoverSeries(okInitiating, 4242))!.syncedIds).toEqual([okInitiating, okDrifted]);

      const initiating = await seedBookWithSeries(db, { title: 'Dune', seriesName: 'Chronicles (Audible)', seriesPosition: 1, authorName: 'Frank Herbert' });
      const drifted = await seedBookWithSeries(db, { title: 'Dune Messiah', seriesName: 'chronicles (audible)', seriesPosition: 9, authorName: 'Frank Herbert' });
      mockFetchOnce(dunePayload());
      vi.spyOn(link, 'relinkBookToBoundSeries').mockRejectedValueOnce(new Error('relink boom'));

      await expect(svc().bindHardcoverSeries(initiating, 4242)).rejects.toThrow('relink boom');

      expect((await readBookRow(drifted)).seriesName).toBe('chronicles (audible)');
      expect((await readBookRow(drifted)).seriesPosition).toBe(9);
      expect((await readBookRow(initiating)).seriesName).toBe('Chronicles (Audible)');
    });
  });
});
