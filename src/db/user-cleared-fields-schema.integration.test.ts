import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from './index.js';
import { books, series, seriesMembers } from './schema.js';
import { generatePublicId } from '../server/utils/public-id.js';
import { BookService } from '../server/services/book.service.js';
import { runEnrichment } from '../server/jobs/enrichment.js';
import type { MetadataService } from '../server/services/metadata.service.js';

// Real-DB coverage for `books.user_cleared_fields` (#2069). These cases CANNOT be
// pure unit tests: a parser unit test feeds the parser a string directly and so
// never crosses the driver-decode boundary AC1 exists to avoid. Everything below
// inserts the raw column value with raw SQL into a migrated database and then
// exercises the real read/write paths.
//
// The suite also proves the column survives migrate-from-scratch: `runMigrations`
// builds the schema from an empty file, and every assertion goes through Drizzle
// rather than raw DDL strings.

function createLog(): FastifyBaseLogger {
  return {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'debug', silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

describe('books.user_cleared_fields — persisted shape (DB-backed, #2069)', () => {
  let dir: string;
  let db: Db;
  let log: FastifyBaseLogger;
  let bookService: BookService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cleared-fields-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createLog();
    bookService = new BookService(db, log);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  async function seedBook(overrides?: Partial<typeof books.$inferInsert>): Promise<number> {
    const [row] = await db
      .insert(books)
      .values({
        publicId: generatePublicId('bk'),
        title: 'Tress of the Emerald Sea',
        status: 'imported',
        ...overrides,
      })
      .returning();
    return row!.id;
  }

  /** Write the column OUT OF BAND, the only way it can become non-canonical. */
  async function writeRawColumn(bookId: number, raw: string): Promise<void> {
    await db.run(sql`UPDATE books SET user_cleared_fields = ${raw} WHERE id = ${bookId}`);
  }

  async function readRawColumn(bookId: number): Promise<string | null> {
    const rows = await db.select({ raw: books.userClearedFields }).from(books).where(eq(books.id, bookId));
    return rows[0]!.raw;
  }

  /**
   * A scheduled enrichment pass over a single `pending` candidate whose provider
   * result fills every clearable scalar. Returns nothing — assert on the row.
   */
  async function runOneEnrichmentPass(): Promise<void> {
    const metadataService = {
      resolveBook: vi.fn().mockResolvedValue({
        title: 'Tress of the Emerald Sea',
        authors: [{ name: 'Brandon Sanderson' }],
        subtitle: 'A Cosmere Novel',
        description: 'Provider description',
        publisher: 'Dragonsteel',
        publishedDate: '2023-01-10',
        genres: ['Fantasy'],
        seriesPrimary: { name: 'Secret Projects', position: 1 },
        duration: 600,
      }),
    } as unknown as MetadataService;
    await runEnrichment(db, metadataService, bookService, log);
  }

  describe('AC1 — the column is inert plain text', () => {
    it('accepts a syntactically invalid value and still hydrates the book through getById', async () => {
      const bookId = await seedBook();
      await writeRawColumn(bookId, '{oops');

      const book = await bookService.getById(bookId);

      expect(book).not.toBeNull();
      expect(book!.userClearedFields).toEqual([]);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId }),
        expect.stringContaining('Unparseable userClearedFields'),
      );
    });

    it('lets an internal whole-row consumer select the same invalid row without throwing', async () => {
      // This is the guard that the PLAIN-TEXT column — not the parser — is what keeps
      // one corrupt row from breaking unrelated queries. A `{ mode: 'json' }` column
      // would `JSON.parse` in Drizzle's driver mapper and throw here, on a query that
      // has nothing to do with tombstones (quality gate, discovery, download service).
      const bookId = await seedBook();
      await writeRawColumn(bookId, '{oops');

      const rows = await db.select().from(books).where(eq(books.id, bookId));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.userClearedFields).toBe('{oops');
    });

    it('a scheduled enrichment pass over the invalid row completes normally', async () => {
      const bookId = await seedBook({ asin: 'B0BXXXXXXX' });
      await writeRawColumn(bookId, '{oops');

      await runOneEnrichmentPass();

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.enrichmentStatus).toBe('enriched');
      // Degraded to "no tombstones", so every fill lands.
      expect(row!.publisher).toBe('Dragonsteel');
      expect(row!.seriesName).toBe('Secret Projects');
    });
  });

  describe('AC4 — a sanitizing read, with the rest of the write still landing', () => {
    it('recognized-plus-unknown suppresses only the recognized field and does not strand the row', async () => {
      const bookId = await seedBook({ asin: 'B0BYYYYYYY' });
      await writeRawColumn(bookId, '["genres","futureField"]');

      await runOneEnrichmentPass();

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.genres).toBeNull();
      expect(row!.enrichmentStatus).toBe('enriched');
      expect(row!.publisher).toBe('Dragonsteel');
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId, dropped: ['futureField'] }),
        expect.stringContaining('Unknown userClearedFields'),
      );
    });

    it('a non-canonical but valid value is sanitized on read and the write otherwise proceeds', async () => {
      const bookId = await seedBook({ asin: 'B0BZZZZZZZ' });
      await writeRawColumn(bookId, '["subtitle","genres","subtitle"]');

      await runOneEnrichmentPass();

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.subtitle).toBeNull();
      expect(row!.genres).toBeNull();
      expect(row!.publisher).toBe('Dragonsteel');
      expect(row!.enrichmentStatus).toBe('enriched');
    });
  });

  describe('AC3 — canonical stored form after an in-app write', () => {
    it('stores the set sorted and deduplicated', async () => {
      const bookId = await seedBook();

      await bookService.update(bookId, { subtitle: null, genres: null, publisher: null }, { userAsserted: true });

      expect(await readRawColumn(bookId)).toBe('["genres","publisher","subtitle"]');
    });

    it('normalizes a non-canonical stored value on the next in-app write', async () => {
      const bookId = await seedBook();
      await writeRawColumn(bookId, '["subtitle","genres","subtitle"]');

      await bookService.update(bookId, { publisher: null }, { userAsserted: true });

      expect(await readRawColumn(bookId)).toBe('["genres","publisher","subtitle"]');
    });

    it('persists the empty set as SQL NULL, never "[]"', async () => {
      const bookId = await seedBook();
      await bookService.update(bookId, { seriesName: null }, { userAsserted: true });
      expect(await readRawColumn(bookId)).toBe('["seriesName"]');

      await bookService.update(bookId, { seriesName: 'Mistborn' }, { userAsserted: true });

      const raw = await readRawColumn(bookId);
      expect(raw).toBeNull();
      expect(raw).not.toBe('[]');
    });
  });

  describe('AC7 — blank input normalizes the stored value', () => {
    it("stores NULL (not '') for a whitespace-only publisher and records the tombstone", async () => {
      const bookId = await seedBook({ publisher: 'Tor' });

      await bookService.update(bookId, { publisher: '   ' }, { userAsserted: true });

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.publisher).toBeNull();
      expect(row!.userClearedFields).toBe('["publisher"]');
    });

    it('drops blank genre elements and removes the tombstone', async () => {
      const bookId = await seedBook();
      await writeRawColumn(bookId, '["genres"]');

      await bookService.update(bookId, { genres: ['Fantasy', '  ', 'Epic'] }, { userAsserted: true });

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.genres).toEqual(['Fantasy', 'Epic']);
      expect(row!.userClearedFields).toBeNull();
    });

    it('an internal (non-userAsserted) caller keeps verbatim behavior and touches no tombstone', async () => {
      const bookId = await seedBook({ publisher: 'Tor' });

      await bookService.update(bookId, { publisher: '' });

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.publisher).toBe('');
      expect(row!.userClearedFields).toBeNull();
    });
  });

  describe('AC14 — series membership residue', () => {
    async function seedSeriesWithMember(bookId: number, source: 'local' | 'hardcover'): Promise<number> {
      const [seriesRow] = await db
        .insert(series)
        .values({ publicId: generatePublicId('sr'), name: 'The Cosmere', normalizedName: 'the cosmere' })
        .returning();
      const [member] = await db
        .insert(seriesMembers)
        .values({
          seriesId: seriesRow!.id,
          bookId,
          title: 'Tress of the Emerald Sea',
          normalizedTitle: 'tress of the emerald sea',
          position: 29,
          source,
          ...(source === 'hardcover' ? { hardcoverBookId: 4242 } : {}),
        })
        .returning();
      return member!.id;
    }

    it("deletes a 'local' member row when the operator clears seriesName", async () => {
      const bookId = await seedBook({ seriesName: 'The Cosmere' });
      const memberId = await seedSeriesWithMember(bookId, 'local');

      await bookService.update(bookId, { seriesName: null, seriesPosition: null }, { userAsserted: true });

      const remaining = await db.select().from(seriesMembers).where(eq(seriesMembers.id, memberId));
      expect(remaining).toHaveLength(0);
    });

    it("keeps a 'hardcover' member row and only nulls its book link", async () => {
      const bookId = await seedBook({ seriesName: 'The Cosmere' });
      const memberId = await seedSeriesWithMember(bookId, 'hardcover');

      await bookService.update(bookId, { seriesName: null, seriesPosition: null }, { userAsserted: true });

      const [member] = await db.select().from(seriesMembers).where(eq(seriesMembers.id, memberId));
      expect(member).toBeDefined();
      expect(member!.bookId).toBeNull();
      expect(member!.hardcoverBookId).toBe(4242);
      expect(member!.title).toBe('Tress of the Emerald Sea');
    });

    it('does NOT reconcile membership when the same PUT sets a series instead of clearing it', async () => {
      const bookId = await seedBook({ seriesName: 'The Cosmere' });
      const memberId = await seedSeriesWithMember(bookId, 'local');

      await bookService.update(bookId, { seriesName: 'Mistborn' }, { userAsserted: true });

      const remaining = await db.select().from(seriesMembers).where(eq(seriesMembers.id, memberId));
      expect(remaining).toHaveLength(1);
    });

    it('an internal caller passing seriesName: null leaves membership and tombstones alone', async () => {
      const bookId = await seedBook({ seriesName: 'The Cosmere' });
      const memberId = await seedSeriesWithMember(bookId, 'local');

      await bookService.update(bookId, { seriesName: null });

      const remaining = await db.select().from(seriesMembers).where(eq(seriesMembers.id, memberId));
      expect(remaining).toHaveLength(1);
      expect(await readRawColumn(bookId)).toBeNull();
    });

    it('rolls the clear back when membership reconciliation fails — no half-applied residue (F23)', async () => {
      const bookId = await seedBook({ seriesName: 'The Cosmere', publisher: 'Tor' });
      const memberId = await seedSeriesWithMember(bookId, 'local');

      // Fail AFTER the book scalar/tombstone write, inside the same transaction.
      const link = await import('../server/services/book-series-link.js');
      const spy = vi.spyOn(link, 'detachBookFromSeriesMembers').mockRejectedValueOnce(new Error('reconcile boom'));

      await expect(
        bookService.update(bookId, { seriesName: null }, { userAsserted: true }),
      ).rejects.toThrow('reconcile boom');
      spy.mockRestore();

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.seriesName).toBe('The Cosmere');
      expect(row!.userClearedFields).toBeNull();
      const remaining = await db.select().from(seriesMembers).where(eq(seriesMembers.id, memberId));
      expect(remaining).toHaveLength(1);
    });
  });

  describe('AC16 — the hydrated detail exposes the parsed set', () => {
    it('returns [] for a NULL column and the parsed array for a populated one', async () => {
      const emptyId = await seedBook();
      const setId = await seedBook({ title: 'Other' });
      await writeRawColumn(setId, '["genres","seriesName"]');

      expect((await bookService.getById(emptyId))!.userClearedFields).toEqual([]);
      expect((await bookService.getById(setId))!.userClearedFields).toEqual(['genres', 'seriesName']);
    });

    it('update() echoes the recomputed set back as a parsed array', async () => {
      const bookId = await seedBook();

      const updated = await bookService.update(bookId, { seriesName: null }, { userAsserted: true });

      expect(updated!.userClearedFields).toEqual(['seriesName']);
    });
  });
});
