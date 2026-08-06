import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { RateLimitError, TransientError } from '@core/index.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { MetadataService } from '../services/metadata.service.js';
import type { BookService } from '../services/book.service.js';

import { runEnrichment } from './enrichment.js';

// Serialize a Drizzle SQL predicate (the arg passed to `.where()`) to raw SQL +
// bound params, so we assert the REAL captured-ASIN guard shape instead of just
// "`.where()` was called" — a regression to `where(eq(books.id, ...))` only
// would leave `"asin"` out of the SQL and the captured value out of the params.
// Mirrors discovery.service.test.ts / blacklist.service.test.ts.
const dialect = new SQLiteSyncDialect();
function whereSql(expr: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return dialect.sqlToQuery((expr as any).getSQL()).sql;
}
function whereParams(expr: unknown): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return dialect.sqlToQuery((expr as any).getSQL()).params;
}

describe('enrichment job', () => {
  let db: ReturnType<typeof createMockDb>;
  let metadataService: { resolveBook: ReturnType<typeof vi.fn> };
  let bookService: { update: ReturnType<typeof vi.fn>; findAsinCollision: ReturnType<typeof vi.fn>; trackUnmatchedGenres: ReturnType<typeof vi.fn> };
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    db = createMockDb();
    metadataService = { resolveBook: vi.fn().mockResolvedValue(null) };
    bookService = { update: vi.fn().mockResolvedValue(null), findAsinCollision: vi.fn().mockResolvedValue(null), trackUnmatchedGenres: vi.fn().mockResolvedValue(undefined) };
    log = createMockLogger();
  });

  it('selects null-ASIN pending books and routes them through resolveBook (no longer skipped)', async () => {
    // A pending book WITHOUT an asin is now a candidate; its title + joined
    // primary author are passed to resolveBook, which resolves via search.
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: null, title: 'No ASIN Book', author: 'Some Author' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'No ASIN Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    metadataService.resolveBook.mockResolvedValueOnce({ title: 'No ASIN Book', authors: [{ name: 'Some Author' }], duration: 600 });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(metadataService.resolveBook).toHaveBeenCalledWith({ asin: undefined, title: 'No ASIN Book', author: 'Some Author' });
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Books without ASIN marked as skipped');
  });

  it('calls resolveBook title-only when the candidate has no author row', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: null, title: 'Authorless Book', author: null }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Authorless Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    metadataService.resolveBook.mockResolvedValueOnce({ title: 'Authorless Book', authors: [{ name: 'Found' }], duration: 600 });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(metadataService.resolveBook).toHaveBeenCalledWith({ asin: undefined, title: 'Authorless Book', author: undefined });
  });

  it('enriches book with ASIN successfully', async () => {
    const enrichedData = {
      title: 'The Way of Kings',
      authors: [{ name: 'Brandon Sanderson' }],
      narrators: ['Michael Kramer', 'Kate Reading'],
      duration: 2700,
    };

    // First select: no-asin books (none)
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B003P2WO5E' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing book fields

    metadataService.resolveBook.mockResolvedValueOnce(enrichedData);
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(metadataService.resolveBook).toHaveBeenCalledWith(expect.objectContaining({ asin: 'B003P2WO5E' }));
    expect(db.update).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B003P2WO5E' },
      'Book enriched successfully',
    );
  });

  it('marks book as failed when enrichment returns null', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B000BROKEN' }]));  // candidates

    metadataService.resolveBook.mockResolvedValueOnce(null);
    // The guarded no-match write returns the matched row → genuine fail-mark.
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(db.update).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B000BROKEN' },
      'Book enrichment failed',
    );
  });

  it('does not overwrite existing narrator/duration', async () => {
    const enrichedData = {
      title: 'Some Book',
      authors: [{ name: 'Author' }],
      narrators: ['New Narrator'],
      duration: 9999,
    };

    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B003P2WO5E' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: 1234, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    metadataService.resolveBook.mockResolvedValueOnce(enrichedData);
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    // Should still call update (for enrichmentStatus) but not include narrator/duration overrides
    expect(db.update).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B003P2WO5E' },
      'Book enriched successfully',
    );
  });

  it('does nothing when no candidates exist', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([]));  // candidates (none)

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(metadataService.resolveBook).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('enriches with only narrators (no duration) from Audnexus', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_PARTIAL' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    metadataService.resolveBook.mockResolvedValueOnce({
      title: 'Partial Book',
      authors: [{ name: 'Author' }],
      narrators: ['Jim Dale'],
      // no duration field
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_PARTIAL' },
      'Book enriched successfully',
    );
  });

  it('enriches with only duration (no narrators) from Audnexus', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_DUR_ONLY' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    metadataService.resolveBook.mockResolvedValueOnce({
      title: 'Duration Only',
      authors: [{ name: 'Author' }],
      duration: 480,
      // no narrators field
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_DUR_ONLY' },
      'Book enriched successfully',
    );
  });

  it('handles empty narrators array without setting narrator field', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_EMPTY_NARR' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    metadataService.resolveBook.mockResolvedValueOnce({
      title: 'Empty Narrators',
      authors: [{ name: 'Author' }],
      narrators: [],  // empty array — should not set narrator
      duration: 300,
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    // Still enriched (status updated), but narrator shouldn't be set from empty array
    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_EMPTY_NARR' },
      'Book enriched successfully',
    );
  });

  it('does not call resolveBook when there are no candidates at all', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([]));  // candidates (empty)

    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(metadataService.resolveBook).not.toHaveBeenCalled();
  });

  it('treats narrators: undefined differently from narrators: [] (undefined skips, empty array skips)', async () => {
    // narrators: undefined — the `result.narrators?.length` check short-circuits via optional chaining
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_UNDEF_NARR' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    metadataService.resolveBook.mockResolvedValueOnce({
      title: 'Undefined Narrators',
      authors: [{ name: 'Author' }],
      // narrators key entirely absent → undefined
      duration: 600,
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    // Should still mark as enriched — narrator stays null because narrators is undefined
    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_UNDEF_NARR' },
      'Book enriched successfully',
    );
  });

  it('handles empty existing array from DB query (existing.length === 0)', async () => {
    // Edge case: the book row is somehow missing between candidate selection and field lookup
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_MISSING' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([]));  // existing book fields — empty!

    metadataService.resolveBook.mockResolvedValueOnce({
      title: 'Ghost Book',
      authors: [{ name: 'Author' }],
      narrators: ['Some Narrator'],
      duration: 500,
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    // Should still update enrichmentStatus to 'enriched' but skip narrator/duration fields
    expect(db.update).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_MISSING' },
      'Book enriched successfully',
    );
  });

  it('sets enrichmentStatus to enriched even when metadata returns null for all optional fields', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_ALL_NULL' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    // resolveBook returns a result object but with no narrators and no duration
    metadataService.resolveBook.mockResolvedValueOnce({
      title: null,
      authors: null,
      narrators: undefined,
      duration: undefined,
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    // The result is truthy (it's an object), so it follows the enriched path not the failed path
    expect(db.update).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_ALL_NULL' },
      'Book enriched successfully',
    );
    // Should NOT have logged a failure
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      'Book enrichment failed',
    );
  });

  it('breaks batch on RateLimitError and leaves remaining candidates pending', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([
        { id: 1, asin: 'B001' },
        { id: 2, asin: 'B002' },
        { id: 3, asin: 'B003' },
      ]));  // candidates

    // First enrichment succeeds, second throws rate limit
    metadataService.resolveBook
      .mockResolvedValueOnce({ title: 'Book 1', authors: [], narrators: ['Narrator'], duration: 100 })
      .mockRejectedValueOnce(new RateLimitError(30000, 'Audnexus'));

    db.select.mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing book fields for book 1
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    // Only first book's enrichment should have been processed, second throws, third skipped
    expect(metadataService.resolveBook).toHaveBeenCalledTimes(2);
    expect(metadataService.resolveBook).toHaveBeenCalledWith(expect.objectContaining({ asin: 'B001' }));
    expect(metadataService.resolveBook).toHaveBeenCalledWith(expect.objectContaining({ asin: 'B002' }));
    // Third book should NOT have been called
    expect(metadataService.resolveBook).not.toHaveBeenCalledWith(expect.objectContaining({ asin: 'B003' }));

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'Audnexus', retryAfterMs: 30000 }),
      'Rate limited during enrichment — remaining candidates stay pending',
    );
  });

  // ── #229 Observability — batch completion logging ───────────────────────
  describe('batch completion logging (#229)', () => {
    it('enrichment batch completion log includes elapsedMs', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B003P2WO5E' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Book', authors: [{ name: 'Author' }], duration: 600,
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ elapsedMs: expect.any(Number) }),
        'Enrichment batch completed',
      );
    });

    it('enrichment batch completion log includes filled flags (duration, narrators)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B003P2WO5E' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing: both empty

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Book', authors: [{ name: 'Author' }],
        narrators: ['Jim Dale'],
        duration: 600,
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.insert.mockReturnValue(mockDbChain([]));
      // narrator lookup: no existing narrators
      db.select.mockReturnValueOnce(mockDbChain([]));
      // findOrCreateNarrator: not found, insert
      db.select.mockReturnValueOnce(mockDbChain([]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ filledDuration: expect.any(Number), filledNarrators: expect.any(Number) }),
        'Enrichment batch completed',
      );
    });

    it('helper failure for first narrator does not abort batch — second narrator still gets bookNarrators insert and book update completes (#482)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_NAR_FAIL' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Book', authors: [{ name: 'Author' }],
        narrators: ['Failing Narrator', 'Good Narrator'],
        duration: 600,
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      // narrator lookup: no existing narrators in junction table
      db.select.mockReturnValueOnce(mockDbChain([]));
      // isStillSameAsin check before narrator-fill loop (#1129 stale guard)
      db.select.mockReturnValueOnce(mockDbChain([{ asin: 'B_NAR_FAIL' }]));

      // --- Narrator 1 (Failing Narrator): findOrCreateNarrator fails ---
      // select: not found
      db.select.mockReturnValueOnce(mockDbChain([]));
      // insert: throws unique constraint
      db.insert.mockReturnValueOnce(mockDbChain(undefined, { error: new Error('UNIQUE constraint') }));
      // retry select: also empty → throws
      db.select.mockReturnValueOnce(mockDbChain([]));

      // --- Narrator 2 (Good Narrator): findOrCreateNarrator succeeds ---
      // select: not found
      db.select.mockReturnValueOnce(mockDbChain([]));
      // insert: succeeds
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 55 }]));

      // bookNarrators insert for narrator 2
      const junctionChain = mockDbChain([]);
      db.insert.mockReturnValueOnce(junctionChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // Narrator 2 junction row was inserted with correct narratorId and position
      expect(junctionChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, narratorId: 55, position: 1 }),
      );

      // Book still got its final update (enrichment completed)
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ filledNarrators: 1 }),
        'Enrichment batch completed',
      );
    });
  });

  describe('genre persistence', () => {
    it('persists genres via bookService.update() when book has null genres in DB', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_GENRE' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]))  // existing: genres null
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_GENRE' }]));  // in-tx precondition re-read (#2069 AC11)

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Genre Book', authors: [{ name: 'Author' }],
        genres: ['Fantasy', 'Science Fiction'],
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.update).toHaveBeenCalledWith(1, { genres: ['Fantasy', 'Science Fiction'] }, { tx: expect.anything() });
    });

    it('persists genres via bookService.update() when book has empty array genres in DB', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_GENRE_EMPTY' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: [], title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]))  // existing: genres empty array
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_GENRE_EMPTY' }]));  // in-tx precondition re-read (#2069 AC11)

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Genre Book', authors: [{ name: 'Author' }],
        genres: ['Mystery'],
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.update).toHaveBeenCalledWith(1, { genres: ['Mystery'] }, { tx: expect.anything() });
    });

    it('does NOT update genres when book already has non-empty genres', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_HAS_GENRES' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: ['Existing Genre'], title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing: has genres

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Genre Book', authors: [{ name: 'Author' }],
        genres: ['New Genre'],
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.update).not.toHaveBeenCalled();
    });

    it('does NOT update genres when resolveBook returns no genres (undefined)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_NO_GENRE' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'No Genre Book', authors: [{ name: 'Author' }],
        duration: 600,
        // genres undefined
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.update).not.toHaveBeenCalled();
    });

    it('does NOT update genres when resolveBook returns empty genres array', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_EMPTY_GENRE' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Empty Genre Book', authors: [{ name: 'Author' }],
        genres: [],
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.update).not.toHaveBeenCalled();
    });

    it('increments filledGenres counter only when genres are actually filled', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: 'B_FILL' },
          { id: 2, asin: 'B_SKIP' },
        ]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]))  // book 1: no genres
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_FILL', userClearedFields: null }]))  // book 1: in-tx precondition re-read (#2069 AC11)
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: ['Existing'], title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]))  // book 2: has genres
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_SKIP', userClearedFields: null }]));  // book 2: in-tx precondition re-read

      metadataService.resolveBook
        .mockResolvedValueOnce({ title: 'Book 1', authors: [], genres: ['Fantasy'] })
        .mockResolvedValueOnce({ title: 'Book 2', authors: [], genres: ['New Genre'] });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ filledGenres: 1 }),
        'Enrichment batch completed',
      );
    });

    it('includes filledGenres in batch completion log message', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_LOG' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Book', authors: [{ name: 'Author' }], duration: 600,
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ filledGenres: expect.any(Number) }),
        'Enrichment batch completed',
      );
    });
  });

  // ── #1614 subtitle/publisher fill-empty guard ─────────────────────────
  describe('subtitle/publisher fill-empty (#1614)', () => {
    it('fills blank subtitle and publisher from the enrichment result', async () => {
      const updateChain = mockDbChain([{ id: 1 }]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_FILL_SP' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: ['x'], title: 'Some Book', subtitle: null, description: null, publisher: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing: blank subtitle/publisher

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Some Book', authors: [{ name: 'Author' }],
        subtitle: 'Filled Subtitle', publisher: 'Filled Publisher',
      });
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ subtitle: 'Filled Subtitle', publisher: 'Filled Publisher' }),
      );
    });

    it('does NOT overwrite an existing non-empty subtitle/publisher', async () => {
      const updateChain = mockDbChain([{ id: 1 }]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_KEEP_SP' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: ['x'], title: 'Some Book', subtitle: 'Existing Subtitle', description: null, publisher: 'Existing Publisher', coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing: both set

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Some Book', authors: [{ name: 'Author' }],
        subtitle: 'Provider Subtitle', publisher: 'Provider Publisher',
      });
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty('subtitle');
      expect(setArg).not.toHaveProperty('publisher');
    });
  });

  // ── #398 Title normalization (ALL CAPS guard) ─────────────────────────
  describe('title normalization (#398)', () => {
    const allFields = { duration: null, genres: null, title: 'PROJECT HAIL MARY', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null };

    function setupEnrichment(existingFields: Record<string, unknown>, enrichedData: Record<string, unknown>) {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_TITLE' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ ...allFields, ...existingFields }]));  // existing
      metadataService.resolveBook.mockResolvedValueOnce({ title: 'Enriched', authors: [{ name: 'Author' }], ...enrichedData });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
    }

    it('overwrites ALL CAPS title with enrichment proper case', async () => {
      setupEnrichment({ title: 'PROJECT HAIL MARY' }, { title: 'Project Hail Mary' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('title', 'Project Hail Mary');
    });

    it('does NOT overwrite mixed-case title', async () => {
      setupEnrichment({ title: 'Project Hail Mary' }, { title: 'Project Hail Mary: A Novel' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('title');
    });

    it('overwrites single-word ALL CAPS title', async () => {
      setupEnrichment({ title: 'PIRANESI' }, { title: 'Piranesi' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('title', 'Piranesi');
    });

    it('overwrites ALL CAPS title containing numbers/punctuation', async () => {
      setupEnrichment({ title: 'DUNGEON CRAWLER CARL: BOOK 1' }, { title: 'Dungeon Crawler Carl: Book 1' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('title', 'Dungeon Crawler Carl: Book 1');
    });

    it('does NOT change title when enrichment returns no title', async () => {
      setupEnrichment({ title: 'PROJECT HAIL MARY' }, { title: undefined });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('title');
    });

    it('does NOT overwrite uncased title (e.g. "12345")', async () => {
      setupEnrichment({ title: '12345' }, { title: 'Twelve Thousand' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('title');
    });

    it('does NOT overwrite ALL CAPS title when enrichment returns same value', async () => {
      setupEnrichment({ title: 'PROJECT HAIL MARY' }, { title: 'PROJECT HAIL MARY' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('title');
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ filledTitle: 0 }),
        'Enrichment batch completed',
      );
    });
  });

  // ── #398 Description fill ─────────────────────────────────────────────
  describe('description fill (#398)', () => {
    const allFields = { duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null };

    function setupEnrichment(existingFields: Record<string, unknown>, enrichedData: Record<string, unknown>) {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_DESC' }]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, ...existingFields }]));
      metadataService.resolveBook.mockResolvedValueOnce({ title: 'Book', authors: [{ name: 'Author' }], ...enrichedData });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
    }

    it('fills description when currently null', async () => {
      setupEnrichment({ description: null }, { description: 'A great book' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('description', 'A great book');
    });

    it('fills description when currently empty string', async () => {
      setupEnrichment({ description: '' }, { description: 'A great book' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('description', 'A great book');
    });

    it('does NOT overwrite existing description', async () => {
      setupEnrichment({ description: 'Existing description' }, { description: 'New description' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('description');
    });
  });

  // ── #1634 Cover URL — Audnexus cover always wins (carve-out from fill-empty) ──
  describe('cover URL fill — Audnexus override (#1634)', () => {
    const allFields = { duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null };

    function setupEnrichment(existingFields: Record<string, unknown>, enrichedData: Record<string, unknown>) {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_COVER' }]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, ...existingFields }]));
      metadataService.resolveBook.mockResolvedValueOnce({ title: 'Book', authors: [{ name: 'Author' }], ...enrichedData });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
    }

    it('fills coverUrl when currently null', async () => {
      setupEnrichment({ coverUrl: null }, { coverUrl: 'https://example.com/cover.jpg' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('coverUrl', 'https://example.com/cover.jpg');
    });

    it('OVERWRITES an existing provider cover with the Audnexus cover', async () => {
      // The audiobook cover is authoritative for an audiobook app — the at-add
      // Hardcover print cover is a placeholder that the Audnexus square cover wins over.
      setupEnrichment(
        { coverUrl: 'https://assets.hardcover.app/edition/30615590/print.jpg' },
        { coverUrl: 'https://m.media-amazon.com/images/I/81bRC7xFElL.jpg' },
      );
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('coverUrl', 'https://m.media-amazon.com/images/I/81bRC7xFElL.jpg');
    });

    it('preserves the existing cover when Audnexus returns no image', async () => {
      // Audnexus maps a missing cover to `undefined` (not null/empty) — the override
      // guards on the result value's presence so a no-image result never blanks a cover.
      setupEnrichment({ coverUrl: 'https://existing.com/cover.jpg' }, { coverUrl: undefined });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('coverUrl');
    });

    it('keeps fill-empty semantics for sibling fields while overriding the cover', async () => {
      // The carve-out is scoped to coverUrl only: a sibling fill-empty field
      // (description) with an existing value is NOT overwritten in the same pass.
      setupEnrichment(
        { coverUrl: 'https://existing.com/cover.jpg', description: 'Existing description' },
        { coverUrl: 'https://m.media-amazon.com/images/I/new.jpg', description: 'New description' },
      );
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('coverUrl', 'https://m.media-amazon.com/images/I/new.jpg');
      expect(setCall).not.toHaveProperty('description');
    });
  });

  // ── #398 Published date fill ──────────────────────────────────────────
  describe('published date fill (#398)', () => {
    const allFields = { duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null };

    function setupEnrichment(existingFields: Record<string, unknown>, enrichedData: Record<string, unknown>) {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_DATE' }]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, ...existingFields }]));
      metadataService.resolveBook.mockResolvedValueOnce({ title: 'Book', authors: [{ name: 'Author' }], ...enrichedData });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
    }

    it('fills publishedDate when currently null', async () => {
      setupEnrichment({ publishedDate: null }, { publishedDate: '2021-05-04' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('publishedDate', '2021-05-04');
    });

    it('does NOT overwrite existing publishedDate', async () => {
      setupEnrichment({ publishedDate: '2020-01-01' }, { publishedDate: '2021-05-04' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('publishedDate');
    });
  });

  // ── #398 Series info fill ─────────────────────────────────────────────
  describe('series info fill (#398)', () => {
    const allFields = { duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null };

    function setupEnrichment(existingFields: Record<string, unknown>, enrichedData: Record<string, unknown>) {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_SERIES' }]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, ...existingFields }]));
      metadataService.resolveBook.mockResolvedValueOnce({ title: 'Book', authors: [{ name: 'Author' }], ...enrichedData });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
    }

    it('fills seriesName and seriesPosition from series[0]', async () => {
      setupEnrichment({ seriesName: null, seriesPosition: null }, { series: [{ name: 'The Stormlight Archive', position: 1 }] });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('seriesName', 'The Stormlight Archive');
      expect(setCall).toHaveProperty('seriesPosition', 1);
    });

    it('uses only series[0] when multiple series entries returned', async () => {
      setupEnrichment({ seriesName: null, seriesPosition: null }, {
        series: [
          { name: 'The Stormlight Archive', position: 1 },
          { name: 'The Cosmere', position: 5 },
        ],
      });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('seriesName', 'The Stormlight Archive');
      expect(setCall).toHaveProperty('seriesPosition', 1);
    });

    // #1927 AC10 — a stored series name is authoritative: enrichment writes NEITHER field,
    // so a metadata position is never grafted onto a user's stored series (the pair stays
    // single-sourced). Covers name-present × { position present, position null }.
    it('stored seriesName present + position present → writes NEITHER field (#1927 AC10)', async () => {
      setupEnrichment({ seriesName: 'Custom Saga', seriesPosition: 3 }, { series: [{ name: 'Provider Saga', position: 15 }] });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('seriesName');
      expect(setCall).not.toHaveProperty('seriesPosition');
    });

    it('stored seriesName present + position null → position NOT back-filled (#1927 AC10 reverses the old independent fill)', async () => {
      // Pre-#1927 this back-filled seriesPosition beside the stored name (crossing sources).
      // AC10: a stored name is authoritative; a missing position is corrected via Fix Match /
      // the metadata editor, never grafted by enrichment.
      setupEnrichment({ seriesName: 'Custom Saga', seriesPosition: null }, { series: [{ name: 'Provider Saga', position: 15 }] });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('seriesName');
      expect(setCall).not.toHaveProperty('seriesPosition');
    });

    it('orphan { seriesName: null, seriesPosition: 5 } → BOTH written atomically, stale position overwritten (#1927 AC10/F11)', async () => {
      // The name is absent, so the metadata pair is written atomically — the orphan `5` is
      // overwritten by the metadata position (15), never surviving as `Provider Saga #5`.
      setupEnrichment({ seriesName: null, seriesPosition: 5 }, { series: [{ name: 'Provider Saga', position: 15 }] });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('seriesName', 'Provider Saga');
      expect(setCall).toHaveProperty('seriesPosition', 15);
    });

    it('orphan { seriesName: null, seriesPosition: 5 } vs metadata with NO position → position CLEARED to null (#1927 AC10)', async () => {
      // Absent name + metadata name without a position → seriesName set, orphan position cleared
      // to null (not retained), so the written pair is single-sourced.
      setupEnrichment({ seriesName: null, seriesPosition: 5 }, { series: [{ name: 'Provider Saga' }] });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('seriesName', 'Provider Saga');
      expect(setCall).toHaveProperty('seriesPosition', null);
    });

    it('absent name + metadata primary position 0 → seriesPosition 0 written (not dropped) (#1927 AC10)', async () => {
      setupEnrichment({ seriesName: null, seriesPosition: null }, { series: [{ name: 'Prequels', position: 0 }] });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('seriesName', 'Prequels');
      expect(setCall).toHaveProperty('seriesPosition', 0);
    });

    it('does not change series when enrichment returns empty series array', async () => {
      setupEnrichment({ seriesName: null, seriesPosition: null }, { series: [] });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('seriesName');
      expect(setCall).not.toHaveProperty('seriesPosition');
    });

    // #1097 — canonical primary-series preference over series[0]
    it('prefers seriesPrimary over series[0] when both are present', async () => {
      setupEnrichment(
        { seriesName: null, seriesPosition: null },
        {
          seriesPrimary: { name: 'The Stormlight Archive', position: 2 },
          series: [
            { name: 'The Cosmere', position: 5 },
            { name: 'The Stormlight Archive', position: 2 },
          ],
        },
      );
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('seriesName', 'The Stormlight Archive');
      expect(setCall).toHaveProperty('seriesPosition', 2);
    });

    it('falls back to series[0] when only it is present (no seriesPrimary)', async () => {
      setupEnrichment(
        { seriesName: null, seriesPosition: null },
        { series: [{ name: 'Discworld', position: 3 }] },
      );
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('seriesName', 'Discworld');
      expect(setCall).toHaveProperty('seriesPosition', 3);
    });
  });

  // ── #398 Counter tracking ─────────────────────────────────────────────
  describe('counter tracking (#398)', () => {
    const allFields = { duration: null, genres: null, title: 'PROJECT HAIL MARY', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null };

    it('increments filledTitle only when title is actually updated', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: 'B_T1' },
          { id: 2, asin: 'B_T2' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, title: 'PROJECT HAIL MARY' }]))  // book 1: ALL CAPS
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_T1', userClearedFields: null }]))  // book 1: in-tx precondition re-read (#2069 AC11)
        .mockReturnValueOnce(mockDbChain([{ ...allFields, title: 'Already Good' }]))  // book 2: mixed case
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_T2', userClearedFields: null }]));  // book 2: in-tx precondition re-read

      metadataService.resolveBook
        .mockResolvedValueOnce({ title: 'Project Hail Mary', authors: [] })
        .mockResolvedValueOnce({ title: 'Already Good', authors: [] });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ filledTitle: 1 }),
        'Enrichment batch completed',
      );
    });

    it('increments filledDescription only when description is actually filled', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: 'B_D1' },
          { id: 2, asin: 'B_D2' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, description: null }]))
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_D1', userClearedFields: null }]))  // book 1: in-tx precondition re-read (#2069 AC11)
        .mockReturnValueOnce(mockDbChain([{ ...allFields, description: 'Existing' }]))
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_D2', userClearedFields: null }]));  // book 2: in-tx precondition re-read

      metadataService.resolveBook
        .mockResolvedValueOnce({ title: 'Book 1', authors: [], description: 'New desc' })
        .mockResolvedValueOnce({ title: 'Book 2', authors: [], description: 'Another desc' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ filledDescription: 1 }),
        'Enrichment batch completed',
      );
    });

    it('existing filledDuration/filledNarrators/filledGenres still work', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_ALL' }]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, duration: null }]));

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Book', authors: [{ name: 'Author' }],
        duration: 600,
        genres: ['Fantasy'],
        narrators: ['Jim Dale'],
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.insert.mockReturnValue(mockDbChain([]));
      // narrator lookup: no existing narrators
      db.select.mockReturnValueOnce(mockDbChain([]));
      // isStillSameAsin (narrators) — #1129
      db.select.mockReturnValueOnce(mockDbChain([{ asin: 'B_ALL' }]));
      // findOrCreateNarrator: not found, insert
      db.select.mockReturnValueOnce(mockDbChain([]));
      // in-tx precondition re-read — LAST, the write transaction runs after the
      // narrator block (#2069 AC11)
      db.select.mockReturnValueOnce(mockDbChain([{ asin: 'B_ALL', userClearedFields: null }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({
          filledDuration: 1,
          filledNarrators: 1,
          filledGenres: 1,
        }),
        'Enrichment batch completed',
      );
    });
  });

  // ── #398 Integration ──────────────────────────────────────────────────
  describe('enrichment field persistence integration (#398)', () => {
    const emptyFields = { duration: null, genres: null, title: 'PROJECT HAIL MARY', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null };

    it('full enrichment cycle populates all new fields in single pass', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_FULL' }]))
        .mockReturnValueOnce(mockDbChain([emptyFields]));

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Project Hail Mary',
        authors: [{ name: 'Andy Weir' }],
        description: 'An astronaut wakes up alone',
        coverUrl: 'https://example.com/cover.jpg',
        publishedDate: '2021-05-04',
        series: [{ name: 'Standalone', position: 1 }],
        duration: 970,
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('title', 'Project Hail Mary');
      expect(setCall).toHaveProperty('description', 'An astronaut wakes up alone');
      expect(setCall).toHaveProperty('coverUrl', 'https://example.com/cover.jpg');
      expect(setCall).toHaveProperty('publishedDate', '2021-05-04');
      expect(setCall).toHaveProperty('seriesName', 'Standalone');
      expect(setCall).toHaveProperty('seriesPosition', 1);
      expect(setCall).toHaveProperty('duration', 970);
    });

    it('select query requests all required fields for field-fill logic', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_PROJ' }]))
        .mockReturnValueOnce(mockDbChain([emptyFields]));

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Project Hail Mary', authors: [{ name: 'Author' }],
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // The second db.select() call is the existing-fields lookup (the first is
      // the candidate query) — assert its projection
      const projectionArg = db.select.mock.calls[1]![0];
      expect(projectionArg).toHaveProperty('duration');
      expect(projectionArg).toHaveProperty('genres');
      expect(projectionArg).toHaveProperty('title');
      expect(projectionArg).toHaveProperty('description');
      expect(projectionArg).toHaveProperty('coverUrl');
      expect(projectionArg).toHaveProperty('publishedDate');
      expect(projectionArg).toHaveProperty('seriesName');
      expect(projectionArg).toHaveProperty('seriesPosition');
    });

    it('overwrites only coverUrl (Audnexus carve-out) when all fields already populated', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_FULL2' }]))
        .mockReturnValueOnce(mockDbChain([{
          duration: 900, genres: ['Sci-Fi'], title: 'Project Hail Mary',
          description: 'Existing', coverUrl: 'https://old.com/c.jpg',
          publishedDate: '2020-01-01', seriesName: 'Old Series', seriesPosition: 2,
        }]));

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'Project Hail Mary: A Novel',
        authors: [{ name: 'Andy Weir' }],
        description: 'New description',
        coverUrl: 'https://new.com/cover.jpg',
        publishedDate: '2021-05-04',
        series: [{ name: 'New Series', position: 1 }],
        duration: 970,
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      // enrichmentStatus, updatedAt, and the Audnexus cover override (#1634); all
      // other fill-empty fields keep fill-empty semantics and are untouched.
      expect(setCall).toHaveProperty('enrichmentStatus', 'enriched');
      expect(setCall).toHaveProperty('updatedAt');
      expect(setCall).toHaveProperty('coverUrl', 'https://new.com/cover.jpg');
      expect(setCall).not.toHaveProperty('title');
      expect(setCall).not.toHaveProperty('description');
      expect(setCall).not.toHaveProperty('publishedDate');
      expect(setCall).not.toHaveProperty('seriesName');
      expect(setCall).not.toHaveProperty('seriesPosition');
      expect(setCall).not.toHaveProperty('duration');
    });
  });

  describe('stale-enrichment guard (#1129)', () => {
    it('genres path: drops write when row asin no longer matches captured asin', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD' }]))                          // candidates
        .mockReturnValueOnce(mockDbChain([{                                                    // existing
          duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null,
          publishedDate: null, seriesName: null, seriesPosition: null,
        }]))
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_NEW', userClearedFields: null }]));       // in-tx precondition re-read (#2069 AC11)

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'X',
        authors: [{ name: 'A' }],
        genres: ['Fantasy'],
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // The whole write transaction aborts now, not just the genres arm — and the
      // candidate is NOT counted or logged as enriched (#2069 AC11).
      expect(bookService.update).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, asin: 'B_OLD' }),
        'stale enrichment dropped (identity re-read)',
      );
      expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Book enriched successfully');
    });

    it('genres path: writes when row asin still matches captured asin', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_SAME' }]))                         // candidates
        .mockReturnValueOnce(mockDbChain([{
          duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null,
          publishedDate: null, seriesName: null, seriesPosition: null,
        }]))
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_SAME', userClearedFields: null }]));      // in-tx precondition re-read (#2069 AC11)

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'X',
        authors: [{ name: 'A' }],
        genres: ['Fantasy'],
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.update).toHaveBeenCalledWith(1, { genres: ['Fantasy'] }, { tx: expect.anything() });
    });

    it('narrators path: drops inserts when row asin no longer matches captured asin', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD' }]))                          // candidates
        .mockReturnValueOnce(mockDbChain([{
          duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null,
          publishedDate: null, seriesName: null, seriesPosition: null,
        }]))
        // no genres in result → skip genres path entirely (no isStillSameAsin select)
        .mockReturnValueOnce(mockDbChain([]))                                                  // existingNarrators
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_NEW' }]));                                // isStillSameAsin (narrators)

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'X',
        authors: [{ name: 'A' }],
        narrators: ['Some Narrator'],
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.insert.mockReturnValue(mockDbChain());

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(db.insert).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, asin: 'B_OLD' }),
        'stale enrichment dropped (narrators)',
      );
    });

    it('scalar UPDATE is scoped WHERE id = ? AND asin = capturedAsin (logs debug when 0 rows match)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD' }]))                          // candidates
        .mockReturnValueOnce(mockDbChain([{
          duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null,
          publishedDate: null, seriesName: null, seriesPosition: null,
        }]));

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'X',
        authors: [{ name: 'A' }],
        description: 'desc',
      });
      // .returning() resolves to [] (default) → no rows matched → stale-write debug log
      db.update.mockReturnValue(mockDbChain([]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, asin: 'B_OLD' }),
        'stale enrichment dropped (scalar update)',
      );
    });
  });

  // ── #1627 Guarded failure writes (Fix-Match race + unique-constraint abort) ──
  describe('guarded failure writes (#1627)', () => {
    it('collision-failed stale-drop: drops the failed-mark and logs when the row was re-identified mid-flight', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD', title: 'Dupe', author: 'Author' }]));  // candidates

      metadataService.resolveBook.mockResolvedValueOnce({
        asin: 'B_OWNED', title: 'Dupe', authors: [{ name: 'Author' }], duration: 700,
      });
      bookService.findAsinCollision.mockResolvedValueOnce({ conflictBookId: 99, conflictTitle: 'Other' });
      // Guarded failed-mark matches 0 rows → Fix Match swapped the row to B_NEW.
      db.update.mockReturnValue(mockDbChain([]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // Built with the captured-ASIN guard + .returning({ id }); 0 rows → stale-drop, not failed.
      const failedChain = db.update();
      const collisionWhere = failedChain.where.mock.calls[0]![0];
      expect(whereSql(collisionWhere)).toContain('"id"');
      expect(whereSql(collisionWhere)).toContain('"asin"');     // captured-ASIN guard, not id-only
      expect(whereParams(collisionWhere)).toEqual([1, 'B_OLD']); // candidate.id + capturedAsin
      expect(failedChain.returning.mock.calls[0]![0]).toHaveProperty('id');
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, asin: 'B_OLD' }),
        'stale enrichment dropped (collision)',
      );
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'Resolved ASIN collides with an existing book — marking failed',
      );
    });

    it('no-match stale-drop: drops the failed-mark and logs when the row was re-identified mid-flight', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD', title: 'Some Book', author: 'Author' }]));  // candidates

      metadataService.resolveBook.mockResolvedValueOnce(null);
      // Guarded failed-mark matches 0 rows.
      db.update.mockReturnValue(mockDbChain([]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const noMatchWhere = db.update().where.mock.calls[0]![0];
      expect(whereSql(noMatchWhere)).toContain('"id"');
      expect(whereSql(noMatchWhere)).toContain('"asin"');     // captured-ASIN guard, not id-only
      expect(whereParams(noMatchWhere)).toEqual([1, 'B_OLD']);
      expect(db.update().returning.mock.calls[0]![0]).toHaveProperty('id');
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, asin: 'B_OLD' }),
        'stale enrichment dropped (no-match)',
      );
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'Book enrichment failed',
      );
    });

    it('unique-constraint recovery: marks the candidate failed, logs the error, and continues the batch', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: 'B_OLD', title: 'Race', author: 'Author' },
          { id: 2, asin: 'B_TWO', title: 'Next', author: 'Author' },
        ]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Race', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing (candidate 1)

      // Candidate 1 recovers a different ASIN; the point-in-time collision check is
      // clean but a concurrent writer takes it before the scalar write lands.
      metadataService.resolveBook
        .mockResolvedValueOnce({ asin: 'B_OWNED', title: 'Race', authors: [{ name: 'Author' }], description: 'desc' })
        .mockResolvedValueOnce(null);  // candidate 2 → no-match
      bookService.findAsinCollision.mockResolvedValueOnce(null);

      const recoveryChain = mockDbChain([{ id: 1 }]);  // guarded recovery matches the row
      db.update
        .mockReturnValueOnce(mockDbChain([], { error: new Error('UNIQUE constraint failed: books.asin') }))  // scalar write throws
        .mockReturnValueOnce(recoveryChain)                                                                   // recovery → mark failed
        .mockReturnValueOnce(mockDbChain([{ id: 2 }]));                                                       // candidate 2 no-match write

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // Recovery write marked candidate 1 failed (guarded set).
      const recoverySet = recoveryChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(recoverySet).toHaveProperty('enrichmentStatus', 'failed');
      // Caught error logged (via serializeError → object), not the raw error.
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, resolvedAsin: 'B_OWNED', error: expect.any(Object) }),
        'Resolved ASIN hit a unique-constraint race — marking failed',
      );
      // The batch continued — candidate 2 was still processed.
      expect(metadataService.resolveBook).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith({ bookId: 2, asin: 'B_TWO' }, 'Book enrichment failed');
    });

    it('unique-constraint recovery: detects the violation when the ASIN UNIQUE text is only in error.cause.message', async () => {
      // Drizzle/libSQL nests the SQLite message under `.cause` — the top-level
      // message is generic. If isAsinUniqueViolation only checked error.message,
      // this would rethrow and abort the batch instead of recovering.
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: 'B_OLD', title: 'Race', author: 'Author' },
          { id: 2, asin: 'B_TWO', title: 'Next', author: 'Author' },
        ]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Race', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing (candidate 1)

      metadataService.resolveBook
        .mockResolvedValueOnce({ asin: 'B_OWNED', title: 'Race', authors: [{ name: 'Author' }], description: 'desc' })
        .mockResolvedValueOnce(null);  // candidate 2 → no-match
      bookService.findAsinCollision.mockResolvedValueOnce(null);

      // Generic top-level message; the ASIN UNIQUE text lives only under .cause.
      const nestedCauseError = new Error('SQLITE_CONSTRAINT: constraint failed');
      (nestedCauseError as Error & { cause?: unknown }).cause = {
        message: 'UNIQUE constraint failed: books.asin',
      };
      const recoveryChain = mockDbChain([{ id: 1 }]);
      db.update
        .mockReturnValueOnce(mockDbChain([], { error: nestedCauseError }))  // scalar write throws nested-cause unique error
        .mockReturnValueOnce(recoveryChain)                                 // recovery → mark failed
        .mockReturnValueOnce(mockDbChain([{ id: 2 }]));                     // candidate 2 no-match write

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // Nested-cause violation was recognized → guarded recovery marked failed.
      const recoverySet = recoveryChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(recoverySet).toHaveProperty('enrichmentStatus', 'failed');
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, resolvedAsin: 'B_OWNED', error: expect.any(Object) }),
        'Resolved ASIN hit a unique-constraint race — marking failed',
      );
      // Batch continued rather than aborting on the nested-cause error.
      expect(metadataService.resolveBook).toHaveBeenCalledTimes(2);
    });

    it('unique-constraint recovery stale-drop: drops the failed-mark when Fix Match swapped the identity after the throw', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: 'B_OLD', title: 'Race', author: 'Author' },
          { id: 2, asin: 'B_TWO', title: 'Next', author: 'Author' },
        ]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Race', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing (candidate 1)

      metadataService.resolveBook
        .mockResolvedValueOnce({ asin: 'B_OWNED', title: 'Race', authors: [{ name: 'Author' }], description: 'desc' })
        .mockResolvedValueOnce(null);  // candidate 2 → no-match
      bookService.findAsinCollision.mockResolvedValueOnce(null);

      const recoveryChain = mockDbChain([]);  // guarded recovery matches 0 rows → identity swapped
      db.update
        .mockReturnValueOnce(mockDbChain([], { error: new Error('UNIQUE constraint failed: idx_books_asin_unique') }))  // scalar write throws
        .mockReturnValueOnce(recoveryChain)                                                                              // recovery → 0 rows
        .mockReturnValueOnce(mockDbChain([{ id: 2 }]));                                                                  // candidate 2 no-match write

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // The guarded recovery write is scoped to the captured ASIN, not id-only.
      const recoveryWhere = recoveryChain.where.mock.calls[0]![0];
      expect(whereSql(recoveryWhere)).toContain('"id"');
      expect(whereSql(recoveryWhere)).toContain('"asin"');
      expect(whereParams(recoveryWhere)).toEqual([1, 'B_OLD']);
      expect(recoveryChain.returning.mock.calls[0]![0]).toHaveProperty('id');
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, asin: 'B_OLD' }),
        'stale enrichment dropped (unique recovery)',
      );
      // Loop continued without marking the new identity failed.
      expect(metadataService.resolveBook).toHaveBeenCalledTimes(2);
    });

    it('negative guard: a non-unique-constraint UPDATE error is rethrown, not swallowed', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD', title: 'Race', author: 'Author' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Race', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

      metadataService.resolveBook.mockResolvedValueOnce({ title: 'Race', authors: [{ name: 'Author' }], description: 'desc' });
      db.update.mockReturnValue(mockDbChain([], { error: new Error('SQLITE_BUSY: database is locked') }));

      await expect(
        runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log)),
      ).rejects.toThrow('SQLITE_BUSY');
    });
  });

  // ── #1622 Audiobook resolution fallback (resolveBook + ASIN writeback) ──
  describe('audiobook resolution fallback (#1622)', () => {
    it('writes back the resolved audiobook ASIN when the search recovers a different ASIN', async () => {
      // A previously-failed book with a bad (print/Kindle) ASIN; the resolver
      // searches and returns the real audiobook ASIN, which must be persisted so
      // the next cycle stops retrying the dead ASIN.
      const updateChain = mockDbChain([{ id: 1 }]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: '1338589016', title: 'Catching Fire', isbn: null, author: 'Suzanne Collins' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Catching Fire', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

      metadataService.resolveBook.mockResolvedValueOnce({
        asin: 'B009SP2WO5', title: 'Catching Fire', authors: [{ name: 'Suzanne Collins' }], duration: 700,
      });
      bookService.findAsinCollision.mockResolvedValueOnce(null);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.findAsinCollision).toHaveBeenCalledWith(1, 'B009SP2WO5');
      // The scalar UPDATE set includes the new audiobook ASIN
      const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(setArg).toHaveProperty('asin', 'B009SP2WO5');
      expect(log.info).toHaveBeenCalledWith({ bookId: 1, asin: 'B009SP2WO5' }, 'Book enriched successfully');
    });

    it('canonicalizes a lowercase resolved ASIN before the collision check and scalar write (#1733)', async () => {
      // The resolver may hand back a lowercase ASIN; the background write boundary
      // must uppercase it (canonicalizeAsin) BEFORE both findAsinCollision and the
      // scalar UPDATE, so the case-insensitive identity holds at the job level too.
      // Guards line 307 against regressing to `result.asin ?? null` (which would pass
      // the lowercase value straight through both calls).
      const updateChain = mockDbChain([{ id: 1 }]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B001', title: 'New Edition', isbn: null, author: 'Author' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'New Edition', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

      metadataService.resolveBook.mockResolvedValueOnce({
        asin: 'b0newedition', title: 'New Edition', authors: [{ name: 'Author' }], duration: 700,
      });
      bookService.findAsinCollision.mockResolvedValueOnce(null);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // Collision check receives the canonical (uppercase) ASIN, not the raw lowercase value.
      expect(bookService.findAsinCollision).toHaveBeenCalledWith(1, 'B0NEWEDITION');
      // The scalar UPDATE persists the canonical ASIN.
      const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(setArg).toHaveProperty('asin', 'B0NEWEDITION');
    });

    it('does NOT write the ASIN and marks the row failed when the resolved ASIN collides with another book', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_BAD', title: 'Dupe', isbn: null, author: 'Author' }]));  // candidates

      metadataService.resolveBook.mockResolvedValueOnce({
        asin: 'B_OWNED', title: 'Dupe', authors: [{ name: 'Author' }], duration: 700,
      });
      bookService.findAsinCollision.mockResolvedValueOnce({ conflictBookId: 99, conflictTitle: 'Other' });
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // Only the failed-status update should fire; no audiobook ASIN written.
      const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(setArg).toHaveProperty('enrichmentStatus', 'failed');
      expect(setArg).not.toHaveProperty('asin');
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, resolvedAsin: 'B_OWNED', conflictBookId: 99 }),
        'Resolved ASIN collides with an existing book — marking failed',
      );
    });

    it('null-ASIN row: persists the resolved ASIN + fields via the null-safe predicate (F6)', async () => {
      const updateChain = mockDbChain([{ id: 1 }]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: null, title: 'NYT Book', isbn: '9780000000', author: 'Author' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'NYT Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

      metadataService.resolveBook.mockResolvedValueOnce({
        asin: 'B_FOUND', title: 'NYT Book', authors: [{ name: 'Author' }], duration: 800,
      });
      bookService.findAsinCollision.mockResolvedValueOnce(null);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // The captured ASIN was null → the scalar update must still match the row
      // (isNull predicate) and persist the resolved ASIN + duration.
      const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(setArg).toHaveProperty('asin', 'B_FOUND');
      expect(setArg).toHaveProperty('duration', 800);
      expect(log.debug).not.toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1 }),
        'stale enrichment dropped (scalar update)',
      );
    });

    it('breaks the batch when resolveBook throws RateLimitError (incl. fallback-search rate limits)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: null, title: 'A', isbn: null, author: null },
          { id: 2, asin: null, title: 'B', isbn: null, author: null },
        ]));  // candidates

      metadataService.resolveBook.mockRejectedValueOnce(new RateLimitError(30000, 'Audible.com'));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // First throws → break; second never attempted; rate-limited row NOT marked failed.
      expect(metadataService.resolveBook).toHaveBeenCalledTimes(1);
      expect(db.update).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'Audible.com', retryAfterMs: 30000 }),
        'Rate limited during enrichment — remaining candidates stay pending',
      );
    });

    it('#1628: a transient resolveBook error leaves the candidate unchanged (NOT failed) and continues the batch', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: null, title: 'A', isbn: null, author: null },
          { id: 2, asin: null, title: 'B', isbn: null, author: null },
        ]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'B', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing fields for book 2

      // First candidate throws a transient provider failure; second succeeds.
      metadataService.resolveBook
        .mockRejectedValueOnce(new TransientError('Audible.com', 'HTTP 503'))
        .mockResolvedValueOnce({ title: 'B', authors: [{ name: 'Found' }], duration: 100 });
      const updateChain = mockDbChain([{ id: 2 }]);
      db.update.mockReturnValue(updateChain);

      // The batch must NOT throw — a transient is not a fatal error.
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // Both candidates attempted (continue, not break); the transient row was
      // never marked failed (no update set enrichmentStatus 'failed').
      expect(metadataService.resolveBook).toHaveBeenCalledTimes(2);
      const failedSets = updateChain.set.mock.calls.filter(
        (c: unknown[]) => (c[0] as Record<string, unknown>).enrichmentStatus === 'failed',
      );
      expect(failedSets).toHaveLength(0);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1 }),
        'Transient provider error during enrichment — leaving candidate for next cycle',
      );
    });

    it('#1628: a generic resolveBook error is also transient — candidate not failed, batch does not throw', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: null, title: 'A', isbn: null, author: null }]));  // candidates

      metadataService.resolveBook.mockRejectedValueOnce(new Error('Network error'));
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // No 'failed' write for the transiently-erroring row.
      const failedSets = updateChain.set.mock.calls.filter(
        (c: unknown[]) => (c[0] as Record<string, unknown>).enrichmentStatus === 'failed',
      );
      expect(failedSets).toHaveLength(0);
    });
  });

  // ── #1630 Enrichment robustness: re-queue skipped, cap retries ──
  describe('retry cap + skipped re-queue (#1630)', () => {
    it('candidate query re-queues skipped rows and caps maxed-out failed rows', async () => {
      // Capture the candidate-query `.where()` predicate and serialize it so a
      // regression that drops the cap or the skipped branch fails the assertion.
      const candChain = mockDbChain([]);
      db.select.mockReturnValueOnce(candChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const candWhere = candChain.where.mock.calls[0]![0];
      const sql = whereSql(candWhere);
      const params = whereParams(candWhere);
      // Pre-existing 'skipped' rows flow through the search rescue once.
      expect(params).toContain('skipped');
      // The failed branch is capped on the persisted attempt counter.
      expect(sql).toContain('"enrichment_attempts"');
      expect(sql).toContain('"enrichment_attempts" < ?');
      // The cap constant (5) is bound — distinct from the retry-threshold timestamp.
      expect(params).toContain(5);
      // Existing pending + failed branches survive.
      expect(params).toContain('pending');
      expect(params).toContain('failed');
    });

    it('no-match increments enrichment_attempts alongside the failed status, keeping the captured-ASIN guard', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_CAP', title: 'Unresolvable', author: 'Author' }]));  // candidates

      metadataService.resolveBook.mockResolvedValueOnce(null);
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(setArg).toHaveProperty('enrichmentStatus', 'failed');
      // The attempt counter is incremented via a `col + 1` SQL expression.
      expect(setArg.enrichmentAttempts).toBeDefined();
      expect(whereSql(setArg.enrichmentAttempts)).toContain('"enrichment_attempts" + 1');
      // The guarded write still carries the captured-ASIN guard (#1627).
      const where = updateChain.where.mock.calls[0]![0];
      expect(whereSql(where)).toContain('"asin"');
      expect(whereParams(where)).toEqual([1, 'B_CAP']);
    });

    it('collision-failed increments enrichment_attempts through the shared guarded helper', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD', title: 'Dupe', author: 'Author' }]));  // candidates

      metadataService.resolveBook.mockResolvedValueOnce({
        asin: 'B_OWNED', title: 'Dupe', authors: [{ name: 'Author' }], duration: 700,
      });
      bookService.findAsinCollision.mockResolvedValueOnce({ conflictBookId: 99, conflictTitle: 'Other' });
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(setArg).toHaveProperty('enrichmentStatus', 'failed');
      expect(whereSql(setArg.enrichmentAttempts)).toContain('"enrichment_attempts" + 1');
    });
  });

});

