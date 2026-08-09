import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from './index.js';
import { books, bookNarrators, series, seriesMembers, unmatchedGenres } from './schema.js';
import { generatePublicId } from '../server/utils/public-id.js';
import { BookService } from '../server/services/book.service.js';
import { runEnrichment } from '../server/jobs/enrichment.js';
import { applyAudnexusEnrichment } from '../server/services/enrichment-orchestration.helpers.js';
import type { MetadataService } from '../server/services/metadata.service.js';

// A migrated real DB is required to cross Drizzle's decode boundary and observe
// committed state; parser-only tests and shared root/transaction mocks cannot do either.

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

  /** Write out of band to seed corrupt or otherwise non-canonical values. */
  async function writeRawColumn(bookId: number, raw: string): Promise<void> {
    await db.run(sql`UPDATE books SET user_cleared_fields = ${raw} WHERE id = ${bookId}`);
  }

  async function readRawColumn(bookId: number): Promise<string | null> {
    const rows = await db.select({ raw: books.userClearedFields }).from(books).where(eq(books.id, bookId));
    return rows[0]!.raw;
  }

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
      // JSON-mode Drizzle would parse and throw during this unrelated whole-row hydration.
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

      // Fail after the scalar/tombstone write but before the transaction commits.
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

  describe('AC11 / F20 / F21 — the caller-owned transaction arm, against a real DB', () => {
    it('runs on the caller handle, reads its own uncommitted write, and commits with the owner', async () => {
      const bookId = await seedBook({ publisher: 'Tor' });
      const offHandleSelect = vi.spyOn(db, 'select');

      const detail = await db.transaction(async (tx) => {
        const inside = await bookService.update(bookId, { publisher: null }, { userAsserted: true, tx });
        // Hydrate through tx so the read sees its own uncommitted write.
        expect(inside!.publisher).toBeNull();
        expect(inside!.userClearedFields).toEqual(['publisher']);
        return inside;
      });

      expect(detail).not.toBeNull();
      expect(offHandleSelect).not.toHaveBeenCalled();
      offHandleSelect.mockRestore();

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.publisher).toBeNull();
      expect(row!.userClearedFields).toBe('["publisher"]');
    });

    it('F21: an owner rollback strands no write, no success log, and no genre telemetry', async () => {
      const bookId = await seedBook({ publisher: 'Tor' });

      await expect(
        db.transaction(async (tx) => {
          await bookService.update(bookId, { publisher: null, genres: ['Zzzz Unmatched Genre'] }, { userAsserted: true, tx });
          throw new Error('owner rolled back');
        }),
      ).rejects.toThrow('owner rolled back');

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.publisher).toBe('Tor');
      expect(row!.userClearedFields).toBeNull();
      expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Book updated');
      const tracked = await db.select().from(unmatchedGenres);
      expect(tracked).toHaveLength(0);
    });

    it('the self-managed arm still returns the COMMITTED parsed detail', async () => {
      const bookId = await seedBook();

      const detail = await bookService.update(bookId, { seriesName: null }, { userAsserted: true });

      expect(detail!.userClearedFields).toEqual(['seriesName']);
      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.userClearedFields).toBe('["seriesName"]');
    });
  });

  // Root DB and tx are the same object in unit mocks; only committed DB state detects
  // a scalar write accidentally moved outside the transaction.
  describe('AC11 / F14 — post-import atomicity, against a real DB', () => {
    const providerData = { subtitle: 'A Cosmere Novel', publisher: 'Dragonsteel', genres: ['Fantasy'], narrators: ['Michael Kramer'] };

    function enrichmentDeps(bookId: number, failOnGenres: boolean) {
      const metadataService = {
        enrichBook: vi.fn().mockResolvedValue(providerData),
        resolveBook: vi.fn().mockResolvedValue(null),
      } as unknown as MetadataService;

      // Fail the genre write after scalar and narrator writes have been issued.
      const realUpdate = bookService.update.bind(bookService);
      vi.spyOn(bookService, 'update').mockImplementation(async (id, data, options) => {
        if (failOnGenres && data && 'genres' in data) throw new Error('genre write boom');
        return realUpdate(id, data, options);
      });
      void bookId;
      return { db, log, bookService, metadataService };
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('leaves the row NOT enriched when the array write fails after the scalar write', async () => {
      const bookId = await seedBook({ asin: 'B0BATOMIC1' });

      await expect(
        applyAudnexusEnrichment(
          bookId,
          { primaryAsin: 'B0BATOMIC1', existingNarrator: null, existingGenres: null, existingSubtitle: null, existingPublisher: null },
          enrichmentDeps(bookId, true),
        ),
      ).rejects.toThrow('genre write boom');

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.enrichmentStatus).toBe('pending');
      expect(row!.subtitle).toBeNull();
      expect(row!.publisher).toBeNull();
      expect(row!.genres).toBeNull();
      const narratorLinks = await db.select().from(bookNarrators).where(eq(bookNarrators.bookId, bookId));
      expect(narratorLinks).toHaveLength(0);
    });

    it('negative control: with no failure the same call commits everything', async () => {
      const bookId = await seedBook({ asin: 'B0BATOMIC2' });

      await applyAudnexusEnrichment(
        bookId,
        { primaryAsin: 'B0BATOMIC2', existingNarrator: null, existingGenres: null, existingSubtitle: null, existingPublisher: null },
        enrichmentDeps(bookId, false),
      );

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.enrichmentStatus).toBe('enriched');
      expect(row!.subtitle).toBe('A Cosmere Novel');
      expect(row!.publisher).toBe('Dragonsteel');
      expect(row!.genres).toEqual(['Fantasy']);
      const narratorLinks = await db.select().from(bookNarrators).where(eq(bookNarrators.bookId, bookId));
      expect(narratorLinks).toHaveLength(1);
    });

    it('COUNTERFACTUAL: the same two writes in SEPARATE transactions strand an enriched row', async () => {
      const bookId = await seedBook({ asin: 'B0BSPLIT' });

      await db.transaction(async (tx) => {
        await tx.update(books)
          .set({ enrichmentStatus: 'enriched', subtitle: 'A Cosmere Novel', updatedAt: new Date() })
          .where(eq(books.id, bookId));
      });
      await expect(
        db.transaction(async () => { throw new Error('genre write boom'); }),
      ).rejects.toThrow('genre write boom');

      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.enrichmentStatus).toBe('enriched');
      expect(row!.genres).toBeNull();
    });
  });

  // Caller-owned transactions defer side effects to the owner after commit. Observe the
  // real unmatched_genres table so a pre-commit telemetry leak cannot hide behind mocks.
  describe('F21 / F5 — enrichment owners resume genre telemetry after commit', () => {
    const UNMATCHED = 'Zzzz Unmatched Genre';

    async function readTrackedGenres(): Promise<string[]> {
      return (await db.select().from(unmatchedGenres)).map((r) => r.genre);
    }

    async function runScheduledPass(): Promise<void> {
      const metadataService = {
        resolveBook: vi.fn().mockResolvedValue({
          title: 'Tress of the Emerald Sea',
          authors: [{ name: 'Brandon Sanderson' }],
          genres: [UNMATCHED],
        }),
      } as unknown as MetadataService;
      await runEnrichment(db, metadataService, bookService, log);
    }

    async function runPostImportPass(bookId: number, asin: string): Promise<void> {
      const metadataService = {
        enrichBook: vi.fn().mockResolvedValue({ genres: [UNMATCHED] }),
        resolveBook: vi.fn().mockResolvedValue(null),
      } as unknown as MetadataService;
      await applyAudnexusEnrichment(
        bookId,
        { primaryAsin: asin, existingNarrator: 'Someone', existingGenres: null },
        { db, log, bookService, metadataService },
      );
    }

    it('scheduled: a committed genre fill records the unmatched genre', async () => {
      const bookId = await seedBook({ asin: 'B0BGENRE01' });

      await runScheduledPass();

      expect(await readTrackedGenres()).toEqual([UNMATCHED]);
      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.genres).toEqual([UNMATCHED]);
    });

    it('scheduled: a TOMBSTONED genre fill is suppressed, so nothing is recorded', async () => {
      const bookId = await seedBook({ asin: 'B0BGENRE02' });
      await writeRawColumn(bookId, '["genres"]');

      await runScheduledPass();

      expect(await readTrackedGenres()).toEqual([]);
      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.genres).toBeNull();
      expect(row!.enrichmentStatus).toBe('enriched');
    });

    it('scheduled: a stale-dropped candidate records nothing', async () => {
      const bookId = await seedBook({ asin: 'B0BGENRE03' });
      // Simulate Fix Match changing identity during the provider fetch.
      const metadataService = {
        resolveBook: vi.fn().mockImplementation(async () => {
          await db.update(books).set({ asin: 'B0BREIDENT' }).where(eq(books.id, bookId));
          return { title: 'Tress of the Emerald Sea', authors: [], genres: [UNMATCHED] };
        }),
      } as unknown as MetadataService;

      await runEnrichment(db, metadataService, bookService, log);

      expect(await readTrackedGenres()).toEqual([]);
    });

    it('post-import: a committed genre fill records the unmatched genre', async () => {
      const bookId = await seedBook({ asin: 'B0BGENRE04' });

      await runPostImportPass(bookId, 'B0BGENRE04');

      expect(await readTrackedGenres()).toEqual([UNMATCHED]);
      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.genres).toEqual([UNMATCHED]);
    });

    it('post-import: a TOMBSTONED genre fill is suppressed, so nothing is recorded', async () => {
      const bookId = await seedBook({ asin: 'B0BGENRE05' });
      await writeRawColumn(bookId, '["genres"]');

      await runPostImportPass(bookId, 'B0BGENRE05');

      expect(await readTrackedGenres()).toEqual([]);
      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.genres).toBeNull();
      expect(row!.enrichmentStatus).toBe('enriched');
    });

    it('post-import: a rolled-back transaction records nothing (the effect is DEFERRED, not pre-commit)', async () => {
      const bookId = await seedBook({ asin: 'B0BGENRE06' });
      const realUpdate = bookService.update.bind(bookService);
      vi.spyOn(bookService, 'update').mockImplementation(async (id, data, options) => {
        if (data && 'narrators' in data) throw new Error('narrator write boom');
        return realUpdate(id, data, options);
      });

      const metadataService = {
        enrichBook: vi.fn().mockResolvedValue({ genres: [UNMATCHED], narrators: ['Michael Kramer'] }),
        resolveBook: vi.fn().mockResolvedValue(null),
      } as unknown as MetadataService;
      await expect(
        applyAudnexusEnrichment(
          bookId,
          { primaryAsin: 'B0BGENRE06', existingNarrator: null, existingGenres: null },
          { db, log, bookService, metadataService },
        ),
      ).rejects.toThrow('narrator write boom');
      vi.restoreAllMocks();

      expect(await readTrackedGenres()).toEqual([]);
      const [row] = await db.select().from(books).where(eq(books.id, bookId));
      expect(row!.enrichmentStatus).toBe('pending');
      expect(row!.genres).toBeNull();
    });

    it('the operator-facing self-managed PUT arm still records genres itself', async () => {
      const bookId = await seedBook();

      await bookService.update(bookId, { genres: [UNMATCHED] }, { userAsserted: true });

      expect(await readTrackedGenres()).toEqual([UNMATCHED]);
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

  describe('#2152 — the seriesPosition tombstone against a real DB', () => {
    async function readRow(bookId: number) {
      return (await db.select().from(books).where(eq(books.id, bookId)))[0]!;
    }

    async function seedHunters(): Promise<number> {
      return seedBook({ title: 'Hunters of Dune', seriesName: 'Dune', seriesPosition: 7 });
    }

    it('AC4 row 3: clearing the position alone tombstones it and keeps the series name', async () => {
      const bookId = await seedHunters();

      const updated = await bookService.update(bookId, { seriesPosition: null }, { userAsserted: true });

      const row = await readRow(bookId);
      expect(row.seriesPosition).toBeNull();
      expect(row.seriesName).toBe('Dune');
      expect(row.userClearedFields).toBe('["seriesPosition"]');
      expect(updated!.userClearedFields).toEqual(['seriesPosition']);
    });

    it('re-assertion: a following { seriesPosition: 12 } stores 12 and drops the tombstone', async () => {
      const bookId = await seedHunters();
      await bookService.update(bookId, { seriesPosition: null }, { userAsserted: true });

      await bookService.update(bookId, { seriesPosition: 12 }, { userAsserted: true });

      const row = await readRow(bookId);
      expect(row.seriesPosition).toBe(12);
      expect(row.userClearedFields).toBeNull();
    });

    it('AC4 row 2a: 0 is stored as a position, never coerced into a clear', async () => {
      const bookId = await seedHunters();

      await bookService.update(bookId, { seriesPosition: 0 }, { userAsserted: true });

      const row = await readRow(bookId);
      expect(row.seriesPosition).toBe(0);
      expect(row.userClearedFields).toBeNull();
    });

    it('AC4 row 7: clearing the NAME nulls the position column and leaves the position tombstone alone', async () => {
      const bookId = await seedHunters();
      await bookService.update(bookId, { seriesPosition: null }, { userAsserted: true });

      await bookService.update(bookId, { seriesName: null }, { userAsserted: true });

      const row = await readRow(bookId);
      expect(row.seriesName).toBeNull();
      expect(row.seriesPosition).toBeNull();
      expect(row.userClearedFields).toBe('["seriesName","seriesPosition"]');
    });

    it('AC4 row 3 from the name-cleared state: the redundant both-entry set is inert', async () => {
      const bookId = await seedHunters();
      await bookService.update(bookId, { seriesName: null }, { userAsserted: true });
      const afterNameClear = await readRow(bookId);

      const updated = await bookService.update(bookId, { seriesPosition: null }, { userAsserted: true });

      const row = await readRow(bookId);
      expect(row.userClearedFields).toBe('["seriesName","seriesPosition"]');
      expect(row.seriesName).toBeNull();
      expect(row.seriesPosition).toBeNull();
      expect(row.seriesName).toBe(afterNameClear.seriesName);
      expect(row.seriesPosition).toBe(afterNameClear.seriesPosition);
      expect(updated!.userClearedFields).toEqual(['seriesName', 'seriesPosition']);
    });

    it('AC4 row 2b: a number supplied on a name-tombstoned book is discarded by rule b', async () => {
      const bookId = await seedBook({ title: 'Hunters of Dune', seriesName: 'Dune' });
      await bookService.update(bookId, { seriesName: null }, { userAsserted: true });

      await bookService.update(bookId, { seriesPosition: 7 }, { userAsserted: true });

      const row = await readRow(bookId);
      expect(row.seriesPosition).toBeNull();
      expect(row.userClearedFields).toBe('["seriesName"]');
    });

    it('AC4 row 1 exemption: an unrelated PUT leaves a stale name-tombstoned position exactly as it is', async () => {
      const bookId = await seedBook({ title: 'Hunters of Dune', seriesName: 'Dune' });
      await bookService.update(bookId, { seriesName: null }, { userAsserted: true });
      // Normal writes prevent this stale orphan, so seed it directly.
      await db.update(books).set({ seriesPosition: 7 }).where(eq(books.id, bookId));

      await bookService.update(bookId, { subtitle: 'x' }, { userAsserted: true });

      const row = await readRow(bookId);
      expect(row.seriesPosition).toBe(7);
      expect(row.userClearedFields).toBe('["seriesName"]');
    });

    it('AC4 row 6: setting a name while blanking the position leaves the position tombstoned', async () => {
      const bookId = await seedHunters();

      await bookService.update(bookId, { seriesName: 'Dune Chronicles', seriesPosition: null }, { userAsserted: true });

      const row = await readRow(bookId);
      expect(row.seriesName).toBe('Dune Chronicles');
      expect(row.seriesPosition).toBeNull();
      expect(row.userClearedFields).toBe('["seriesPosition"]');
    });

    it('AC4 rule a: setting a name alone re-asserts the pair and drops the position tombstone', async () => {
      const bookId = await seedHunters();
      await bookService.update(bookId, { seriesPosition: null }, { userAsserted: true });

      await bookService.update(bookId, { seriesName: 'Dune Chronicles' }, { userAsserted: true });

      const row = await readRow(bookId);
      expect(row.seriesName).toBe('Dune Chronicles');
      expect(row.seriesPosition).toBeNull();
      expect(row.userClearedFields).toBeNull();
    });

    it('a legacy both-entry row is not rewritten by an unrelated update (no rule keys on absence)', async () => {
      const bookId = await seedBook();
      await writeRawColumn(bookId, '["seriesName","seriesPosition"]');
      const before = await readRawColumn(bookId);

      await bookService.update(bookId, { subtitle: 'x' }, { userAsserted: true });

      expect(await readRawColumn(bookId)).toBe(before);
    });

    it('an internal (non-userAsserted) caller records no position tombstone', async () => {
      const bookId = await seedHunters();

      await bookService.update(bookId, { seriesPosition: null });

      const row = await readRow(bookId);
      expect(row.seriesPosition).toBeNull();
      expect(row.userClearedFields).toBeNull();
    });

    it('a concurrent unrelated tombstone landing during a position clear drops neither entry', async () => {
      const bookId = await seedHunters();

      await Promise.all([
        bookService.update(bookId, { seriesPosition: null }, { userAsserted: true }),
        bookService.update(bookId, { publisher: null }, { userAsserted: true }),
      ]);

      expect(await readRawColumn(bookId)).toBe('["publisher","seriesPosition"]');
    });

    it('a scheduled enrichment pass does not resurrect the cleared position', async () => {
      // Seed the no-name/stale-position shape fillSeriesFields handles.
      const bookId = await seedBook({ title: 'Tress of the Emerald Sea', asin: 'B0BTRESS01', seriesPosition: 5, enrichmentStatus: 'pending' });
      await writeRawColumn(bookId, '["seriesPosition"]');

      await runOneEnrichmentPass();

      const row = await readRow(bookId);
      expect(row.seriesName).toBe('Secret Projects');
      expect(row.seriesPosition).toBeNull();
    });

    it('control: the same fixture without the tombstone DOES get the provider position', async () => {
      const bookId = await seedBook({ title: 'Tress of the Emerald Sea', asin: 'B0BTRESS01', seriesPosition: 5, enrichmentStatus: 'pending' });

      await runOneEnrichmentPass();

      const row = await readRow(bookId);
      expect(row.seriesName).toBe('Secret Projects');
      expect(row.seriesPosition).toBe(1);
    });
  });
});
