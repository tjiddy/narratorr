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
});