// ─── #2069: scheduled enrichment honors the operator's explicit clears ───
//
// Every case below observes the `.set(...)` argument the write transaction
// ACTUALLY issued, not the payload built beforehand — the suppression happens
// inside the transaction, after the tombstone re-read, so an assertion on the
// pre-transaction object would pass against an implementation that never
// suppressed anything.
describe('enrichment job — user-cleared fields (#2069)', () => {
  let db: ReturnType<typeof createMockDb>;
  let metadataService: { resolveBook: ReturnType<typeof vi.fn> };
  let bookService: { update: ReturnType<typeof vi.fn>; findAsinCollision: ReturnType<typeof vi.fn>; trackUnmatchedGenres: ReturnType<typeof vi.fn> };
  let log: ReturnType<typeof createMockLogger>;
  let updateChain: ReturnType<typeof mockDbChain>;

  /** Every clearable scalar empty, so each fill is reachable. */
  const emptyExisting = {
    duration: null, genres: null, title: 'Tress of the Emerald Sea', subtitle: null,
    description: null, publisher: null, coverUrl: null, publishedDate: null,
    seriesName: null, seriesPosition: null,
  };

  /** A provider result that fills every clearable field plus the carve-outs. */
  const fullResult = {
    title: 'Tress of the Emerald Sea',
    authors: [{ name: 'Brandon Sanderson' }],
    subtitle: 'A Cosmere Novel',
    description: 'Provider description',
    publisher: 'Dragonsteel',
    publishedDate: '2023-01-10',
    coverUrl: 'https://example.test/cover.jpg',
    duration: 600,
    genres: ['Fantasy'],
    seriesPrimary: { name: 'Secret Projects', position: 1 },
  };

  /**
   * Drive one candidate through the pass with the given stored tombstone column.
   * Returns the `.set(...)` payload the scalar UPDATE was issued with.
   */
  async function runWithTombstones(raw: string | null, existing: Record<string, unknown> = emptyExisting): Promise<Record<string, unknown>> {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_CLEARED' }]))            // candidates
      .mockReturnValueOnce(mockDbChain([existing]))                                // existing fill-empty inputs
      .mockReturnValueOnce(mockDbChain([{ asin: 'B_CLEARED', userClearedFields: raw }])); // in-tx precondition re-read
    metadataService.resolveBook.mockResolvedValueOnce(fullResult);

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    return updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
  }

  beforeEach(() => {
    db = createMockDb();
    metadataService = { resolveBook: vi.fn().mockResolvedValue(null) };
    bookService = { update: vi.fn().mockResolvedValue(null), findAsinCollision: vi.fn().mockResolvedValue(null), trackUnmatchedGenres: vi.fn().mockResolvedValue(undefined) };
    log = createMockLogger();
    updateChain = mockDbChain([{ id: 1 }]);
    db.update.mockReturnValue(updateChain);
  });

  it('a seriesName tombstone writes NEITHER seriesName nor seriesPosition (the pair rule)', async () => {
    const set = await runWithTombstones('["seriesName"]');

    expect(set).not.toHaveProperty('seriesName');
    expect(set).not.toHaveProperty('seriesPosition');
    expect(set.enrichmentStatus).toBe('enriched');
  });

  it('suppresses only the tombstoned scalars while untombstoned siblings still fill in the same pass', async () => {
    const set = await runWithTombstones('["description","publisher"]');

    expect(set).not.toHaveProperty('description');
    expect(set).not.toHaveProperty('publisher');
    // The over-broad-filter guard: these are in the same fill list and must land.
    expect(set.subtitle).toBe('A Cosmere Novel');
    expect(set.publishedDate).toBe('2023-01-10');
    expect(set.seriesName).toBe('Secret Projects');
  });

  it('suppresses subtitle and publishedDate independently', async () => {
    const set = await runWithTombstones('["publishedDate","subtitle"]');

    expect(set).not.toHaveProperty('subtitle');
    expect(set).not.toHaveProperty('publishedDate');
    expect(set.description).toBe('Provider description');
    expect(set.publisher).toBe('Dragonsteel');
  });

  it('a genres tombstone skips the genres write entirely', async () => {
    await runWithTombstones('["genres"]');

    expect(bookService.update).not.toHaveBeenCalled();
  });

  it('keeps the coverUrl overwrite and the duration fill for a seriesName-tombstoned book (carve-outs intact)', async () => {
    const set = await runWithTombstones('["seriesName"]');

    expect(set.coverUrl).toBe('https://example.test/cover.jpg');
    expect(set.duration).toBe(600);
    expect(set.title).toBeUndefined(); // not ALL CAPS, so no title rewrite — unchanged behavior
  });

  it('a malformed persisted set degrades to "no tombstones" and the pass fills normally', async () => {
    const set = await runWithTombstones('{oops');

    expect(set.seriesName).toBe('Secret Projects');
    expect(set.publisher).toBe('Dragonsteel');
    expect(bookService.update).toHaveBeenCalledWith(1, { genres: ['Fantasy'] }, { tx: expect.anything() });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 1 }),
      expect.stringContaining('Unparseable userClearedFields'),
    );
  });

  it('a recognized-plus-unknown set suppresses the recognized field and still lands the rest (AC4)', async () => {
    const set = await runWithTombstones('["genres","futureField"]');

    expect(bookService.update).not.toHaveBeenCalled();
    expect(set.enrichmentStatus).toBe('enriched');
    expect(set.publisher).toBe('Dragonsteel');
  });

  it('AC12: a book with no tombstones fills exactly as today', async () => {
    const set = await runWithTombstones(null);

    expect(set.seriesName).toBe('Secret Projects');
    expect(set.seriesPosition).toBe(1);
    expect(set.subtitle).toBe('A Cosmere Novel');
    expect(bookService.update).toHaveBeenCalledWith(1, { genres: ['Fantasy'] }, { tx: expect.anything() });
  });

  // ─── #2152 AC8: the seriesPosition tombstone writes null, it does not skip ───
  describe('a seriesPosition tombstone (#2152 AC8)', () => {
    /** The orphan shape `fillSeriesFields` exists for: no stored name, stale position. */
    const orphanPosition: Record<string, unknown> = { ...emptyExisting, seriesName: null, seriesPosition: 7 };
    const storedName: Record<string, unknown> = { ...emptyExisting, seriesName: 'Custom Saga', seriesPosition: 7 };

    it('writes the provider name with seriesPosition NULL, not the provider number', async () => {
      const set = await runWithTombstones('["seriesPosition"]', orphanPosition);

      expect(set.seriesName).toBe('Secret Projects');
      expect(set).toHaveProperty('seriesPosition', null);
    });

    it('control: the SAME fixture without the tombstone writes the provider position', async () => {
      const set = await runWithTombstones(null, orphanPosition);

      expect(set.seriesName).toBe('Secret Projects');
      expect(set.seriesPosition).toBe(1);
    });

    it('writes null rather than DELETING the key, so the stale orphan cannot survive', async () => {
      // Deleting the key would leave the stored `7` sitting beside the fresh
      // provider name — exactly the position-without-series shape the pair rule
      // and #2152 exist to remove.
      const set = await runWithTombstones('["seriesPosition"]', orphanPosition);

      expect(Object.keys(set)).toContain('seriesPosition');
      expect(set.seriesPosition).toBeNull();
    });

    it('leaves every untombstoned sibling fill alone', async () => {
      const set = await runWithTombstones('["seriesPosition"]', orphanPosition);

      expect(set.subtitle).toBe('A Cosmere Novel');
      expect(set.publisher).toBe('Dragonsteel');
      expect(set.description).toBe('Provider description');
      expect(set.enrichmentStatus).toBe('enriched');
    });

    it('composes with the seriesName tombstone: BOTH lands the same row as seriesName alone', async () => {
      const both = await runWithTombstones('["seriesName","seriesPosition"]', orphanPosition);
      const nameOnly = await runWithTombstones('["seriesName"]', orphanPosition);

      expect(both).not.toHaveProperty('seriesName');
      expect(both).not.toHaveProperty('seriesPosition');
      expect('seriesPosition' in both).toBe('seriesPosition' in nameOnly);
      expect('seriesName' in both).toBe('seriesName' in nameOnly);
    });

    it('is bounded by what fillSeriesFields prepared — a stored name means NEITHER field is written', async () => {
      // Unchanged existing behavior, not a new rule: enrichment never overwrites a
      // stored pair, so the column survives the pass whatever the tombstone says.
      const set = await runWithTombstones('["seriesPosition"]', storedName);

      expect(set).not.toHaveProperty('seriesName');
      expect(set).not.toHaveProperty('seriesPosition');
    });
  });

  it('a suppressed fill is a DECISION, not a failure — the candidate is still counted enriched', async () => {
    await runWithTombstones('["description","genres","publisher","publishedDate","seriesName","subtitle"]');

    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_CLEARED' },
      'Book enriched successfully',
    );
    // …and a suppressed fill is not REPORTED as filled.
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ enrichedCount: 1, filledGenres: 0, filledDescription: 0 }),
      'Enrichment batch completed',
    );
  });

  describe('F21 / F5 — the genre telemetry is a DEFERRED post-commit effect', () => {
    it('runs the telemetry with the written payload, AFTER the write transaction resolves', async () => {
      const order: string[] = [];
      db.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const result = await cb(db);
        order.push('tx-committed');
        return result;
      });
      bookService.trackUnmatchedGenres.mockImplementation(async () => { order.push('telemetry'); });

      await runWithTombstones(null);

      expect(bookService.trackUnmatchedGenres).toHaveBeenCalledWith(['Fantasy']);
      // The ordering is the whole point: `update`'s caller-owned-tx arm emits no
      // post-commit effects, so running this BEFORE the commit would strand it on a
      // rollback. Observing the transaction's own resolution — not statement
      // issuance — is what makes this assertion able to fail.
      expect(order).toEqual(['tx-committed', 'telemetry']);
    });

    it('records nothing when the genre fill was suppressed by a tombstone', async () => {
      await runWithTombstones('["genres"]');

      expect(bookService.update).not.toHaveBeenCalled();
      expect(bookService.trackUnmatchedGenres).not.toHaveBeenCalled();
    });

    it('records nothing when the candidate is stale-dropped', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_CLEARED' }]))
        .mockReturnValueOnce(mockDbChain([emptyExisting]))
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_REIDENTIFIED', userClearedFields: null }]));
      metadataService.resolveBook.mockResolvedValueOnce(fullResult);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.trackUnmatchedGenres).not.toHaveBeenCalled();
    });

    it('a telemetry failure is non-fatal — the candidate still counts as enriched', async () => {
      bookService.trackUnmatchedGenres.mockRejectedValueOnce(new Error('telemetry boom'));

      await runWithTombstones(null);

      expect(log.info).toHaveBeenCalledWith(
        { bookId: 1, asin: 'B_CLEARED' },
        'Book enriched successfully',
      );
    });
  });

  describe('AC11 — the tombstone read and the writes share one transaction', () => {
    it('sees a clear that commits after the provider fetch but before the write transaction opens', async () => {
      // The pre-transaction `existing` read still shows an empty series; the clear
      // lands as the transaction opens. Reading the set before the transaction (or
      // reusing the `existing` row) would write the provider series back.
      let stored: string | null = null;
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_RACE' }]))
        .mockReturnValueOnce(mockDbChain([emptyExisting]))
        .mockImplementation(() => mockDbChain([{ asin: 'B_RACE', userClearedFields: stored }]));
      db.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        stored = '["seriesName"]';
        return cb(db);
      });
      metadataService.resolveBook.mockResolvedValueOnce(fullResult);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const set = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(set).not.toHaveProperty('seriesName');
      expect(set).not.toHaveProperty('seriesPosition');
      // A suppressed field is a decision, not a failure — the status still advances.
      expect(set.enrichmentStatus).toBe('enriched');
    });

    it('the genres write runs on the transaction handle, never opening a nested one', async () => {
      await runWithTombstones(null);

      const [, , options] = bookService.update.mock.calls[0] as [number, unknown, { tx: unknown }];
      expect(options.tx).toBeDefined();
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('negative control: with nothing committing in the window the write lands normally', async () => {
      const set = await runWithTombstones('["subtitle"]');

      expect(set).not.toHaveProperty('subtitle');
      expect(set.description).toBe('Provider description');
      expect(set.enrichmentStatus).toBe('enriched');
    });
  });
});
