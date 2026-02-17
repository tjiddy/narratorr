import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitError } from '@narratorr/core';
import { createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';
import { runEnrichment } from './enrichment.js';

describe('enrichment job', () => {
  let db: ReturnType<typeof createMockDb>;
  let metadataService: { enrichBook: ReturnType<typeof vi.fn> };
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    db = createMockDb();
    metadataService = { enrichBook: vi.fn().mockResolvedValue(null) };
    log = createMockLogger();
  });

  it('marks books without ASIN as skipped', async () => {
    // First select: no-asin books
    db.select
      .mockReturnValueOnce(mockDbChain([{ id: 1 }, { id: 2 }]))  // no-asin query
      .mockReturnValueOnce(mockDbChain([]));  // candidates query (empty)

    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(db as any, metadataService as any, log as any);

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
      .mockReturnValueOnce(mockDbChain([{ narrator: null, duration: null }]));  // existing book fields

    metadataService.enrichBook.mockResolvedValueOnce(enrichedData);
    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(db as any, metadataService as any, log as any);

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

    await runEnrichment(db as any, metadataService as any, log as any);

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
      .mockReturnValueOnce(mockDbChain([{ narrator: 'Existing Narrator', duration: 1234 }]));  // existing

    metadataService.enrichBook.mockResolvedValueOnce(enrichedData);
    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(db as any, metadataService as any, log as any);

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

    await runEnrichment(db as any, metadataService as any, log as any);

    expect(metadataService.enrichBook).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('enriches with only narrators (no duration) from Audnexus', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_PARTIAL' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ narrator: null, duration: null }]));  // existing

    metadataService.enrichBook.mockResolvedValueOnce({
      title: 'Partial Book',
      authors: [{ name: 'Author' }],
      narrators: ['Jim Dale'],
      // no duration field
    });
    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(db as any, metadataService as any, log as any);

    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_PARTIAL' },
      'Book enriched successfully',
    );
  });

  it('enriches with only duration (no narrators) from Audnexus', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_DUR_ONLY' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ narrator: null, duration: null }]));  // existing

    metadataService.enrichBook.mockResolvedValueOnce({
      title: 'Duration Only',
      authors: [{ name: 'Author' }],
      duration: 480,
      // no narrators field
    });
    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(db as any, metadataService as any, log as any);

    expect(log.info).toHaveBeenCalledWith(
      { bookId: 1, asin: 'B_DUR_ONLY' },
      'Book enriched successfully',
    );
  });

  it('handles empty narrators array without setting narrator field', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_EMPTY_NARR' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ narrator: null, duration: null }]));  // existing

    metadataService.enrichBook.mockResolvedValueOnce({
      title: 'Empty Narrators',
      authors: [{ name: 'Author' }],
      narrators: [],  // empty array — should not set narrator
      duration: 300,
    });
    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(db as any, metadataService as any, log as any);

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

    await runEnrichment(db as any, metadataService as any, log as any);

    expect(metadataService.enrichBook).not.toHaveBeenCalled();
  });

  it('treats narrators: undefined differently from narrators: [] (undefined skips, empty array skips)', async () => {
    // narrators: undefined — the `result.narrators?.length` check short-circuits via optional chaining
    db.select
      .mockReturnValueOnce(mockDbChain([]))  // no-asin
      .mockReturnValueOnce(mockDbChain([{ id: 1, asin: 'B_UNDEF_NARR' }]))  // candidates
      .mockReturnValueOnce(mockDbChain([{ narrator: null, duration: null }]));  // existing

    metadataService.enrichBook.mockResolvedValueOnce({
      title: 'Undefined Narrators',
      authors: [{ name: 'Author' }],
      // narrators key entirely absent → undefined
      duration: 600,
    });
    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(db as any, metadataService as any, log as any);

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

    await runEnrichment(db as any, metadataService as any, log as any);

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
      .mockReturnValueOnce(mockDbChain([{ narrator: null, duration: null }]));  // existing

    // enrichBook returns a result object but with no narrators and no duration
    metadataService.enrichBook.mockResolvedValueOnce({
      title: null,
      authors: null,
      narrators: undefined,
      duration: undefined,
    });
    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(db as any, metadataService as any, log as any);

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

    db.select.mockReturnValueOnce(mockDbChain([{ narrator: null, duration: null }]));  // existing book fields for book 1
    db.update.mockReturnValue(mockDbChain());

    await runEnrichment(db as any, metadataService as any, log as any);

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
});
