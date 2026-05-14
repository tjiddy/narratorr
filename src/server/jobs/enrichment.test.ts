import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitError } from '../../core/index.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { MetadataService } from '../services/metadata.service.js';
import type { BookService } from '../services/book.service.js';

import { runEnrichment } from './enrichment.js';

describe('enrichment job', () => {
  let db: ReturnType<typeof createMockDb>;
  let metadataService: { enrichBook: ReturnType<typeof vi.fn> };
  let bookService: { update: ReturnType<typeof vi.fn> };
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    db = createMockDb();
    metadataService = { enrichBook: vi.fn().mockResolvedValue(null) };
    bookService = { update: vi.fn().mockResolvedValue(null) };
    log = createMockLogger();
  });

  it('marks books without ASIN as skipped', async () => {
    // First select: no-asin books
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1 }, { id: 2 }]))  // no-asin query
      .mockReturnValueOnce(mockDbChain([]));  // candidates query (empty)

    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(db.update).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith({ count: 2 }, 'Books without ASIN marked as skipped');
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
      .mockReturnValueOnce(mockDbChain([]))  // no-asin query
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B003P2WO5E' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing book fields

    metadataService.enrichBook.mockResolvedValueOnce(enrichedData);
    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(metadataService.enrichBook).toHaveBeenCalledWith('B003P2WO5E');
    expect(db.update).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B003P2WO5E' },
      'Book enriched successfully',
    );
  });

  it('marks book as failed when enrichment returns null', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B000BROKEN' }]));  // candidates

    metadataService.enrichBook.mockResolvedValueOnce(null);
    db.update.mockReturnValue(mockDbChain());

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
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B003P2WO5E' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: 1234, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    metadataService.enrichBook.mockResolvedValueOnce(enrichedData);
    db.update.mockReturnValue(mockDbChain());

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
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([]));  // candidates (none)

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(metadataService.enrichBook).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('enriches with only narrators (no duration) from Audnexus', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_PARTIAL' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    metadataService.enrichBook.mockResolvedValueOnce({
      title: 'Partial Book',
      authors: [{ name: 'Author' }],
      narrators: ['Jim Dale'],
      // no duration field
    });
    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_PARTIAL' },
      'Book enriched successfully',
    );
  });

  it('enriches with only duration (no narrators) from Audnexus', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_DUR_ONLY' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    metadataService.enrichBook.mockResolvedValueOnce({
      title: 'Duration Only',
      authors: [{ name: 'Author' }],
      duration: 480,
      // no narrators field
    });
    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_DUR_ONLY' },
      'Book enriched successfully',
    );
  });

  it('handles empty narrators array without setting narrator field', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_EMPTY_NARR' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    metadataService.enrichBook.mockResolvedValueOnce({
      title: 'Empty Narrators',
      authors: [{ name: 'Author' }],
      narrators: [],  // empty array — should not set narrator
      duration: 300,
    });
    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    // Still enriched (status updated), but narrator shouldn't be set from empty array
    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_EMPTY_NARR' },
      'Book enriched successfully',
    );
  });

  it('does not call enrichBook for no-ASIN books', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1 }, { id: 2 }]))  // no-asin query
      .mockReturnValueOnce(mockDbChain([]));  // candidates (empty)

    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(metadataService.enrichBook).not.toHaveBeenCalled();
  });

  it('treats narrators: undefined differently from narrators: [] (undefined skips, empty array skips)', async () => {
    // narrators: undefined — the `result.narrators?.length` check short-circuits via optional chaining
    db.select
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_UNDEF_NARR' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    metadataService.enrichBook.mockResolvedValueOnce({
      title: 'Undefined Narrators',
      authors: [{ name: 'Author' }],
      // narrators key entirely absent → undefined
      duration: 600,
    });
    db.update.mockReturnValue(mockDbChain());

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
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_MISSING' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([]));  // existing book fields — empty!

    metadataService.enrichBook.mockResolvedValueOnce({
      title: 'Ghost Book',
      authors: [{ name: 'Author' }],
      narrators: ['Some Narrator'],
      duration: 500,
    });
    db.update.mockReturnValue(mockDbChain());

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
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_ALL_NULL' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

    // enrichBook returns a result object but with no narrators and no duration
    metadataService.enrichBook.mockResolvedValueOnce({
      title: null,
      authors: null,
      narrators: undefined,
      duration: undefined,
    });
    db.update.mockReturnValue(mockDbChain());

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
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([
        { id: 1, asin: 'B001' },
        { id: 2, asin: 'B002' },
        { id: 3, asin: 'B003' },
      ]));  // candidates

    // First enrichment succeeds, second throws rate limit
    metadataService.enrichBook
      .mockResolvedValueOnce({ title: 'Book 1', authors: [], narrators: ['Narrator'], duration: 100 })
      .mockRejectedValueOnce(new RateLimitError(30000, 'Audnexus'));

    db.select.mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing book fields for book 1
    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    // Only first book's enrichment should have been processed, second throws, third skipped
    expect(metadataService.enrichBook).toHaveBeenCalledTimes(2);
    expect(metadataService.enrichBook).toHaveBeenCalledWith('B001');
    expect(metadataService.enrichBook).toHaveBeenCalledWith('B002');
    // Third book should NOT have been called
    expect(metadataService.enrichBook).not.toHaveBeenCalledWith('B003');

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'Audnexus', retryAfterMs: 30000 }),
      'Rate limited during enrichment — remaining candidates stay pending',
    );
  });

  // ── #229 Observability — batch completion logging ───────────────────────
  describe('batch completion logging (#229)', () => {
    it('enrichment batch completion log includes elapsedMs', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // no-asin
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B003P2WO5E' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

      metadataService.enrichBook.mockResolvedValueOnce({
        title: 'Book', authors: [{ name: 'Author' }], duration: 600,
      });
      db.update.mockReturnValue(mockDbChain());

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ elapsedMs: expect.any(Number) }),
        'Enrichment batch completed',
      );
    });

    it('enrichment batch completion log includes filled flags (duration, narrators)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // no-asin
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B003P2WO5E' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing: both empty

      metadataService.enrichBook.mockResolvedValueOnce({
        title: 'Book', authors: [{ name: 'Author' }],
        narrators: ['Jim Dale'],
        duration: 600,
      });
      db.update.mockReturnValue(mockDbChain());
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
        .mockReturnValueOnce(mockDbChain([]))  // no-asin
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_NAR_FAIL' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

      metadataService.enrichBook.mockResolvedValueOnce({
        title: 'Book', authors: [{ name: 'Author' }],
        narrators: ['Failing Narrator', 'Good Narrator'],
        duration: 600,
      });
      db.update.mockReturnValue(mockDbChain());

      // narrator lookup: no existing narrators in junction table
      db.select.mockReturnValueOnce(mockDbChain([]));

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
        .mockReturnValueOnce(mockDbChain([]))  // no-asin
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_GENRE' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing: genres null

      metadataService.enrichBook.mockResolvedValueOnce({
        title: 'Genre Book', authors: [{ name: 'Author' }],
        genres: ['Fantasy', 'Science Fiction'],
      });
      db.update.mockReturnValue(mockDbChain());

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.update).toHaveBeenCalledWith(1, { genres: ['Fantasy', 'Science Fiction'] });
    });

    it('persists genres via bookService.update() when book has empty array genres in DB', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // no-asin
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_GENRE_EMPTY' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: [], title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing: genres empty array

      metadataService.enrichBook.mockResolvedValueOnce({
        title: 'Genre Book', authors: [{ name: 'Author' }],
        genres: ['Mystery'],
      });
      db.update.mockReturnValue(mockDbChain());

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.update).toHaveBeenCalledWith(1, { genres: ['Mystery'] });
    });

    it('does NOT update genres when book already has non-empty genres', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // no-asin
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_HAS_GENRES' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: ['Existing Genre'], title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing: has genres

      metadataService.enrichBook.mockResolvedValueOnce({
        title: 'Genre Book', authors: [{ name: 'Author' }],
        genres: ['New Genre'],
      });
      db.update.mockReturnValue(mockDbChain());

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.update).not.toHaveBeenCalled();
    });

    it('does NOT update genres when enrichBook returns no genres (undefined)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // no-asin
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_NO_GENRE' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

      metadataService.enrichBook.mockResolvedValueOnce({
        title: 'No Genre Book', authors: [{ name: 'Author' }],
        duration: 600,
        // genres undefined
      });
      db.update.mockReturnValue(mockDbChain());

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.update).not.toHaveBeenCalled();
    });

    it('does NOT update genres when enrichBook returns empty genres array', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // no-asin
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_EMPTY_GENRE' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing

      metadataService.enrichBook.mockResolvedValueOnce({
        title: 'Empty Genre Book', authors: [{ name: 'Author' }],
        genres: [],
      });
      db.update.mockReturnValue(mockDbChain());

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.update).not.toHaveBeenCalled();
    });

    it('increments filledGenres counter only when genres are actually filled', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // no-asin
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: 'B_FILL' },
          { id: 2, asin: 'B_SKIP' },
        ]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]))  // book 1: no genres
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: ['Existing'], title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // book 2: has genres

      metadataService.enrichBook
        .mockResolvedValueOnce({ title: 'Book 1', authors: [], genres: ['Fantasy'] })
        .mockResolvedValueOnce({ title: 'Book 2', authors: [], genres: ['New Genre'] });
      db.update.mockReturnValue(mockDbChain());

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ filledGenres: 1 }),
        'Enrichment batch completed',
      );
    });

    it('includes filledGenres in batch completion log message', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // no-asin
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_LOG' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

      metadataService.enrichBook.mockResolvedValueOnce({
        title: 'Book', authors: [{ name: 'Author' }], duration: 600,
      });
      db.update.mockReturnValue(mockDbChain());

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ filledGenres: expect.any(Number) }),
        'Enrichment batch completed',
      );
    });
  });

  // ── #398 Title normalization (ALL CAPS guard) ─────────────────────────
  describe('title normalization (#398)', () => {
    const allFields = { duration: null, genres: null, title: 'PROJECT HAIL MARY', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null };

    function setupEnrichment(existingFields: Record<string, unknown>, enrichedData: Record<string, unknown>) {
      db.select
        .mockReturnValueOnce(mockDbChain([]))  // no-asin
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_TITLE' }]))  // candidates
        .mockReturnValueOnce(mockDbChain([{ ...allFields, ...existingFields }]));  // existing
      metadataService.enrichBook.mockResolvedValueOnce({ title: 'Enriched', authors: [{ name: 'Author' }], ...enrichedData });
      db.update.mockReturnValue(mockDbChain());
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
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_DESC' }]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, ...existingFields }]));
      metadataService.enrichBook.mockResolvedValueOnce({ title: 'Book', authors: [{ name: 'Author' }], ...enrichedData });
      db.update.mockReturnValue(mockDbChain());
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

  // ── #398 Cover URL fill ───────────────────────────────────────────────
  describe('cover URL fill (#398)', () => {
    const allFields = { duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null };

    function setupEnrichment(existingFields: Record<string, unknown>, enrichedData: Record<string, unknown>) {
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_COVER' }]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, ...existingFields }]));
      metadataService.enrichBook.mockResolvedValueOnce({ title: 'Book', authors: [{ name: 'Author' }], ...enrichedData });
      db.update.mockReturnValue(mockDbChain());
    }

    it('fills coverUrl when currently null', async () => {
      setupEnrichment({ coverUrl: null }, { coverUrl: 'https://example.com/cover.jpg' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('coverUrl', 'https://example.com/cover.jpg');
    });

    it('does NOT overwrite existing coverUrl', async () => {
      setupEnrichment({ coverUrl: 'https://existing.com/cover.jpg' }, { coverUrl: 'https://new.com/cover.jpg' });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('coverUrl');
    });
  });

  // ── #398 Published date fill ──────────────────────────────────────────
  describe('published date fill (#398)', () => {
    const allFields = { duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null };

    function setupEnrichment(existingFields: Record<string, unknown>, enrichedData: Record<string, unknown>) {
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_DATE' }]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, ...existingFields }]));
      metadataService.enrichBook.mockResolvedValueOnce({ title: 'Book', authors: [{ name: 'Author' }], ...enrichedData });
      db.update.mockReturnValue(mockDbChain());
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
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_SERIES' }]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, ...existingFields }]));
      metadataService.enrichBook.mockResolvedValueOnce({ title: 'Book', authors: [{ name: 'Author' }], ...enrichedData });
      db.update.mockReturnValue(mockDbChain());
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

    it('does NOT overwrite existing seriesName', async () => {
      setupEnrichment({ seriesName: 'Existing Series', seriesPosition: 3 }, { series: [{ name: 'New Series', position: 1 }] });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('seriesName');
    });

    it('fills seriesPosition independently when seriesName exists but seriesPosition is null', async () => {
      setupEnrichment({ seriesName: 'The Stormlight Archive', seriesPosition: null }, { series: [{ name: 'The Stormlight Archive', position: 1 }] });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('seriesName');
      expect(setCall).toHaveProperty('seriesPosition', 1);
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
        .mockReturnValueOnce(mockDbChain([]))  // no-asin
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: 'B_T1' },
          { id: 2, asin: 'B_T2' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, title: 'PROJECT HAIL MARY' }]))  // book 1: ALL CAPS
        .mockReturnValueOnce(mockDbChain([{ ...allFields, title: 'Already Good' }]));  // book 2: mixed case

      metadataService.enrichBook
        .mockResolvedValueOnce({ title: 'Project Hail Mary', authors: [] })
        .mockResolvedValueOnce({ title: 'Already Good', authors: [] });
      db.update.mockReturnValue(mockDbChain());

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ filledTitle: 1 }),
        'Enrichment batch completed',
      );
    });

    it('increments filledDescription only when description is actually filled', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: 'B_D1' },
          { id: 2, asin: 'B_D2' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, description: null }]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, description: 'Existing' }]));

      metadataService.enrichBook
        .mockResolvedValueOnce({ title: 'Book 1', authors: [], description: 'New desc' })
        .mockResolvedValueOnce({ title: 'Book 2', authors: [], description: 'Another desc' });
      db.update.mockReturnValue(mockDbChain());

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ filledDescription: 1 }),
        'Enrichment batch completed',
      );
    });

    it('existing filledDuration/filledNarrators/filledGenres still work', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_ALL' }]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, duration: null }]));

      metadataService.enrichBook.mockResolvedValueOnce({
        title: 'Book', authors: [{ name: 'Author' }],
        duration: 600,
        genres: ['Fantasy'],
        narrators: ['Jim Dale'],
      });
      db.update.mockReturnValue(mockDbChain());
      db.insert.mockReturnValue(mockDbChain([]));
      // narrator lookup: no existing narrators
      db.select.mockReturnValueOnce(mockDbChain([]));
      // findOrCreateNarrator: not found, insert
      db.select.mockReturnValueOnce(mockDbChain([]));

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
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_FULL' }]))
        .mockReturnValueOnce(mockDbChain([emptyFields]));

      metadataService.enrichBook.mockResolvedValueOnce({
        title: 'Project Hail Mary',
        authors: [{ name: 'Andy Weir' }],
        description: 'An astronaut wakes up alone',
        coverUrl: 'https://example.com/cover.jpg',
        publishedDate: '2021-05-04',
        series: [{ name: 'Standalone', position: 1 }],
        duration: 970,
      });
      db.update.mockReturnValue(mockDbChain());

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
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_PROJ' }]))
        .mockReturnValueOnce(mockDbChain([emptyFields]));

      metadataService.enrichBook.mockResolvedValueOnce({
        title: 'Project Hail Mary', authors: [{ name: 'Author' }],
      });
      db.update.mockReturnValue(mockDbChain());

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // The third db.select() call is the existing-fields lookup — assert its projection
      const projectionArg = db.select.mock.calls[2]![0];
      expect(projectionArg).toHaveProperty('duration');
      expect(projectionArg).toHaveProperty('genres');
      expect(projectionArg).toHaveProperty('title');
      expect(projectionArg).toHaveProperty('description');
      expect(projectionArg).toHaveProperty('coverUrl');
      expect(projectionArg).toHaveProperty('publishedDate');
      expect(projectionArg).toHaveProperty('seriesName');
      expect(projectionArg).toHaveProperty('seriesPosition');
    });

    it('does not overwrite any fields when all already populated', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_FULL2' }]))
        .mockReturnValueOnce(mockDbChain([{
          duration: 900, genres: ['Sci-Fi'], title: 'Project Hail Mary',
          description: 'Existing', coverUrl: 'https://old.com/c.jpg',
          publishedDate: '2020-01-01', seriesName: 'Old Series', seriesPosition: 2,
        }]));

      metadataService.enrichBook.mockResolvedValueOnce({
        title: 'Project Hail Mary: A Novel',
        authors: [{ name: 'Andy Weir' }],
        description: 'New description',
        coverUrl: 'https://new.com/cover.jpg',
        publishedDate: '2021-05-04',
        series: [{ name: 'New Series', position: 1 }],
        duration: 970,
      });
      db.update.mockReturnValue(mockDbChain());

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      // Only enrichmentStatus and updatedAt should be in the update
      expect(setCall).toHaveProperty('enrichmentStatus', 'enriched');
      expect(setCall).toHaveProperty('updatedAt');
      expect(setCall).not.toHaveProperty('title');
      expect(setCall).not.toHaveProperty('description');
      expect(setCall).not.toHaveProperty('coverUrl');
      expect(setCall).not.toHaveProperty('publishedDate');
      expect(setCall).not.toHaveProperty('seriesName');
      expect(setCall).not.toHaveProperty('seriesPosition');
      expect(setCall).not.toHaveProperty('duration');
    });
  });

});
