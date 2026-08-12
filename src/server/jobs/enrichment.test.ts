import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { RateLimitError, TransientError } from '@core/index.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { MetadataService } from '../services/metadata.service.js';
import type { BookService } from '../services/book.service.js';

import { runEnrichment } from './enrichment.js';

// Serialize the real predicate so an id-only guard cannot satisfy these assertions.
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
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: null, title: 'No ASIN Book', author: 'Some Author' }]))
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'No ASIN Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

    metadataService.resolveBook.mockResolvedValueOnce({ title: 'No ASIN Book', authors: [{ name: 'Some Author' }], duration: 600 });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(metadataService.resolveBook).toHaveBeenCalledWith({ asin: undefined, title: 'No ASIN Book', author: 'Some Author' });
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Books without ASIN marked as skipped');
  });

  it('calls resolveBook title-only when the candidate has no author row', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: null, title: 'Authorless Book', author: null }]))
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Authorless Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

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

    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B003P2WO5E' }]))
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

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
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B000BROKEN' }]));

    metadataService.resolveBook.mockResolvedValueOnce(null);
    // The guarded no-match write returns a row, so this is a genuine failure.
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
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B003P2WO5E' }]))
      .mockReturnValueOnce(mockDbChain([{ duration: 1234, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

    metadataService.resolveBook.mockResolvedValueOnce(enrichedData);
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(db.update).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B003P2WO5E' },
      'Book enriched successfully',
    );
  });

  it('does nothing when no candidates exist', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(metadataService.resolveBook).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('enriches with only narrators (no duration) from Audnexus', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_PARTIAL' }]))
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

    metadataService.resolveBook.mockResolvedValueOnce({
      title: 'Partial Book',
      authors: [{ name: 'Author' }],
      narrators: ['Jim Dale'],
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
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_DUR_ONLY' }]))
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

    metadataService.resolveBook.mockResolvedValueOnce({
      title: 'Duration Only',
      authors: [{ name: 'Author' }],
      duration: 480,
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
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_EMPTY_NARR' }]))
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

    metadataService.resolveBook.mockResolvedValueOnce({
      title: 'Empty Narrators',
      authors: [{ name: 'Author' }],
      narrators: [],
      duration: 300,
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_EMPTY_NARR' },
      'Book enriched successfully',
    );
  });

  it('does not call resolveBook when there are no candidates at all', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([]));

    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(metadataService.resolveBook).not.toHaveBeenCalled();
  });

  it('treats narrators: undefined differently from narrators: [] (undefined skips, empty array skips)', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_UNDEF_NARR' }]))
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

    metadataService.resolveBook.mockResolvedValueOnce({
      title: 'Undefined Narrators',
      authors: [{ name: 'Author' }],
      duration: 600,
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_UNDEF_NARR' },
      'Book enriched successfully',
    );
  });

  it('handles empty existing array from DB query (existing.length === 0)', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_MISSING' }]))
      .mockReturnValueOnce(mockDbChain([]));

    metadataService.resolveBook.mockResolvedValueOnce({
      title: 'Ghost Book',
      authors: [{ name: 'Author' }],
      narrators: ['Some Narrator'],
      duration: 500,
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(db.update).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_MISSING' },
      'Book enriched successfully',
    );
  });

  it('sets enrichmentStatus to enriched even when metadata returns null for all optional fields', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_ALL_NULL' }]))
      .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

    metadataService.resolveBook.mockResolvedValueOnce({
      title: null,
      authors: null,
      narrators: undefined,
      duration: undefined,
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(db.update).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_ALL_NULL' },
      'Book enriched successfully',
    );
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
      ]));

    metadataService.resolveBook
      .mockResolvedValueOnce({ title: 'Book 1', authors: [], narrators: ['Narrator'], duration: 100 })
      .mockRejectedValueOnce(new RateLimitError(30000, 'Audnexus'));

    db.select.mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

    expect(metadataService.resolveBook).toHaveBeenCalledTimes(2);
    expect(metadataService.resolveBook).toHaveBeenCalledWith(expect.objectContaining({ asin: 'B001' }));
    expect(metadataService.resolveBook).toHaveBeenCalledWith(expect.objectContaining({ asin: 'B002' }));
    expect(metadataService.resolveBook).not.toHaveBeenCalledWith(expect.objectContaining({ asin: 'B003' }));

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'Audnexus', retryAfterMs: 30000 }),
      'Rate limited during enrichment — remaining candidates stay pending',
    );
  });

  describe('batch completion logging (#229)', () => {
    it('enrichment batch completion log includes elapsedMs', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B003P2WO5E' }]))
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
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B003P2WO5E' }]))
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

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
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_NAR_FAIL' }]))
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

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

      // select: not found
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValueOnce(mockDbChain(undefined, { error: new Error('UNIQUE constraint') }));
      // retry select: also empty → throws
      db.select.mockReturnValueOnce(mockDbChain([]));

      // select: not found
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 55 }]));

      const junctionChain = mockDbChain([]);
      db.insert.mockReturnValueOnce(junctionChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(junctionChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, narratorId: 55, position: 1 }),
      );

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ filledNarrators: 1 }),
        'Enrichment batch completed',
      );
    });
  });

  describe('genre persistence', () => {
    it('persists genres via bookService.update() when book has null genres in DB', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_GENRE' }]))
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]))
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_GENRE' }]));  // in-tx precondition re-read

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
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_GENRE_EMPTY' }]))
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: [], title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]))
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_GENRE_EMPTY' }]));  // in-tx precondition re-read

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
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_HAS_GENRES' }]))
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: ['Existing Genre'], title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

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
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_NO_GENRE' }]))
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'No Genre Book', authors: [{ name: 'Author' }],
        duration: 600,
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.update).not.toHaveBeenCalled();
    });

    it('does NOT update genres when resolveBook returns empty genres array', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_EMPTY_GENRE' }]))
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

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
        ]))
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: null, title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]))  // book 1 existing
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_FILL', userClearedFields: null }]))  // book 1 transaction guard
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: ['Existing'], title: 'Some Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]))  // book 2 existing
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_SKIP', userClearedFields: null }]));  // book 2 transaction guard

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
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_LOG' }]))
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

  describe('subtitle/publisher fill-empty (#1614)', () => {
    it('fills blank subtitle and publisher from the enrichment result', async () => {
      const updateChain = mockDbChain([{ id: 1 }]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_FILL_SP' }]))
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: ['x'], title: 'Some Book', subtitle: null, description: null, publisher: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

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
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_KEEP_SP' }]))
        .mockReturnValueOnce(mockDbChain([{ duration: 600, genres: ['x'], title: 'Some Book', subtitle: 'Existing Subtitle', description: null, publisher: 'Existing Publisher', coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

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

  describe('title normalization (#398)', () => {
    const allFields = { duration: null, genres: null, title: 'PROJECT HAIL MARY', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null };

    function setupEnrichment(existingFields: Record<string, unknown>, enrichedData: Record<string, unknown>) {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_TITLE' }]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, ...existingFields }]));
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
      setupEnrichment(
        { coverUrl: 'https://assets.hardcover.app/edition/30615590/print.jpg' },
        { coverUrl: 'https://m.media-amazon.com/images/I/81bRC7xFElL.jpg' },
      );
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('coverUrl', 'https://m.media-amazon.com/images/I/81bRC7xFElL.jpg');
    });

    it('preserves the existing cover when Audnexus returns no image', async () => {
      setupEnrichment({ coverUrl: 'https://existing.com/cover.jpg' }, { coverUrl: undefined });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('coverUrl');
    });

    it('keeps fill-empty semantics for sibling fields while overriding the cover', async () => {
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

    it('stored seriesName present + position present → writes NEITHER field (#1927 AC10)', async () => {
      setupEnrichment({ seriesName: 'Custom Saga', seriesPosition: 3 }, { series: [{ name: 'Provider Saga', position: 15 }] });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('seriesName');
      expect(setCall).not.toHaveProperty('seriesPosition');
    });

    it('stored seriesName present + position null → position NOT back-filled (#1927 AC10 reverses the old independent fill)', async () => {
      setupEnrichment({ seriesName: 'Custom Saga', seriesPosition: null }, { series: [{ name: 'Provider Saga', position: 15 }] });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).not.toHaveProperty('seriesName');
      expect(setCall).not.toHaveProperty('seriesPosition');
    });

    it('orphan { seriesName: null, seriesPosition: 5 } → BOTH written atomically, stale position overwritten (#1927 AC10/F11)', async () => {
      setupEnrichment({ seriesName: null, seriesPosition: 5 }, { series: [{ name: 'Provider Saga', position: 15 }] });
      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
      const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
      expect(setCall).toHaveProperty('seriesName', 'Provider Saga');
      expect(setCall).toHaveProperty('seriesPosition', 15);
    });

    it('orphan { seriesName: null, seriesPosition: 5 } vs metadata with NO position → position CLEARED to null (#1927 AC10)', async () => {
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

    // A whitespace-only provider name passed the bare truthiness guard and blank-named the book (#2224).
    describe('an unusable provider series name is skipped, not written (#2224)', () => {
      const UNUSABLE = [
        ['empty string', ''],
        ['spaces', '   '],
        ['tab + newline', '\t\n'],
        ['non-breaking space', '\u00A0'],
      ] as const;

      it.each(UNUSABLE)('%s: writes neither seriesName nor seriesPosition', async (_label, name) => {
        setupEnrichment({ seriesName: null, seriesPosition: null }, { series: [{ name, position: 2 }] });
        await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
        const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
        expect(setCall).not.toHaveProperty('seriesName');
        expect(setCall).not.toHaveProperty('seriesPosition');
      });

      // Skip, not clear: the usable-name path above deliberately overwrites an orphan position.
      it('leaves a pre-existing orphan seriesPosition untouched rather than pairing or clearing it', async () => {
        setupEnrichment({ seriesName: null, seriesPosition: 5 }, { series: [{ name: '   ', position: 2 }] });
        await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
        const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
        expect(setCall).not.toHaveProperty('seriesName');
        expect(setCall).not.toHaveProperty('seriesPosition');
      });

      it('a blank canonical primary means "no series", never a fallback to series[0]', async () => {
        setupEnrichment({ seriesName: null, seriesPosition: null }, {
          seriesPrimary: { name: '   ', position: 2 },
          series: [{ name: 'The Cosmere', position: 5 }],
        });
        await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
        const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
        expect(setCall).not.toHaveProperty('seriesName');
        expect(setCall).not.toHaveProperty('seriesPosition');
      });

      it('the rest of the enrichment still applies — a blank series is a skipped field, not a failed run', async () => {
        setupEnrichment(
          { seriesName: null, seriesPosition: null, duration: null, description: null, coverUrl: null },
          {
            series: [{ name: '   ', position: 2 }],
            duration: 2700,
            description: 'An epic doorstopper.',
            coverUrl: 'https://example.com/cover.jpg',
          },
        );
        await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));
        const setCall = db.update.mock.results[0]!.value.set.mock.calls[0][0];
        expect(setCall).toHaveProperty('duration', 2700);
        expect(setCall).toHaveProperty('description', 'An epic doorstopper.');
        expect(setCall).toHaveProperty('coverUrl', 'https://example.com/cover.jpg');
        expect(setCall).toHaveProperty('enrichmentStatus', 'enriched');
      });
    });
  });

  describe('counter tracking (#398)', () => {
    const allFields = { duration: null, genres: null, title: 'PROJECT HAIL MARY', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null };

    it('increments filledTitle only when title is actually updated', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: 'B_T1' },
          { id: 2, asin: 'B_T2' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ ...allFields, title: 'PROJECT HAIL MARY' }]))  // book 1: ALL CAPS
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_T1', userClearedFields: null }]))  // book 1 transaction guard
        .mockReturnValueOnce(mockDbChain([{ ...allFields, title: 'Already Good' }]))  // book 2: mixed case
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_T2', userClearedFields: null }]));  // book 2 transaction guard

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
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_D1', userClearedFields: null }]))  // book 1 transaction guard
        .mockReturnValueOnce(mockDbChain([{ ...allFields, description: 'Existing' }]))
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_D2', userClearedFields: null }]));  // book 2 transaction guard

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
      // in-tx precondition re-read — LAST, after the narrator block
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

      // The first select finds candidates; the second is the fill projection.
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
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD' }]))
        .mockReturnValueOnce(mockDbChain([{
          duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null,
          publishedDate: null, seriesName: null, seriesPosition: null,
        }]))
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_NEW', userClearedFields: null }]));       // in-tx precondition re-read

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'X',
        authors: [{ name: 'A' }],
        genres: ['Fantasy'],
      });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      // Identity mismatch aborts the whole write transaction, not just genres.
      expect(bookService.update).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, asin: 'B_OLD' }),
        'stale enrichment dropped (identity re-read)',
      );
      expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Book enriched successfully');
    });

    it('genres path: writes when row asin still matches captured asin', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_SAME' }]))
        .mockReturnValueOnce(mockDbChain([{
          duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null,
          publishedDate: null, seriesName: null, seriesPosition: null,
        }]))
        .mockReturnValueOnce(mockDbChain([{ asin: 'B_SAME', userClearedFields: null }]));      // in-tx precondition re-read

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
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD' }]))
        .mockReturnValueOnce(mockDbChain([{
          duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null,
          publishedDate: null, seriesName: null, seriesPosition: null,
        }]))
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
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD' }]))
        .mockReturnValueOnce(mockDbChain([{
          duration: null, genres: null, title: 'Some Book', description: null, coverUrl: null,
          publishedDate: null, seriesName: null, seriesPosition: null,
        }]));

      metadataService.resolveBook.mockResolvedValueOnce({
        title: 'X',
        authors: [{ name: 'A' }],
        description: 'desc',
      });
      // Empty returning() simulates a stale guarded write.
      db.update.mockReturnValue(mockDbChain([]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, asin: 'B_OLD' }),
        'stale enrichment dropped (scalar update)',
      );
    });
  });

  describe('guarded failure writes (#1627)', () => {
    it('collision-failed stale-drop: drops the failed-mark and logs when the row was re-identified mid-flight', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD', title: 'Dupe', author: 'Author' }]));

      metadataService.resolveBook.mockResolvedValueOnce({
        asin: 'B_OWNED', title: 'Dupe', authors: [{ name: 'Author' }], duration: 700,
      });
      bookService.findAsinCollision.mockResolvedValueOnce({ conflictBookId: 99, conflictTitle: 'Other' });
      // Zero returned rows simulate Fix Match winning.
      db.update.mockReturnValue(mockDbChain([]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const failedChain = db.update();
      const collisionWhere = failedChain.where.mock.calls[0]![0];
      expect(whereSql(collisionWhere)).toContain('"id"');
      expect(whereSql(collisionWhere)).toContain('"asin"');
      expect(whereParams(collisionWhere)).toEqual([1, 'B_OLD']);
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
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD', title: 'Some Book', author: 'Author' }]));

      metadataService.resolveBook.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const noMatchWhere = db.update().where.mock.calls[0]![0];
      expect(whereSql(noMatchWhere)).toContain('"id"');
      expect(whereSql(noMatchWhere)).toContain('"asin"');
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
        ]))
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Race', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing (candidate 1)

      // The collision check passes, then the scalar write loses a uniqueness race.
      metadataService.resolveBook
        .mockResolvedValueOnce({ asin: 'B_OWNED', title: 'Race', authors: [{ name: 'Author' }], description: 'desc' })
        .mockResolvedValueOnce(null);  // candidate 2 → no-match
      bookService.findAsinCollision.mockResolvedValueOnce(null);

      const recoveryChain = mockDbChain([{ id: 1 }]);  // guarded recovery matches
      db.update
        .mockReturnValueOnce(mockDbChain([], { error: new Error('UNIQUE constraint failed: books.asin') }))  // raced scalar write
        .mockReturnValueOnce(recoveryChain)                                                                   // guarded recovery
        .mockReturnValueOnce(mockDbChain([{ id: 2 }]));                                                       // candidate 2 no-match

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const recoverySet = recoveryChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(recoverySet).toHaveProperty('enrichmentStatus', 'failed');
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, resolvedAsin: 'B_OWNED', error: expect.any(Object) }),
        'Resolved ASIN hit a unique-constraint race — marking failed',
      );
      expect(metadataService.resolveBook).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith({ bookId: 2, asin: 'B_TWO' }, 'Book enrichment failed');
    });

    it('unique-constraint recovery: detects the violation when the ASIN UNIQUE text is only in error.cause.message', async () => {
      // libSQL nests the SQLite constraint text under cause.
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: 'B_OLD', title: 'Race', author: 'Author' },
          { id: 2, asin: 'B_TWO', title: 'Next', author: 'Author' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Race', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing (candidate 1)

      metadataService.resolveBook
        .mockResolvedValueOnce({ asin: 'B_OWNED', title: 'Race', authors: [{ name: 'Author' }], description: 'desc' })
        .mockResolvedValueOnce(null);  // candidate 2 → no-match
      bookService.findAsinCollision.mockResolvedValueOnce(null);

      const nestedCauseError = new Error('SQLITE_CONSTRAINT: constraint failed');
      (nestedCauseError as Error & { cause?: unknown }).cause = {
        message: 'UNIQUE constraint failed: books.asin',
      };
      const recoveryChain = mockDbChain([{ id: 1 }]);
      db.update
        .mockReturnValueOnce(mockDbChain([], { error: nestedCauseError }))  // nested-cause conflict
        .mockReturnValueOnce(recoveryChain)                                 // guarded recovery
        .mockReturnValueOnce(mockDbChain([{ id: 2 }]));                     // candidate 2 no-match

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const recoverySet = recoveryChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(recoverySet).toHaveProperty('enrichmentStatus', 'failed');
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, resolvedAsin: 'B_OWNED', error: expect.any(Object) }),
        'Resolved ASIN hit a unique-constraint race — marking failed',
      );
      expect(metadataService.resolveBook).toHaveBeenCalledTimes(2);
    });

    it('unique-constraint recovery stale-drop: drops the failed-mark when Fix Match swapped the identity after the throw', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, asin: 'B_OLD', title: 'Race', author: 'Author' },
          { id: 2, asin: 'B_TWO', title: 'Next', author: 'Author' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Race', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // existing (candidate 1)

      metadataService.resolveBook
        .mockResolvedValueOnce({ asin: 'B_OWNED', title: 'Race', authors: [{ name: 'Author' }], description: 'desc' })
        .mockResolvedValueOnce(null);  // candidate 2 → no-match
      bookService.findAsinCollision.mockResolvedValueOnce(null);

      const recoveryChain = mockDbChain([]);  // identity swapped
      db.update
        .mockReturnValueOnce(mockDbChain([], { error: new Error('UNIQUE constraint failed: idx_books_asin_unique') }))  // raced scalar write
        .mockReturnValueOnce(recoveryChain)                                                                              // guarded recovery
        .mockReturnValueOnce(mockDbChain([{ id: 2 }]));                                                                  // candidate 2 no-match

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const recoveryWhere = recoveryChain.where.mock.calls[0]![0];
      expect(whereSql(recoveryWhere)).toContain('"id"');
      expect(whereSql(recoveryWhere)).toContain('"asin"');
      expect(whereParams(recoveryWhere)).toEqual([1, 'B_OLD']);
      expect(recoveryChain.returning.mock.calls[0]![0]).toHaveProperty('id');
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, asin: 'B_OLD' }),
        'stale enrichment dropped (unique recovery)',
      );
      expect(metadataService.resolveBook).toHaveBeenCalledTimes(2);
    });

    it('negative guard: a non-unique-constraint UPDATE error is rethrown, not swallowed', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD', title: 'Race', author: 'Author' }]))
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Race', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

      metadataService.resolveBook.mockResolvedValueOnce({ title: 'Race', authors: [{ name: 'Author' }], description: 'desc' });
      db.update.mockReturnValue(mockDbChain([], { error: new Error('SQLITE_BUSY: database is locked') }));

      await expect(
        runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log)),
      ).rejects.toThrow('SQLITE_BUSY');
    });
  });

  describe('audiobook resolution fallback (#1622)', () => {
    it('writes back the resolved audiobook ASIN when the search recovers a different ASIN', async () => {
      const updateChain = mockDbChain([{ id: 1 }]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: '1338589016', title: 'Catching Fire', isbn: null, author: 'Suzanne Collins' }]))
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'Catching Fire', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

      metadataService.resolveBook.mockResolvedValueOnce({
        asin: 'B009SP2WO5', title: 'Catching Fire', authors: [{ name: 'Suzanne Collins' }], duration: 700,
      });
      bookService.findAsinCollision.mockResolvedValueOnce(null);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.findAsinCollision).toHaveBeenCalledWith(1, 'B009SP2WO5');
      const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(setArg).toHaveProperty('asin', 'B009SP2WO5');
      expect(log.info).toHaveBeenCalledWith({ bookId: 1, asin: 'B009SP2WO5' }, 'Book enriched successfully');
    });

    it('canonicalizes a lowercase resolved ASIN before the collision check and scalar write (#1733)', async () => {
      const updateChain = mockDbChain([{ id: 1 }]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B001', title: 'New Edition', isbn: null, author: 'Author' }]))
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'New Edition', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

      metadataService.resolveBook.mockResolvedValueOnce({
        asin: 'b0newedition', title: 'New Edition', authors: [{ name: 'Author' }], duration: 700,
      });
      bookService.findAsinCollision.mockResolvedValueOnce(null);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      expect(bookService.findAsinCollision).toHaveBeenCalledWith(1, 'B0NEWEDITION');
      const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(setArg).toHaveProperty('asin', 'B0NEWEDITION');
    });

    it('does NOT write the ASIN and marks the row failed when the resolved ASIN collides with another book', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_BAD', title: 'Dupe', isbn: null, author: 'Author' }]));

      metadataService.resolveBook.mockResolvedValueOnce({
        asin: 'B_OWNED', title: 'Dupe', authors: [{ name: 'Author' }], duration: 700,
      });
      bookService.findAsinCollision.mockResolvedValueOnce({ conflictBookId: 99, conflictTitle: 'Other' });
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

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
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: null, title: 'NYT Book', isbn: '9780000000', author: 'Author' }]))
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'NYT Book', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));

      metadataService.resolveBook.mockResolvedValueOnce({
        asin: 'B_FOUND', title: 'NYT Book', authors: [{ name: 'Author' }], duration: 800,
      });
      bookService.findAsinCollision.mockResolvedValueOnce(null);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

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
        ]));

      metadataService.resolveBook.mockRejectedValueOnce(new RateLimitError(30000, 'Audible.com'));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

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
        ]))
        .mockReturnValueOnce(mockDbChain([{ duration: null, genres: null, title: 'B', description: null, coverUrl: null, publishedDate: null, seriesName: null, seriesPosition: null }]));  // book 2 existing

      metadataService.resolveBook
        .mockRejectedValueOnce(new TransientError('Audible.com', 'HTTP 503'))
        .mockResolvedValueOnce({ title: 'B', authors: [{ name: 'Found' }], duration: 100 });
      const updateChain = mockDbChain([{ id: 2 }]);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

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
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: null, title: 'A', isbn: null, author: null }]));

      metadataService.resolveBook.mockRejectedValueOnce(new Error('Network error'));
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const failedSets = updateChain.set.mock.calls.filter(
        (c: unknown[]) => (c[0] as Record<string, unknown>).enrichmentStatus === 'failed',
      );
      expect(failedSets).toHaveLength(0);
    });
  });

  describe('retry cap + skipped re-queue (#1630)', () => {
    it('candidate query re-queues skipped rows and caps maxed-out failed rows', async () => {
      const candChain = mockDbChain([]);
      db.select.mockReturnValueOnce(candChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const candWhere = candChain.where.mock.calls[0]![0];
      const sql = whereSql(candWhere);
      const params = whereParams(candWhere);
      expect(params).toContain('skipped');
      expect(sql).toContain('"enrichment_attempts"');
      expect(sql).toContain('"enrichment_attempts" < ?');
      expect(params).toContain(5);
      expect(params).toContain('pending');
      expect(params).toContain('failed');
    });

    it('no-match increments enrichment_attempts alongside the failed status, keeping the captured-ASIN guard', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_CAP', title: 'Unresolvable', author: 'Author' }]));

      metadataService.resolveBook.mockResolvedValueOnce(null);
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);

      await runEnrichment(inject<Db>(db), inject<MetadataService>(metadataService), inject<BookService>(bookService), inject<FastifyBaseLogger>(log));

      const setArg = updateChain.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(setArg).toHaveProperty('enrichmentStatus', 'failed');
      expect(setArg.enrichmentAttempts).toBeDefined();
      expect(whereSql(setArg.enrichmentAttempts)).toContain('"enrichment_attempts" + 1');
      const where = updateChain.where.mock.calls[0]![0];
      expect(whereSql(where)).toContain('"asin"');
      expect(whereParams(where)).toEqual([1, 'B_CAP']);
      // #2202: a held ambiguous window arrives here as a plain null, so the write must carry no
      // metadata — nothing about the candidates the resolver declined may leak onto the row.
      expect(Object.keys(setArg).sort()).toEqual(['enrichmentAttempts', 'enrichmentStatus', 'updatedAt']);
      expect(bookService.update).not.toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledTimes(1);
    });

    it('collision-failed increments enrichment_attempts through the shared guarded helper', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_OLD', title: 'Dupe', author: 'Author' }]));

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

// Assert the actual scalar payload; tombstones are applied after the transaction re-read.
describe('enrichment job — user-cleared fields (#2069)', () => {
  let db: ReturnType<typeof createMockDb>;
  let metadataService: { resolveBook: ReturnType<typeof vi.fn> };
  let bookService: { update: ReturnType<typeof vi.fn>; findAsinCollision: ReturnType<typeof vi.fn>; trackUnmatchedGenres: ReturnType<typeof vi.fn> };
  let log: ReturnType<typeof createMockLogger>;
  let updateChain: ReturnType<typeof mockDbChain>;

  const emptyExisting = {
    duration: null, genres: null, title: 'Tress of the Emerald Sea', subtitle: null,
    description: null, publisher: null, coverUrl: null, publishedDate: null,
    seriesName: null, seriesPosition: null,
  };

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

  async function runWithTombstones(raw: string | null, existing: Record<string, unknown> = emptyExisting): Promise<Record<string, unknown>> {
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_CLEARED' }]))
      .mockReturnValueOnce(mockDbChain([existing]))
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
    expect(set.title).toBeUndefined(); // Not ALL CAPS, so no title rewrite.
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

  describe('a seriesPosition tombstone (#2152 AC8)', () => {
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
    // Suppressed fills do not increment fill counters.
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
      // Observe transaction resolution, not merely statement issuance.
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
      // The clear lands when the transaction opens, after the stale fill-empty read.
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
