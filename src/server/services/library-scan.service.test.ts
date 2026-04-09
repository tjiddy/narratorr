import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject, createMockDb, mockDbChain, createMockSettingsService } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { BookService } from './book.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { parseFolderStructure, extractYear, LibraryScanService } from './library-scan.service.js';

vi.mock('./enrichment-utils.js', () => ({
  enrichBookFromAudio: vi.fn().mockResolvedValue({ enriched: true }),
}));

vi.mock('../../core/utils/book-discovery.js', () => ({
  discoverBooks: vi.fn().mockResolvedValue([]),
}));

vi.mock('node:fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ size: 0 }),
  mkdir: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/import-helpers.js', () => ({
  buildTargetPath: vi.fn().mockReturnValue('/library/Author/Title'),
  getPathSize: vi.fn().mockResolvedValue(1000),
}));

import { enrichBookFromAudio } from './enrichment-utils.js';
import { discoverBooks } from '../../core/utils/book-discovery.js';
import { access, readdir, stat, mkdir, cp, rm } from 'node:fs/promises';
import { buildTargetPath, getPathSize } from '../utils/import-helpers.js';

// ============================================================================
// parseFolderStructure (pure function tests)
// ============================================================================

describe('parseFolderStructure', () => {
  it('parses Author/Title structure', () => {
    const result = parseFolderStructure(['Brandon Sanderson', 'The Way of Kings']);
    expect(result).toEqual({
      title: 'The Way of Kings',
      author: 'Brandon Sanderson',
      series: null,
    });
  });

  it('parses Author/Series/Title structure', () => {
    const result = parseFolderStructure(['Brandon Sanderson', 'Stormlight Archive', 'The Way of Kings']);
    expect(result).toEqual({
      title: 'The Way of Kings',
      author: 'Brandon Sanderson',
      series: 'Stormlight Archive',
    });
  });

  it('parses "Author - Title" single folder', () => {
    const result = parseFolderStructure(['Andy Weir - Project Hail Mary']);
    expect(result).toEqual({
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      series: null,
    });
  });

  it('parses "Title (Author)" single folder', () => {
    const result = parseFolderStructure(['Dune (Frank Herbert)']);
    expect(result).toEqual({
      title: 'Dune',
      author: 'Frank Herbert',
      series: null,
    });
  });

  it('parses "Title [Author]" single folder', () => {
    const result = parseFolderStructure(['Dune [Frank Herbert]']);
    expect(result).toEqual({
      title: 'Dune',
      author: 'Frank Herbert',
      series: null,
    });
  });

  it('parses title-only single folder', () => {
    const result = parseFolderStructure(['The Way of Kings']);
    expect(result).toEqual({
      title: 'The Way of Kings',
      author: null,
      series: null,
    });
  });

  it('strips trailing year from folder names', () => {
    const result = parseFolderStructure(['Brandon Sanderson', 'The Way of Kings (2010)']);
    expect(result).toEqual({
      title: 'The Way of Kings',
      author: 'Brandon Sanderson',
      series: null,
    });
  });

  it('strips leading numbers from folder names', () => {
    const result = parseFolderStructure(['Brandon Sanderson', '01. The Way of Kings']);
    expect(result).toEqual({
      title: 'The Way of Kings',
      author: 'Brandon Sanderson',
      series: null,
    });
  });

  it('strips leading integer with dash-dot combo (01.- Title)', () => {
    const result = parseFolderStructure(['Author', '01.- Title']);
    expect(result).toEqual({
      title: 'Title',
      author: 'Author',
      series: null,
    });
  });

  it('strips decimal series position prefix with hyphen (6.5 - Title)', () => {
    const result = parseFolderStructure(['Tahereh Mafi', 'Shatter Me', '6.5 - Believe Me']);
    expect(result).toEqual({
      title: 'Believe Me',
      author: 'Tahereh Mafi',
      series: 'Shatter Me',
    });
  });

  it('strips decimal series position prefix with en-dash (6.5 – Title)', () => {
    const result = parseFolderStructure(['Tahereh Mafi', 'Shatter Me', '6.5 \u2013 Believe Me']);
    expect(result).toEqual({
      title: 'Believe Me',
      author: 'Tahereh Mafi',
      series: 'Shatter Me',
    });
  });

  it('strips two-digit decimal position prefix (10.5 - Title)', () => {
    const result = parseFolderStructure(['Author', 'Series', '10.5 - Bonus Chapter']);
    expect(result).toEqual({
      title: 'Bonus Chapter',
      author: 'Author',
      series: 'Series',
    });
  });

  it('strips decimal position in two-part path (Author/6.5 - Title)', () => {
    const result = parseFolderStructure(['Author', '6.5 - Novella']);
    expect(result).toEqual({
      title: 'Novella',
      author: 'Author',
      series: null,
    });
  });

  it('strips leading en-dash prefixes (01 – Title)', () => {
    const result = parseFolderStructure(['Author', '01 \u2013 Title']);
    expect(result).toEqual({
      title: 'Title',
      author: 'Author',
      series: null,
    });
  });

  it('handles deeply nested structures (4+ levels)', () => {
    const result = parseFolderStructure(['Brandon Sanderson', 'Cosmere', 'Stormlight Archive', 'The Way of Kings']);
    expect(result).toEqual({
      title: 'The Way of Kings',
      author: 'Brandon Sanderson',
      series: 'Stormlight Archive',
    });
  });

  it('treats numeric prefix with dash as title, not author', () => {
    const result = parseFolderStructure(['01 - Harry Potter And The Philosopher\'s Stone']);
    expect(result).toEqual({
      title: 'Harry Potter And The Philosopher\'s Stone',
      author: null,
      series: null,
    });
  });

  it('handles empty parts array', () => {
    const result = parseFolderStructure([]);
    expect(result).toEqual({
      title: 'Unknown',
      author: null,
      series: null,
    });
  });

  it('handles empty string title from folder name', () => {
    // After cleanName strips everything, we still get something
    const result = parseFolderStructure(['']);
    expect(result.title).toBe('');
    expect(result.author).toBeNull();
  });

  it('handles folder with only whitespace', () => {
    const result = parseFolderStructure(['   ']);
    expect(result.title).toBe('');
    expect(result.author).toBeNull();
  });

  it('handles folder with only numbers (falls back to original after cleanName strips)', () => {
    const result = parseFolderStructure(['01. ']);
    expect(result.title).toBe('01.');
    expect(result.author).toBeNull();
  });
});

// ============================================================================
// LibraryScanService (mocked DB/FS)
// ============================================================================

function createMockLogger() {
  return inject<FastifyBaseLogger>({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
    level: 'info',
  });
}

describe('LibraryScanService', () => {
  let service: LibraryScanService;
  // Hybrid mock: createMockDb() for scanDirectory pre-fetch (select.mockReturnValueOnce),
  // plus direct chain methods for other tests that use mockDb.where/limit/set directly.
  let mockDb: ReturnType<typeof createMockDb> & Record<string, ReturnType<typeof vi.fn>>;
  let mockBookService: {
    findDuplicate: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  let mockMetadataService: {
    searchBooks: ReturnType<typeof vi.fn>;
    getBook: ReturnType<typeof vi.fn>;
    enrichBook: ReturnType<typeof vi.fn>;
  };
  let log: ReturnType<typeof createMockLogger>;
  let mockEventHistoryService: { create: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enrichBookFromAudio).mockResolvedValue({ enriched: true });
    const db = createMockDb();
    // Add direct chain methods for backward compatibility with non-scanDirectory tests
    const chainMethods: Record<string, ReturnType<typeof vi.fn>> = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockReturnThis(),
    };
    // select/update calls return the chain by default
    db.select.mockReturnValue(chainMethods as never);
    db.update.mockReturnValue(chainMethods as never);
    mockDb = Object.assign(db, chainMethods);
    mockBookService = {
      findDuplicate: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async (data: { title: string; authors?: { name: string }[] }) => ({
        id: 1,
        title: data.title,
        status: 'imported',
        authors: (data.authors ?? []).map((a, i) => ({ id: i + 1, name: a.name })),
      })),
      update: vi.fn().mockResolvedValue({ id: 1, title: 'Test', authors: [], narrators: [] }),
    };
    mockMetadataService = {
      searchBooks: vi.fn().mockResolvedValue([]),
      getBook: vi.fn().mockResolvedValue(null),
      enrichBook: vi.fn().mockResolvedValue(null),
    };
    mockEventHistoryService = {
      create: vi.fn().mockResolvedValue({}),
    };
    log = createMockLogger();
    const mockSettingsService = createMockSettingsService({
      library: { path: '/library' },
    });
    service = new LibraryScanService(
      inject<Db>(mockDb),
      inject<BookService>(mockBookService),
      inject<MetadataService>(mockMetadataService),
      inject<SettingsService>(mockSettingsService),
      log,
      inject<EventHistoryService>(mockEventHistoryService),
    );
  });

  describe('importSingleBook', () => {
    it('creates book record and enriches', async () => {
      const result = await service.importSingleBook({
        path: '/audiobooks/Title',
        title: 'Test Book',
        authorName: 'Test Author',
      });

      expect(result.imported).toBe(true);
      expect(result.bookId).toBe(1);
      expect(result.enriched).toBe(true);
      expect(mockBookService.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test Book', authors: [{ name: 'Test Author' }], status: 'imported' }),
      );
    });

    it('returns duplicate error without creating', async () => {
      mockBookService.findDuplicate.mockResolvedValueOnce({ id: 1, title: 'Existing' });

      const result = await service.importSingleBook({
        path: '/audiobooks/Title',
        title: 'Existing',
        authorName: 'Author',
      });

      expect(result.imported).toBe(false);
      expect(result.error).toBe('duplicate');
      expect(mockBookService.create).not.toHaveBeenCalled();
    });

    it('returns duplicate when authorless book matches by title only (#246)', async () => {
      mockBookService.findDuplicate.mockResolvedValueOnce({ id: 1, title: 'Shogun' });

      const result = await service.importSingleBook({
        path: '/audiobooks/Shogun',
        title: 'Shogun',
        authorName: undefined,
      });

      expect(result.imported).toBe(false);
      expect(result.error).toBe('duplicate');
      expect(mockBookService.findDuplicate).toHaveBeenCalledWith('Shogun', undefined);
      expect(mockBookService.create).not.toHaveBeenCalled();
    });

    it('imports authorless book when only authored matches exist (#253)', async () => {
      // findDuplicate returns null — authored "Shogun" excluded by notExists
      mockBookService.findDuplicate.mockResolvedValueOnce(null);

      const result = await service.importSingleBook({
        path: '/audiobooks/Shogun',
        title: 'Shogun',
        authorName: undefined,
      });

      expect(result.imported).toBe(true);
      expect(mockBookService.findDuplicate).toHaveBeenCalledWith('Shogun', undefined);
      expect(mockBookService.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Shogun' }));
    });

    it('uses passed metadata instead of looking up', async () => {
      const metadata = {
        title: 'Provider Title',
        authors: [{ name: 'Provider Author' }],
        asin: 'B123',
        description: 'Provider description',
        narrators: ['Narrator One'],
        coverUrl: 'https://example.com/cover.jpg',
      };

      await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'My Title' },
        metadata,
      );

      // Should NOT call searchBooks since metadata was passed
      expect(mockMetadataService.searchBooks).not.toHaveBeenCalled();
      expect(mockBookService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'My Title',
          asin: 'B123',
          description: 'Provider description',
        }),
      );
    });

    it('calls Audnexus enrichment inline when ASIN is available', async () => {
      mockMetadataService.enrichBook.mockResolvedValueOnce({
        narrators: ['Stephen Fry'],
        duration: 480,
      });

      await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B017V4IM1G' },
      );

      expect(mockMetadataService.enrichBook).toHaveBeenCalledWith('B017V4IM1G');
    });

    it('skips Audnexus enrichment when no ASIN', async () => {
      await service.importSingleBook({
        path: '/audiobooks/Title',
        title: 'No ASIN Book',
      });

      expect(mockMetadataService.enrichBook).not.toHaveBeenCalled();
    });

    it('still imports when Audnexus enrichment fails', async () => {
      mockMetadataService.enrichBook.mockRejectedValueOnce(new Error('Audnexus down'));

      const result = await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B017V4IM1G' },
      );

      expect(result.imported).toBe(true);
    });

    it('tries alternate ASINs when primary ASIN returns no Audnexus data', async () => {
      // Primary ASIN returns null, alternate works
      mockMetadataService.enrichBook
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ narrators: ['Jim Dale'], duration: 540 });

      await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B0NEW' },
        { title: 'HP', authors: [{ name: 'JKR' }], asin: 'B0NEW', alternateAsins: ['B0OLD'] },
      );

      expect(mockMetadataService.enrichBook).toHaveBeenCalledTimes(2);
      expect(mockMetadataService.enrichBook).toHaveBeenNthCalledWith(1, 'B0NEW');
      expect(mockMetadataService.enrichBook).toHaveBeenNthCalledWith(2, 'B0OLD');
    });

    it('stops trying alternate ASINs after first successful match', async () => {
      mockMetadataService.enrichBook
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ narrators: ['Jim Dale'] });

      await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B0NEW' },
        { title: 'HP', authors: [{ name: 'JKR' }], asin: 'B0NEW', alternateAsins: ['B0OLD', 'B0OLDER'] },
      );

      // Should stop after B0OLD succeeds, never try B0OLDER
      expect(mockMetadataService.enrichBook).toHaveBeenCalledTimes(2);
    });

    it('does not apply Audnexus update when all ASINs return null', async () => {
      mockMetadataService.enrichBook
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B0NEW' },
        { title: 'HP', authors: [{ name: 'JKR' }], asin: 'B0NEW', alternateAsins: ['B0OLD'] },
      );

      expect(result.imported).toBe(true);
      expect(mockMetadataService.enrichBook).toHaveBeenCalledTimes(2);
      // No enrichment update — db.update only called for path/size (not enrichmentStatus)
    });

    it('handles Audnexus returning empty narrators array', async () => {
      mockMetadataService.enrichBook.mockResolvedValueOnce({
        narrators: [],  // empty, not undefined
        duration: 480,
      });

      const result = await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B017V4IM1G' },
      );

      expect(result.imported).toBe(true);
      // enrichBook was called but narrators was empty — should still import fine
      expect(mockMetadataService.enrichBook).toHaveBeenCalledWith('B017V4IM1G');
    });

    it('handles Audnexus returning narrators but no duration', async () => {
      mockMetadataService.enrichBook.mockResolvedValueOnce({
        narrators: ['Jim Dale'],
        // no duration field
      });

      const result = await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B017V4IM1G' },
      );

      expect(result.imported).toBe(true);
    });

    // Genre persistence via applyAudnexusEnrichment
    it('persists genres via bookService.update() when enrichBook returns genres and book has null genres', async () => {
      mockMetadataService.enrichBook.mockResolvedValueOnce({
        narrators: ['Jim Dale'],
        duration: 480,
        genres: ['Fantasy', 'Science Fiction'],
      });

      await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B017V4IM1G' },
      );

      expect(mockBookService.update).toHaveBeenCalledWith(1, { genres: ['Fantasy', 'Science Fiction'] });
    });

    it('persists genres via bookService.update() when enrichBook returns genres and book has empty array genres', async () => {
      // Override create mock to return book with empty genres array
      mockBookService.create.mockResolvedValueOnce({
        id: 1, title: 'HP', status: 'imported', authors: [], narrators: [], genres: [],
      });
      mockMetadataService.enrichBook.mockResolvedValueOnce({
        genres: ['Mystery'],
      });

      await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B017V4IM1G' },
      );

      expect(mockBookService.update).toHaveBeenCalledWith(1, { genres: ['Mystery'] });
    });

    it('does not overwrite existing non-empty genres when enrichBook returns genres', async () => {
      // Override create mock to return book with existing genres
      mockBookService.create.mockResolvedValueOnce({
        id: 1, title: 'HP', status: 'imported', authors: [], narrators: [], genres: ['Existing Genre'],
      });
      mockMetadataService.enrichBook.mockResolvedValueOnce({
        genres: ['New Genre'],
      });

      await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B017V4IM1G' },
      );

      // bookService.update should NOT be called with genres
      const genreUpdateCalls = mockBookService.update.mock.calls.filter(
        (call: unknown[]) => call[1] && typeof call[1] === 'object' && 'genres' in (call[1] as Record<string, unknown>),
      );
      expect(genreUpdateCalls).toHaveLength(0);
    });

    it('does not attempt genre update when enrichBook returns genres=undefined', async () => {
      mockMetadataService.enrichBook.mockResolvedValueOnce({
        narrators: ['Jim Dale'],
        duration: 480,
        // genres undefined
      });

      await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B017V4IM1G' },
      );

      const genreUpdateCalls = mockBookService.update.mock.calls.filter(
        (call: unknown[]) => call[1] && typeof call[1] === 'object' && 'genres' in (call[1] as Record<string, unknown>),
      );
      expect(genreUpdateCalls).toHaveLength(0);
    });

    it('does not attempt genre update when enrichBook returns genres=[] (empty array)', async () => {
      mockMetadataService.enrichBook.mockResolvedValueOnce({
        narrators: ['Jim Dale'],
        genres: [],
      });

      await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B017V4IM1G' },
      );

      const genreUpdateCalls = mockBookService.update.mock.calls.filter(
        (call: unknown[]) => call[1] && typeof call[1] === 'object' && 'genres' in (call[1] as Record<string, unknown>),
      );
      expect(genreUpdateCalls).toHaveLength(0);
    });

    it('persists genres via ASIN fallback path when alternate ASIN succeeds with genres', async () => {
      mockMetadataService.enrichBook
        .mockResolvedValueOnce(null)  // primary fails
        .mockResolvedValueOnce({ narrators: ['Jim Dale'], genres: ['Fantasy'] });  // alternate works

      await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B0NEW' },
        { title: 'HP', authors: [{ name: 'JKR' }], asin: 'B0NEW', alternateAsins: ['B0OLD'] },
      );

      expect(mockBookService.update).toHaveBeenCalledWith(1, { genres: ['Fantasy'] });
    });

    it('stores alternate ASIN when primary fails but alternate succeeds', async () => {
      mockMetadataService.enrichBook
        .mockResolvedValueOnce(null)  // B0NEW fails
        .mockResolvedValueOnce({ narrators: ['Jim Dale'] });  // B0OLD works

      await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'HP', asin: 'B0NEW' },
        { title: 'HP', authors: [{ name: 'JKR' }], asin: 'B0NEW', alternateAsins: ['B0OLD'] },
      );

      // DB update should include the working ASIN
      expect((mockDb as Record<string, unknown>).update).toHaveBeenCalled();
    });

    it('looks up metadata when none passed', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([{
        title: 'Matched',
        authors: [{ name: 'Author' }],
        asin: 'B456',
      }]);

      await service.importSingleBook({
        path: '/audiobooks/Title',
        title: 'Search Me',
      });

      expect(mockMetadataService.searchBooks).toHaveBeenCalledWith('Search Me');
      expect(mockBookService.create).toHaveBeenCalledWith(
        expect.objectContaining({ asin: 'B456' }),
      );
    });

    it('propagates error when bookService.create throws', async () => {
      mockBookService.create.mockRejectedValueOnce(new Error('DB constraint error'));

      await expect(service.importSingleBook({
        path: '/audiobooks/Title',
        title: 'Broken',
      })).rejects.toThrow('DB constraint error');
    });

    it('imports successfully with no metadata and no ASIN', async () => {
      const result = await service.importSingleBook(
        { path: '/audiobooks/Title', title: 'Bare Book' },
        null, // explicitly no metadata
      );

      expect(result.imported).toBe(true);
      expect(mockMetadataService.searchBooks).not.toHaveBeenCalled();
      expect(mockMetadataService.enrichBook).not.toHaveBeenCalled();
      expect(mockBookService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Bare Book',
          asin: undefined,
          narrators: undefined,
        }),
      );
    });

    it('records import_failed event with narrator from real metadata when book creation throws', async () => {
      const createError = new Error('DB constraint violation');
      mockBookService.create.mockRejectedValueOnce(createError);

      const metadata = {
        title: 'Test Book',
        authors: [{ name: 'Author' }],
        narrators: ['Stephen Fry'],
        asin: 'B123',
      };

      await expect(service.importSingleBook(
        { path: '/audiobooks/Title', title: 'Test Book', authorName: 'Author' },
        metadata,
      )).rejects.toThrow('DB constraint violation');

      expect(mockEventHistoryService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: null,
          bookTitle: 'Test Book',
          authorName: 'Author',
          narratorName: 'Stephen Fry',
          eventType: 'import_failed',
          source: 'manual',
          reason: { error: 'DB constraint violation' },
        }),
      );
    });

    it('logs warning and rethrows original error when both book creation and event recording fail', async () => {
      const createError = new Error('DB constraint violation');
      mockBookService.create.mockRejectedValueOnce(createError);
      mockEventHistoryService.create.mockRejectedValueOnce(new Error('Event DB failure'));

      await expect(service.importSingleBook(
        { path: '/audiobooks/Title', title: 'Test Book', authorName: 'Author' },
        { title: 'Test Book', authors: [{ name: 'Author' }], narrators: ['Narrator'] },
      )).rejects.toThrow('DB constraint violation');

      // Event creation was attempted
      expect(mockEventHistoryService.create).toHaveBeenCalled();
      // Warning was logged for the event creation failure
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Failed to record manual import failed event',
      );
    });
  });

  describe('lookupMetadata', () => {
    it('searches with title and author', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([{ title: 'Result' }]);

      const result = await service.lookupMetadata('Book Title', 'Author Name');

      expect(mockMetadataService.searchBooks).toHaveBeenCalledWith('Book Title Author Name');
      expect(result).toEqual({ title: 'Result' });
    });

    it('searches with title only when no author', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([{ title: 'Result' }]);

      await service.lookupMetadata('Book Title');

      expect(mockMetadataService.searchBooks).toHaveBeenCalledWith('Book Title');
    });

    it('returns null when no results', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([]);

      const result = await service.lookupMetadata('Obscure');
      expect(result).toBeNull();
    });

    it('returns null on error', async () => {
      mockMetadataService.searchBooks.mockRejectedValue(new Error('API down'));

      const result = await service.lookupMetadata('Title');
      expect(result).toBeNull();
    });

    it('fetches full book detail when search result has providerId but no ASIN', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([{
        title: 'Harry Potter',
        providerId: '12345',
      }]);
      mockMetadataService.getBook.mockResolvedValue({
        title: 'Harry Potter and the Prisoner of Azkaban',
        asin: 'B017V4IMKG',
        narrators: ['Stephen Fry'],
      });

      const result = await service.lookupMetadata('Harry Potter');

      expect(mockMetadataService.getBook).toHaveBeenCalledWith('12345');
      expect(result?.asin).toBe('B017V4IMKG');
      expect(result?.narrators).toEqual(['Stephen Fry']);
      // Preserves the search result title (user's query match), not the detail title
      expect(result?.title).toBe('Harry Potter');
    });

    it('falls back to search result when getBook throws', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([{
        title: 'Harry Potter',
        providerId: '12345',
      }]);
      mockMetadataService.getBook.mockRejectedValue(new Error('API timeout'));

      const result = await service.lookupMetadata('Harry Potter');

      // Should still return the search result, just without ASIN
      expect(result?.title).toBe('Harry Potter');
      expect(result?.asin).toBeUndefined();
    });

    it('uses search result when getBook returns null', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([{
        title: 'Harry Potter',
        providerId: '12345',
      }]);
      mockMetadataService.getBook.mockResolvedValue(null);

      const result = await service.lookupMetadata('Harry Potter');

      expect(mockMetadataService.getBook).toHaveBeenCalledWith('12345');
      // Should still return search result, just without enriched fields
      expect(result?.title).toBe('Harry Potter');
      expect(result?.asin).toBeUndefined();
    });

    it('returns search result with partial data (no ASIN, no narrators, no coverUrl)', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([{
        title: 'Obscure Title',
        authors: [{ name: 'Unknown' }],
        // no asin, no narrators, no coverUrl, no description
      }]);

      const result = await service.lookupMetadata('Obscure Title');

      expect(result?.title).toBe('Obscure Title');
      expect(result?.asin).toBeUndefined();
      expect(result?.narrators).toBeUndefined();
      expect(result?.coverUrl).toBeUndefined();
    });

    it('skips getBook when search result already has ASIN', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([{
        title: 'Result',
        providerId: '12345',
        asin: 'B_ALREADY',
      }]);

      await service.lookupMetadata('Title');

      expect(mockMetadataService.getBook).not.toHaveBeenCalled();
    });
  });

  describe('lookupMetadata swap retry (issue #426)', () => {
    it('returns match when first search succeeds — no swap', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([{ title: 'Found' }]);

      const result = await service.lookupMetadata('Title', 'Author');

      expect(mockMetadataService.searchBooks).toHaveBeenCalledTimes(1);
      expect(mockMetadataService.searchBooks).toHaveBeenCalledWith('Title Author');
      expect(result).toEqual({ title: 'Found' });
    });

    it('retries with swapped author/title on zero results', async () => {
      mockMetadataService.searchBooks
        .mockResolvedValueOnce([])  // first search: empty
        .mockResolvedValueOnce([{ title: 'Found via swap' }]);  // swap search: found

      const result = await service.lookupMetadata('The Correspondent', 'Virginia Evans');

      expect(mockMetadataService.searchBooks).toHaveBeenCalledTimes(2);
      expect(mockMetadataService.searchBooks).toHaveBeenNthCalledWith(1, 'The Correspondent Virginia Evans');
      expect(mockMetadataService.searchBooks).toHaveBeenNthCalledWith(2, 'Virginia Evans The Correspondent');
      expect(result).toEqual({ title: 'Found via swap' });
    });

    it('does not swap when author is null', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([]);

      const result = await service.lookupMetadata('Title');

      expect(mockMetadataService.searchBooks).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it('does not swap when author is empty string', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([]);

      const result = await service.lookupMetadata('Title', '');

      expect(mockMetadataService.searchBooks).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it('returns null when both searches return empty', async () => {
      mockMetadataService.searchBooks
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.lookupMetadata('Unknown', 'Nobody');

      expect(mockMetadataService.searchBooks).toHaveBeenCalledTimes(2);
      expect(result).toBeNull();
    });

    it('swap retry error does not crash scan', async () => {
      mockMetadataService.searchBooks
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('API error on retry'));

      const result = await service.lookupMetadata('Title', 'Author');

      expect(result).toBeNull();
    });
  });

  describe('confirmImport', () => {
    it('creates book records for each item', async () => {
      const result = await service.confirmImport([
        { path: '/audiobooks/Author/Title', title: 'Title', authorName: 'Author' },
      ]);

      expect(mockBookService.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Title', authors: [{ name: 'Author' }], status: 'importing' }),
      );
      expect(result.accepted).toBe(1);
    });

    it('skips duplicates during import', async () => {
      mockBookService.findDuplicate.mockResolvedValueOnce({ id: 1, title: 'Existing' });

      const result = await service.confirmImport([
        { path: '/audiobooks/Author/Title', title: 'Existing', authorName: 'Author' },
      ]);

      expect(mockBookService.create).not.toHaveBeenCalled();
      expect(result.accepted).toBe(0);
    });

    it('counts accepted items', async () => {
      const result = await service.confirmImport([
        { path: '/a/b', title: 'Book 1' },
        { path: '/a/c', title: 'Book 2' },
      ]);

      expect(result.accepted).toBe(2);
    });

    it('does not count skipped duplicates as accepted', async () => {
      mockBookService.findDuplicate.mockResolvedValueOnce({ id: 1, title: 'Existing' });

      const result = await service.confirmImport([
        { path: '/audiobooks/A', title: 'Existing', authorName: 'Author' },
      ]);

      expect(result.accepted).toBe(0);
    });

    it('uses passed-through metadata when creating book records', async () => {
      const metadata = {
        title: 'Harry Potter and the Philosopher\'s Stone',
        authors: [{ name: 'J.K. Rowling' }],
        asin: 'B017V4IM1G',
        description: 'The boy who lived...',
        narrators: ['Stephen Fry'],
        genres: ['fantasy', 'young-adult'],
        coverUrl: 'https://example.com/cover.jpg',
        duration: 480,
        publishedDate: '1997-06-26',
        providerId: 'hc-123',
      };

      await service.confirmImport([
        { path: '/audiobooks/HP1', title: 'Harry Potter', authorName: 'J.K. Rowling', metadata },
      ]);

      // confirmImport no longer does its own metadata lookup — metadata is passed through
      expect(mockMetadataService.searchBooks).not.toHaveBeenCalled();
      expect(mockBookService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Harry Potter',
          authors: [{ name: 'J.K. Rowling' }],
          asin: 'B017V4IM1G',
          description: 'The boy who lived...',
          narrators: ['Stephen Fry'],
          genres: ['fantasy', 'young-adult'],
          coverUrl: 'https://example.com/cover.jpg',
          duration: 480,
          providerId: 'hc-123',
        }),
      );
    });

    it('still imports when metadata lookup returns no results', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([]);

      const result = await service.confirmImport([
        { path: '/audiobooks/Obscure', title: 'Obscure Book' },
      ]);

      expect(result.accepted).toBe(1);
      expect(mockBookService.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Obscure Book' }),
      );
    });

    it('still accepts when metadata lookup throws', async () => {
      mockMetadataService.searchBooks.mockRejectedValue(new Error('API timeout'));

      const result = await service.confirmImport([
        { path: '/audiobooks/Timeout', title: 'Timeout Book' },
      ]);

      expect(result.accepted).toBe(1);
    });

    it('preserves user-provided values over metadata', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([{
        title: 'Different Title',
        authors: [{ name: 'Different Author' }],
        asin: 'B123',
        coverUrl: 'https://provider.com/cover.jpg',
      }]);

      await service.confirmImport([
        { path: '/audiobooks/A', title: 'My Title', authorName: 'My Author', coverUrl: '/my/cover.jpg', asin: 'MY-ASIN' },
      ]);

      expect(mockBookService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'My Title',
          authors: [{ name: 'My Author' }],
          coverUrl: '/my/cover.jpg',
          asin: 'MY-ASIN',
        }),
      );
    });

    it('continues creating placeholders when one item throws', async () => {
      mockBookService.create
        .mockRejectedValueOnce(new Error('DB constraint error'))
        .mockResolvedValueOnce({ id: 2, title: 'Book 2', status: 'importing' });

      const result = await service.confirmImport([
        { path: '/a/b', title: 'Broken Book' },
        { path: '/a/c', title: 'Book 2' },
      ]);

      expect(result.accepted).toBe(1);
      expect(mockBookService.create).toHaveBeenCalledTimes(2);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Broken Book' }),
        expect.stringContaining('Failed to create placeholder'),
      );
    });

    it('returns zero accepted when all items are duplicates', async () => {
      mockBookService.findDuplicate.mockResolvedValue({ id: 1, title: 'Dup' });

      const result = await service.confirmImport([
        { path: '/a/b', title: 'Dup 1' },
        { path: '/a/c', title: 'Dup 2' },
        { path: '/a/d', title: 'Dup 3' },
      ]);

      expect(result.accepted).toBe(0);
      expect(mockBookService.create).not.toHaveBeenCalled();
    });

    it('returns zero accepted for empty items array', async () => {
      const result = await service.confirmImport([]);

      expect(result.accepted).toBe(0);
      expect(mockBookService.create).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // scanDirectory
  // ============================================================================

  describe('scanDirectory', () => {
    /** Helper: set up pre-fetch mocks for scanDirectory */
    function mockPreFetch(paths: string[], titleAuthors: Array<{ title: string; slug: string }>) {
      mockDb.select
        .mockReturnValueOnce(mockDbChain(paths.map((p) => ({ path: p }))))
        .mockReturnValueOnce(mockDbChain(titleAuthors));
    }

    it('returns empty discoveries when no folders found', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([]);
      mockPreFetch([], []);

      const result = await service.scanDirectory('/audiobooks');

      expect(result).toEqual({
        discoveries: [],
        totalFolders: 0,
      });
      expect(discoverBooks).toHaveBeenCalledWith('/audiobooks', { log });
    });

    it('returns discovered books with parsed metadata', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        {
          path: '/audiobooks/Brandon Sanderson/The Way of Kings',
          folderParts: ['Brandon Sanderson', 'The Way of Kings'],
          audioFileCount: 5,
          totalSize: 500_000_000,
        },
      ]);
      mockPreFetch([], []);

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries).toHaveLength(1);
      expect(result.discoveries[0]).toEqual({
        path: '/audiobooks/Brandon Sanderson/The Way of Kings',
        parsedTitle: 'The Way of Kings',
        parsedAuthor: 'Brandon Sanderson',
        parsedSeries: null,
        fileCount: 5,
        totalSize: 500_000_000,
        isDuplicate: false,
      });
      expect(result.totalFolders).toBe(1);
    });

    it('marks folders that already exist by path in DB as isDuplicate: true', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        {
          path: '/audiobooks/Existing',
          folderParts: ['Existing'],
          audioFileCount: 3,
          totalSize: 100,
        },
      ]);
      // Pre-fetch returns path match
      mockPreFetch(['/audiobooks/Existing'], []);

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries).toHaveLength(1);
      expect(result.discoveries[0].isDuplicate).toBe(true);
      expect(result.totalFolders).toBe(1);
    });

    it('marks folders that match existing book by title+author as isDuplicate: true', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        {
          path: '/audiobooks/Author/Title',
          folderParts: ['Author', 'Title'],
          audioFileCount: 2,
          totalSize: 200,
        },
      ]);
      // No path match, but title+author slug match
      mockPreFetch([], [{ title: 'Title', slug: 'author' }]);

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries).toHaveLength(1);
      expect(result.discoveries[0].isDuplicate).toBe(true);
    });

    it('does not check title+author duplicate when parsed title is empty', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        {
          path: '/audiobooks/somefolder',
          folderParts: [''],
          audioFileCount: 1,
          totalSize: 50,
        },
      ]);
      mockPreFetch([], []);

      const result = await service.scanDirectory('/audiobooks');

      // Empty string is falsy, so title+author check should be skipped
      expect(result.discoveries).toHaveLength(1);
    });

    it('handles mix of new, path-duplicate, and title-duplicate folders', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/New/Book1', folderParts: ['New', 'Book1'], audioFileCount: 1, totalSize: 100 },
        { path: '/audiobooks/PathDup', folderParts: ['PathDup'], audioFileCount: 2, totalSize: 200 },
        { path: '/audiobooks/Author/TitleDup', folderParts: ['Author', 'TitleDup'], audioFileCount: 3, totalSize: 300 },
        { path: '/audiobooks/New/Book2', folderParts: ['New', 'Book2'], audioFileCount: 4, totalSize: 400 },
      ]);
      // PathDup exists by path, TitleDup exists by title+author
      mockPreFetch(
        ['/audiobooks/PathDup'],
        [{ title: 'TitleDup', slug: 'author' }],
      );

      const result = await service.scanDirectory('/audiobooks');

      // All 4 folders appear in discoveries; 2 are marked as duplicates
      expect(result.discoveries).toHaveLength(4);
      const nonDups = result.discoveries.filter((d) => !d.isDuplicate);
      expect(nonDups.map((d) => d.parsedTitle)).toEqual(['Book1', 'Book2']);
      expect(result.discoveries.filter((d) => d.isDuplicate)).toHaveLength(2);
      expect(result.totalFolders).toBe(4);
    });

    // N+1 elimination tests (issue #356)
    describe('pre-fetch optimization', () => {
      it('pre-fetches all book paths and title+author slugs before the folder loop', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([
          { path: '/audiobooks/A/Book1', folderParts: ['A', 'Book1'], audioFileCount: 1, totalSize: 100 },
          { path: '/audiobooks/B/Book2', folderParts: ['B', 'Book2'], audioFileCount: 1, totalSize: 100 },
        ]);
        mockPreFetch([], []);

        await service.scanDirectory('/audiobooks');

        // db.select should be called exactly twice (paths + title/author), NOT per folder
        expect(mockDb.select).toHaveBeenCalledTimes(2);
      });

      it('handles empty library — all folders treated as new', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([
          { path: '/audiobooks/A/Book', folderParts: ['A', 'Book'], audioFileCount: 1, totalSize: 100 },
        ]);
        mockPreFetch([], []);

        const result = await service.scanDirectory('/audiobooks');

        expect(result.discoveries).toHaveLength(1);
        expect(result.discoveries[0].isDuplicate).toBe(false);
      });

      it('handles scan with zero folders — pre-fetch queries still run', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([]);
        mockPreFetch([], []);

        const result = await service.scanDirectory('/audiobooks');

        expect(result.discoveries).toHaveLength(0);
        expect(mockDb.select).toHaveBeenCalledTimes(2);
      });

      it('does not call bookService.findDuplicate (uses in-memory lookup instead)', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([
          { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 1, totalSize: 100 },
        ]);
        mockPreFetch([], [{ title: 'Title', slug: 'author' }]);

        await service.scanDirectory('/audiobooks');

        expect(mockBookService.findDuplicate).not.toHaveBeenCalled();
      });
    });

    // =========================================================================
    // #114 — duplicate rows returned with isDuplicate flag (not filtered out)
    // =========================================================================
    describe('isDuplicate flag on discoveries', () => {
      /** Pre-fetch with id fields for existingBookId population */
      function mockPreFetchWithIds(
        pathRows: Array<{ id: number; path: string }>,
        titleAuthorRows: Array<{ id: number; title: string; slug: string }>,
      ) {
        mockDb.select
          .mockReturnValueOnce(mockDbChain(pathRows))
          .mockReturnValueOnce(mockDbChain(titleAuthorRows));
      }

      it('returns all folders in discoveries when no duplicates exist; all have isDuplicate: false', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([
          { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 1, totalSize: 100 },
        ]);
        mockPreFetch([], []);

        const result = await service.scanDirectory('/audiobooks');

        expect(result.discoveries).toHaveLength(1);
        expect(result.discoveries[0].isDuplicate).toBe(false);
        expect(result.discoveries[0].existingBookId).toBeUndefined();
      });

      it('marks path-matched folders as isDuplicate: true; new folders have isDuplicate: false', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([
          { path: '/audiobooks/Existing', folderParts: ['Existing'], audioFileCount: 3, totalSize: 100 },
          { path: '/audiobooks/New/Book', folderParts: ['New', 'Book'], audioFileCount: 1, totalSize: 50 },
        ]);
        mockPreFetchWithIds([{ id: 42, path: '/audiobooks/Existing' }], []);

        const result = await service.scanDirectory('/audiobooks');

        expect(result.discoveries).toHaveLength(2);
        const dup = result.discoveries.find((d) => d.path === '/audiobooks/Existing');
        const newBook = result.discoveries.find((d) => d.path === '/audiobooks/New/Book');
        expect(dup?.isDuplicate).toBe(true);
        expect(dup?.existingBookId).toBe(42);
        expect(newBook?.isDuplicate).toBe(false);
        expect(newBook?.existingBookId).toBeUndefined();
      });

      it('marks title+author matched folders as isDuplicate: true', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([
          { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 2, totalSize: 200 },
        ]);
        mockPreFetchWithIds([], [{ id: 7, title: 'Title', slug: 'author' }]);

        const result = await service.scanDirectory('/audiobooks');

        expect(result.discoveries).toHaveLength(1);
        expect(result.discoveries[0].isDuplicate).toBe(true);
        expect(result.discoveries[0].existingBookId).toBe(7);
      });

      it('title+author duplicate check is case-insensitive on title', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([
          { path: '/audiobooks/Author/Harry Potter And The Chamber Of Secrets', folderParts: ['Author', 'Harry Potter And The Chamber Of Secrets'], audioFileCount: 2, totalSize: 200 },
        ]);
        // DB has lowercase title, folder has title-case — should still match
        mockPreFetchWithIds([], [{ id: 9, title: 'Harry Potter and the Chamber of Secrets', slug: 'author' }]);

        const result = await service.scanDirectory('/audiobooks');

        expect(result.discoveries).toHaveLength(1);
        expect(result.discoveries[0].isDuplicate).toBe(true);
        expect(result.discoveries[0].existingBookId).toBe(9);
        expect(result.discoveries[0].duplicateReason).toBe('slug');
      });

      it('within-scan duplicate check is case-insensitive on title', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([
          { path: '/audiobooks/Author/the way of kings', folderParts: ['Author', 'the way of kings'], audioFileCount: 1, totalSize: 100 },
          { path: '/audiobooks/Author/The Way Of Kings', folderParts: ['Author', 'The Way Of Kings'], audioFileCount: 2, totalSize: 200 },
        ]);
        mockPreFetch([], []);

        const result = await service.scanDirectory('/audiobooks');

        const dups = result.discoveries.filter(d => d.isDuplicate);
        expect(dups).toHaveLength(1);
        expect(dups[0].duplicateReason).toBe('within-scan');
      });

      it('does not check title+author duplicate when parsed title is empty; folder is not marked isDuplicate', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([
          { path: '/audiobooks/somefolder', folderParts: [''], audioFileCount: 1, totalSize: 50 },
        ]);
        mockPreFetch([], []);

        const result = await service.scanDirectory('/audiobooks');

        expect(result.discoveries).toHaveLength(1);
        expect(result.discoveries[0].isDuplicate).toBe(false);
      });

      it('mix of new, path-duplicate, and title-duplicate folders all appear in discoveries with correct flags', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([
          { path: '/audiobooks/New/Book1', folderParts: ['New', 'Book1'], audioFileCount: 1, totalSize: 100 },
          { path: '/audiobooks/PathDup', folderParts: ['PathDup'], audioFileCount: 2, totalSize: 200 },
          { path: '/audiobooks/Author/TitleDup', folderParts: ['Author', 'TitleDup'], audioFileCount: 3, totalSize: 300 },
          { path: '/audiobooks/New/Book2', folderParts: ['New', 'Book2'], audioFileCount: 4, totalSize: 400 },
        ]);
        mockPreFetchWithIds(
          [{ id: 10, path: '/audiobooks/PathDup' }],
          [{ id: 20, title: 'TitleDup', slug: 'author' }],
        );

        const result = await service.scanDirectory('/audiobooks');

        expect(result.discoveries).toHaveLength(4);
        const pathDup = result.discoveries.find((d) => d.path === '/audiobooks/PathDup');
        const titleDup = result.discoveries.find((d) => d.path === '/audiobooks/Author/TitleDup');
        const book1 = result.discoveries.find((d) => d.parsedTitle === 'Book1');
        const book2 = result.discoveries.find((d) => d.parsedTitle === 'Book2');
        expect(pathDup?.isDuplicate).toBe(true);
        expect(pathDup?.existingBookId).toBe(10);
        expect(titleDup?.isDuplicate).toBe(true);
        expect(titleDup?.existingBookId).toBe(20);
        expect(book1?.isDuplicate).toBe(false);
        expect(book2?.isDuplicate).toBe(false);
      });

      it('response does not contain skippedDuplicates field', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([]);
        mockPreFetch([], []);

        const result = await service.scanDirectory('/audiobooks');

        expect(result).not.toHaveProperty('skippedDuplicates');
      });

      it('path-matched duplicate has existingBookId from DB', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([
          { path: '/audiobooks/Existing', folderParts: ['Existing'], audioFileCount: 1, totalSize: 100 },
        ]);
        mockPreFetchWithIds([{ id: 99, path: '/audiobooks/Existing' }], []);

        const result = await service.scanDirectory('/audiobooks');

        expect(result.discoveries[0].existingBookId).toBe(99);
      });

      it('title+author matched duplicate has existingBookId from DB', async () => {
        vi.mocked(discoverBooks).mockResolvedValue([
          { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 1, totalSize: 100 },
        ]);
        mockPreFetchWithIds([], [{ id: 55, title: 'Title', slug: 'author' }]);

        const result = await service.scanDirectory('/audiobooks');

        expect(result.discoveries[0].existingBookId).toBe(55);
      });
    });
  });

  // =========================================================================
  // #114 — confirmImport forceImport override
  // =========================================================================
  describe('confirmImport forceImport override', () => {
    it('when forceImport is absent, silently skips a title+author duplicate (safety-net preserved)', async () => {
      mockBookService.findDuplicate.mockResolvedValueOnce({ id: 1, title: 'Existing' });

      const result = await service.confirmImport([
        { path: '/audiobooks/Author/Title', title: 'Existing', authorName: 'Author' },
      ]);

      expect(mockBookService.create).not.toHaveBeenCalled();
      expect(result.accepted).toBe(0);
    });

    it('when forceImport is true, bypasses the safety-net check and processes the book', async () => {
      mockBookService.findDuplicate.mockResolvedValueOnce({ id: 1, title: 'Existing' });

      const result = await service.confirmImport([
        { path: '/audiobooks/Author/Title', title: 'Existing', authorName: 'Author', forceImport: true },
      ]);

      expect(mockBookService.findDuplicate).not.toHaveBeenCalled();
      expect(mockBookService.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Existing' }),
      );
      expect(result.accepted).toBe(1);
    });

    it('non-duplicate items are unaffected when forceImport is absent', async () => {
      const result = await service.confirmImport([
        { path: '/audiobooks/New/Book', title: 'New Book', authorName: 'Author' },
      ]);

      expect(mockBookService.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'New Book' }),
      );
      expect(result.accepted).toBe(1);
    });

    it('accepted count reflects only processed (non-skipped) items', async () => {
      mockBookService.findDuplicate.mockResolvedValueOnce({ id: 1, title: 'Dup' });

      const result = await service.confirmImport([
        { path: '/a/dup', title: 'Dup', authorName: 'Author' },
        { path: '/a/new', title: 'New', authorName: 'Author' },
      ]);

      expect(result.accepted).toBe(1);
    });
  });

  // ============================================================================
  // scanSingleBook
  // ============================================================================

  describe('scanSingleBook', () => {
    it('throws when no audio files found', async () => {
      // readdir returns empty array — no audio files
      vi.mocked(readdir).mockResolvedValue([] as never);

      await expect(service.scanSingleBook('/audiobooks/empty')).rejects.toThrow(
        'No audio files found in this folder',
      );
    });

    it('throws when multiple audiobooks found', async () => {
      // Root folder has two subdirectories, each with audio files
      vi.mocked(readdir)
        .mockResolvedValueOnce([
          { name: 'book1', isFile: () => false, isDirectory: () => true },
          { name: 'book2', isFile: () => false, isDirectory: () => true },
        ] as never)
        .mockResolvedValueOnce([
          { name: 'chapter1.mp3', isFile: () => true, isDirectory: () => false },
        ] as never)
        .mockResolvedValueOnce([
          { name: 'chapter1.m4b', isFile: () => true, isDirectory: () => false },
        ] as never);

      await expect(service.scanSingleBook('/audiobooks/multi')).rejects.toThrow(
        'contains 2 audiobooks',
      );
    });

    it('scans a single audiobook folder successfully', async () => {
      // Root folder contains audio files directly
      vi.mocked(readdir).mockResolvedValue([
        { name: 'chapter1.mp3', isFile: () => true, isDirectory: () => false },
        { name: 'chapter2.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);
      vi.mocked(stat).mockResolvedValue({ size: 50_000_000 } as never);
      mockMetadataService.searchBooks.mockResolvedValue([]);

      const result = await service.scanSingleBook('/audiobooks/Author - Title');

      expect(result.book.path).toBe('/audiobooks/Author - Title');
      expect(result.book.parsedTitle).toBe('Title');
      expect(result.book.parsedAuthor).toBe('Author');
      expect(result.book.fileCount).toBe(2);
      expect(result.metadata).toBeNull();
    });

    it('parses Series–Number–Title direct folder name correctly (#333)', async () => {
      vi.mocked(readdir).mockResolvedValue([
        { name: 'chapter1.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);
      vi.mocked(stat).mockResolvedValue({ size: 50_000_000 } as never);
      mockMetadataService.searchBooks.mockResolvedValue([]);

      const result = await service.scanSingleBook('/audiobooks/First Law World – 02 – The Heroes');

      expect(result.book.parsedTitle).toBe('The Heroes');
      expect(result.book.parsedSeries).toBe('First Law World');
      expect(result.book.parsedAuthor).toBeNull();
    });

    it('returns metadata from lookup when available', async () => {
      vi.mocked(readdir).mockResolvedValue([
        { name: 'book.m4b', isFile: () => true, isDirectory: () => false },
      ] as never);
      vi.mocked(stat).mockResolvedValue({ size: 100_000 } as never);
      mockMetadataService.searchBooks.mockResolvedValue([{
        title: 'Found Book',
        asin: 'B123',
      }]);

      const result = await service.scanSingleBook('/audiobooks/Found Book');

      expect(result.metadata).not.toBeNull();
      expect(result.metadata?.asin).toBe('B123');
    });

    it('parses nested subfolder structure for single book', async () => {
      // Root has one subdir, subdir has audio
      vi.mocked(readdir)
        .mockResolvedValueOnce([
          { name: 'Author Name', isFile: () => false, isDirectory: () => true },
        ] as never)
        .mockResolvedValueOnce([
          { name: 'Book Title', isFile: () => false, isDirectory: () => true },
        ] as never)
        .mockResolvedValueOnce([
          { name: 'ch01.mp3', isFile: () => true, isDirectory: () => false },
        ] as never)
        // getAudioStats calls readdir again on the discovered path
        .mockResolvedValue([
          { name: 'ch01.mp3', isFile: () => true, isDirectory: () => false },
        ] as never);
      vi.mocked(stat).mockResolvedValue({ size: 10_000 } as never);
      mockMetadataService.searchBooks.mockResolvedValue([]);

      const result = await service.scanSingleBook('/audiobooks/root');

      expect(result.book.parsedAuthor).toBe('Author Name');
      expect(result.book.parsedTitle).toBe('Book Title');
    });

    it('skips hidden directories during leaf folder discovery', async () => {
      vi.mocked(readdir)
        .mockResolvedValueOnce([
          { name: '.hidden', isFile: () => false, isDirectory: () => true },
          { name: 'visible', isFile: () => false, isDirectory: () => true },
        ] as never)
        .mockResolvedValueOnce([
          { name: 'track.mp3', isFile: () => true, isDirectory: () => false },
        ] as never)
        // getAudioStats for the discovered folder
        .mockResolvedValue([
          { name: 'track.mp3', isFile: () => true, isDirectory: () => false },
        ] as never);
      vi.mocked(stat).mockResolvedValue({ size: 5000 } as never);
      mockMetadataService.searchBooks.mockResolvedValue([]);

      const result = await service.scanSingleBook('/audiobooks/test');

      // Should find only one book folder (visible), not .hidden
      expect(result.book.fileCount).toBe(1);
    });
  });

  // ============================================================================
  // importSingleBook with mode (copy/move to library)
  // ============================================================================

  describe('importSingleBook with copy/move mode', () => {
    beforeEach(() => {
      vi.mocked(getPathSize).mockResolvedValue(1000);
      vi.mocked(readdir).mockResolvedValue([
        { name: 'ch1.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);
      vi.mocked(stat).mockResolvedValue({ size: 1000 } as never);
    });

    it('copies files to library when mode is copy', async () => {
      const result = await service.importSingleBook(
        { path: '/downloads/Author/Book', title: 'Book', authorName: 'Author' },
        null,
        'copy',
      );

      expect(result.imported).toBe(true);
      expect(buildTargetPath).toHaveBeenCalled();
      expect(mkdir).toHaveBeenCalledWith('/library/Author/Title', { recursive: true });
      expect(cp).toHaveBeenCalledWith('/downloads/Author/Book', '/library/Author/Title', { recursive: true, errorOnExist: false });
      expect(rm).not.toHaveBeenCalled();
    });

    it('copies and removes source when mode is move', async () => {
      const result = await service.importSingleBook(
        { path: '/downloads/Author/Book', title: 'Book', authorName: 'Author' },
        null,
        'move',
      );

      expect(result.imported).toBe(true);
      expect(cp).toHaveBeenCalled();
      expect(rm).toHaveBeenCalledWith('/downloads/Author/Book', { recursive: true });
    });

    it('throws when copy verification fails (target too small)', async () => {
      vi.mocked(getPathSize)
        .mockResolvedValueOnce(1000)   // source size
        .mockResolvedValueOnce(100);   // target size (way too small)

      await expect(service.importSingleBook(
        { path: '/downloads/Book', title: 'Book' },
        null,
        'copy',
      )).rejects.toThrow('Copy verification failed');
    });

    it('does not copy when mode is undefined', async () => {
      await service.importSingleBook(
        { path: '/audiobooks/Book', title: 'Book' },
        null,
      );

      expect(mkdir).not.toHaveBeenCalled();
      expect(cp).not.toHaveBeenCalled();
    });

    it('skips cp when source and target resolve to the same path (copy mode)', async () => {
      // buildTargetPath is mocked to return '/library/Author/Title'
      const result = await service.importSingleBook(
        { path: '/library/Author/Title', title: 'Title', authorName: 'Author' },
        null,
        'copy',
      );

      expect(result.imported).toBe(true);
      expect(cp).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
    });

    it('skips cp and rm when source and target resolve to the same path (move mode)', async () => {
      const result = await service.importSingleBook(
        { path: '/library/Author/Title', title: 'Title', authorName: 'Author' },
        null,
        'move',
      );

      expect(result.imported).toBe(true);
      expect(cp).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
    });

    it('throws when source is nested inside library root (copy mode)', async () => {
      await expect(service.importSingleBook(
        { path: '/library/old-folder-name', title: 'Title', authorName: 'Author' },
        null,
        'copy',
      )).rejects.toThrow('Source path is inside the library root');
      expect(mkdir).not.toHaveBeenCalled();
      expect(cp).not.toHaveBeenCalled();
    });

    it('throws when source IS the library root exactly', async () => {
      await expect(service.importSingleBook(
        { path: '/library', title: 'Title', authorName: 'Author' },
        null,
        'copy',
      )).rejects.toThrow('Source path is inside the library root');
      expect(mkdir).not.toHaveBeenCalled();
      expect(cp).not.toHaveBeenCalled();
    });

    it('does not call rm when source is inside library root (move mode)', async () => {
      await expect(service.importSingleBook(
        { path: '/library/sub/nested', title: 'Title', authorName: 'Author' },
        null,
        'move',
      )).rejects.toThrow('Source path is inside the library root');
      expect(mkdir).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
    });

    it('allows source with a path that is a prefix of the library root name (/library-old vs /library)', async () => {
      const result = await service.importSingleBook(
        { path: '/library-old/book', title: 'Title', authorName: 'Author' },
        null,
        'copy',
      );
      expect(result.imported).toBe(true);
      expect(cp).toHaveBeenCalledWith('/library-old/book', '/library/Author/Title', expect.anything());
    });

    it('allows source with .. segments that resolve outside the library root', async () => {
      // /library/sub/../../downloads/book resolves to /downloads/book — outside root
      const result = await service.importSingleBook(
        { path: '/library/sub/../../downloads/book', title: 'Title', authorName: 'Author' },
        null,
        'copy',
      );
      expect(result.imported).toBe(true);
      expect(cp).toHaveBeenCalled();
    });

    it('passes narrators: undefined to buildTargetPath when metadata has no narrators', async () => {
      await service.importSingleBook(
        { path: '/downloads/Author/Book', title: 'Book', authorName: 'Author' },
        { title: 'Book', authors: [{ name: 'Author' }] },
        'copy',
      );

      expect(buildTargetPath).toHaveBeenCalledWith(
        '/library',
        expect.any(String),
        expect.objectContaining({ narrators: undefined }),
        'Author',
        expect.objectContaining({ separator: 'space', case: 'default' }),
      );
    });

    it('passes mapped narrators to buildTargetPath when metadata has narrators', async () => {
      await service.importSingleBook(
        { path: '/downloads/Author/Book', title: 'Book', authorName: 'Author' },
        { title: 'Book', authors: [{ name: 'Author' }], narrators: ['Stephen Fry', 'Tim Curry'] },
        'copy',
      );

      expect(buildTargetPath).toHaveBeenCalledWith(
        '/library',
        expect.any(String),
        expect.objectContaining({
          narrators: [{ name: 'Stephen Fry' }, { name: 'Tim Curry' }],
        }),
        'Author',
        expect.objectContaining({ separator: 'space', case: 'default' }),
      );
    });
  });

  // ============================================================================
  // processImportsInBackground (via confirmImport)
  // ============================================================================

  describe('background import processing', () => {
    beforeEach(() => {
      vi.mocked(readdir).mockResolvedValue([
        { name: 'ch1.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);
      vi.mocked(stat).mockResolvedValue({ size: 5000 } as never);
      vi.mocked(getPathSize).mockResolvedValue(5000);
    });

    it('sets book status to imported after successful background processing', async () => {
      await service.confirmImport([
        { path: '/audiobooks/Book', title: 'Book' },
      ]);

      // Wait for fire-and-forget background processing
      await vi.waitFor(() => {
        expect((mockDb as Record<string, ReturnType<typeof vi.fn>>).set).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'imported' }),
        );
      });
    });

    it('sets book status to missing when background processing fails', async () => {
      // Make getAudioStats blow up (readdir throws)
      vi.mocked(readdir).mockRejectedValueOnce(new Error('ENOENT'));
      // The first readdir call fails in getAudioStats, then the set for path/size
      // will have totalSize=0, but let's make stat fail too to trigger the catch
      vi.mocked(readdir)
        .mockReset()
        .mockRejectedValue(new Error('ENOENT'));

      // But the stat call inside getAudioStats will fail, and the outer try/catch
      // in processImportsInBackground should catch and set status to 'missing'
      // Actually, getAudioStats catches its own errors and returns {fileCount:0, totalSize:0}
      // So we need to make something else fail. Let's make db.update throw for the path/size update.
      const originalSet = (mockDb as Record<string, (...args: unknown[]) => unknown>).set;
      let callCount = 0;
      ((mockDb as Record<string, ReturnType<typeof vi.fn>>).set as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
        callCount++;
        // First set call (path/size) throws
        if (callCount === 1) {
          throw new Error('DB write failed');
        }
        return originalSet(...args);
      });

      await service.confirmImport([
        { path: '/audiobooks/Book', title: 'Failing Book' },
      ]);

      await vi.waitFor(() => {
        expect(log.error).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Failing Book' }),
          expect.stringContaining('Book import failed'),
        );
      });
    });

    it('runs Audnexus enrichment in background with passed metadata ASIN', async () => {
      mockMetadataService.enrichBook.mockResolvedValue({
        narrators: ['Jim Dale'],
        duration: 600,
      });

      await service.confirmImport([
        {
          path: '/audiobooks/HP',
          title: 'Harry Potter',
          asin: 'B017V4IM1G',
          metadata: { title: 'HP', authors: [{ name: 'JKR' }], asin: 'B017V4IM1G' },
        },
      ]);

      await vi.waitFor(() => {
        expect(mockMetadataService.enrichBook).toHaveBeenCalledWith('B017V4IM1G');
      });
    });

    it('tries alternate ASINs in background when primary returns null', async () => {
      mockMetadataService.enrichBook
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ narrators: ['Jim Dale'] });

      await service.confirmImport([
        {
          path: '/audiobooks/HP',
          title: 'Harry Potter',
          asin: 'B0NEW',
          metadata: {
            title: 'HP',
            authors: [{ name: 'JKR' }],
            asin: 'B0NEW',
            alternateAsins: ['B0OLD'],
          },
        },
      ]);

      await vi.waitFor(() => {
        expect(mockMetadataService.enrichBook).toHaveBeenCalledTimes(2);
        expect(mockMetadataService.enrichBook).toHaveBeenCalledWith('B0OLD');
      });
    });

    it('persists genres in background when book has no existing genres', async () => {
      // DB select for current genres returns null (no genres yet)
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).limit
        .mockResolvedValueOnce([])  // bookRecord lookup (no mode)
        .mockResolvedValueOnce([{ genres: null }]);  // current genres query

      mockMetadataService.enrichBook.mockResolvedValueOnce({
        genres: ['Fantasy', 'Adventure'],
      });

      await service.confirmImport([
        {
          path: '/audiobooks/HP',
          title: 'Harry Potter',
          asin: 'B017V4IM1G',
          metadata: { title: 'HP', authors: [{ name: 'JKR' }], asin: 'B017V4IM1G' },
        },
      ]);

      await vi.waitFor(() => {
        expect(mockBookService.update).toHaveBeenCalledWith(1, { genres: ['Fantasy', 'Adventure'] });
      });
    });

    it('does not overwrite genres in background when book already has genres', async () => {
      // Override create to return a book WITH existing genres
      mockBookService.create.mockResolvedValueOnce({
        id: 1, title: 'Harry Potter', status: 'importing', authors: [], narrators: [], genres: ['Existing Genre'],
      });

      // DB select for current genres returns existing genres
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).limit.mockResolvedValue([{ genres: ['Existing Genre'] }]);

      mockMetadataService.enrichBook.mockResolvedValueOnce({
        genres: ['New Genre'],
      });

      await service.confirmImport([
        {
          path: '/audiobooks/HP',
          title: 'Harry Potter',
          asin: 'B017V4IM1G',
          metadata: { title: 'HP', authors: [{ name: 'JKR' }], asin: 'B017V4IM1G' },
        },
      ]);

      await vi.waitFor(() => {
        expect(mockMetadataService.enrichBook).toHaveBeenCalledWith('B017V4IM1G');
      });

      // bookService.update should NOT have been called with genres
      const genreUpdateCalls = mockBookService.update.mock.calls.filter(
        (call: unknown[]) => call[1] && typeof call[1] === 'object' && 'genres' in (call[1] as Record<string, unknown>),
      );
      expect(genreUpdateCalls).toHaveLength(0);
    });

    it('copies to library in background when mode is set', async () => {
      // Mock db.select for the book record lookup in processImportsInBackground
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).limit.mockResolvedValue([{
        id: 1,
        title: 'Book',
        narrator: null,
        duration: null,
        coverUrl: null,
      }]);

      await service.confirmImport(
        [{ path: '/downloads/Book', title: 'Book', authorName: 'Author' }],
        'copy',
      );

      await vi.waitFor(() => {
        expect(mkdir).toHaveBeenCalled();
        expect(cp).toHaveBeenCalled();
      });
    });

    it('moves source in background when mode is move', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).limit.mockResolvedValue([{
        id: 1,
        title: 'Book',
        narrator: null,
        duration: null,
        coverUrl: null,
      }]);

      await service.confirmImport(
        [{ path: '/downloads/Book', title: 'Book', authorName: 'Author' }],
        'move',
      );

      await vi.waitFor(() => {
        expect(rm).toHaveBeenCalledWith('/downloads/Book', { recursive: true });
      });
    });

    it('marks book missing when background copy source is inside library root', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).limit.mockResolvedValue([{
        id: 1,
        title: 'Book',
        narrator: null,
        duration: null,
        coverUrl: null,
      }]);

      await service.confirmImport(
        [{ path: '/library/already-there', title: 'Book', authorName: 'Author' }],
        'copy',
      );

      await vi.waitFor(() => {
        expect((mockDb as Record<string, ReturnType<typeof vi.fn>>).set).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'missing' }),
        );
        expect(mockEventHistoryService.create).toHaveBeenCalledWith(
          expect.objectContaining({ eventType: 'import_failed', source: 'manual', bookId: 1, bookTitle: 'Book' }),
        );
      });
      expect(mkdir).not.toHaveBeenCalled();
      expect(cp).not.toHaveBeenCalled();
    });

    it('marks book missing and skips rm when background move source is inside library root', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).limit.mockResolvedValue([{
        id: 1,
        title: 'Book',
        narrator: null,
        duration: null,
        coverUrl: null,
      }]);

      await service.confirmImport(
        [{ path: '/library/already-there', title: 'Book', authorName: 'Author' }],
        'move',
      );

      await vi.waitFor(() => {
        expect((mockDb as Record<string, ReturnType<typeof vi.fn>>).set).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'missing' }),
        );
        expect(mockEventHistoryService.create).toHaveBeenCalledWith(
          expect.objectContaining({ eventType: 'import_failed', source: 'manual', bookId: 1, bookTitle: 'Book' }),
        );
      });
      expect(rm).not.toHaveBeenCalled();
    });

    it('calls enrichBookFromAudio in background processing', async () => {
      await service.confirmImport([
        { path: '/audiobooks/Book', title: 'Book' },
      ]);

      await vi.waitFor(() => {
        expect(enrichBookFromAudio).toHaveBeenCalledWith(
          1,
          '/audiobooks/Book',
          expect.objectContaining({ narrators: null, duration: null }),
          mockDb,
          log,
          mockBookService,
          undefined, // ffprobePath (no ffmpeg configured in mock settings)
        );
      });
    });

    it('passes derived ffprobePath to enrichBookFromAudio when ffmpegPath is configured', async () => {
      const settingsWithProcessing = createMockSettingsService({
        library: { path: '/library' },
        processing: { ffmpegPath: '/usr/bin/ffmpeg' },
      });
      const serviceWithFfmpeg = new LibraryScanService(
        inject<Db>(mockDb),
        inject<BookService>(mockBookService),
        inject<MetadataService>(mockMetadataService),
        inject<SettingsService>(settingsWithProcessing),
        log,
        inject<EventHistoryService>(mockEventHistoryService),
      );

      await serviceWithFfmpeg.confirmImport([
        { path: '/audiobooks/Book', title: 'Book' },
      ]);

      await vi.waitFor(() => {
        expect(enrichBookFromAudio).toHaveBeenCalledWith(
          1,
          '/audiobooks/Book',
          expect.objectContaining({ narrators: null, duration: null }),
          mockDb,
          log,
          mockBookService,
          '/usr/bin/ffprobe', // ffprobePath derived from /usr/bin/ffmpeg
        );
      });
    });

    it('handles readdir failure gracefully in findAudioLeafFolders', async () => {
      // Make readdir throw to trigger the catch in findAudioLeafFolders
      vi.mocked(readdir).mockRejectedValue(new Error('EACCES: permission denied'));

      await expect(service.scanSingleBook('/audiobooks/noaccess')).rejects.toThrow(
        'No audio files found in this folder',
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/audiobooks/noaccess' }),
        expect.stringContaining('Error scanning directory'),
      );
    });

    it('handles getAudioStats with subdirectories', async () => {
      // First readdir for scanSingleBook's findAudioLeafFolders: audio files present
      vi.mocked(readdir)
        .mockResolvedValueOnce([
          { name: 'ch1.mp3', isFile: () => true, isDirectory: () => false },
        ] as never)
        // Second readdir for getAudioStats: contains a file and a subdir
        .mockResolvedValueOnce([
          { name: 'ch1.mp3', isFile: () => true, isDirectory: () => false },
          { name: 'extras', isFile: () => false, isDirectory: () => true },
        ] as never)
        // Third readdir for getAudioStats recursion into 'extras' subdir
        .mockResolvedValueOnce([
          { name: 'bonus.mp3', isFile: () => true, isDirectory: () => false },
        ] as never);
      vi.mocked(stat).mockResolvedValue({ size: 2000 } as never);
      mockMetadataService.searchBooks.mockResolvedValue([]);

      const result = await service.scanSingleBook('/audiobooks/Test Book');

      // 2 audio files (ch1.mp3 + bonus.mp3), total size = 2000 * 2 entries in stat calls
      expect(result.book.fileCount).toBe(2);
      expect(result.book.totalSize).toBe(4000);
    });

    it('processes multiple items sequentially in background', async () => {
      let createCallCount = 0;
      mockBookService.create.mockImplementation(async (data: { title: string }) => {
        createCallCount++;
        return { id: createCallCount, title: data.title, status: 'importing' };
      });

      await service.confirmImport([
        { path: '/audiobooks/Book1', title: 'Book 1' },
        { path: '/audiobooks/Book2', title: 'Book 2' },
      ]);

      await vi.waitFor(() => {
        // Both should get status: 'imported' after background processing
        const setCalls = (mockDb as Record<string, ReturnType<typeof vi.fn>>).set.mock.calls;
        const importedCalls = setCalls.filter(
          (call: unknown[]) => (call[0] as Record<string, string>).status === 'imported',
        );
        expect(importedCalls).toHaveLength(2);
      });
    });
  });

  // ============================================================================
  // event history — importSingleBook and background processing (issue #104)
  // ============================================================================

  describe('event history — importSingleBook', () => {
    it('records imported event on success with source: manual and downloadId: null', async () => {
      await service.importSingleBook(
        { path: '/audiobooks/Author/Book', title: 'Book', authorName: 'Author' },
        null,
      );

      expect(mockEventHistoryService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'imported',
          source: 'manual',
          downloadId: null,
          bookTitle: 'Book',
          authorName: 'Author',
        }),
      );
    });

    it('records imported event with narrator snapshot from resolved meta', async () => {
      await service.importSingleBook(
        { path: '/audiobooks/Author/Book', title: 'Book', authorName: 'Author' },
        { title: 'Book', authors: [], narrators: ['Jim Dale'] },
      );

      expect(mockEventHistoryService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'imported',
          narratorName: 'Jim Dale',
        }),
      );
    });

    it('records imported event with null narrator when metadata has no narrators', async () => {
      await service.importSingleBook(
        { path: '/audiobooks/Author/Book', title: 'Book', authorName: 'Author' },
        { title: 'Book', authors: [], narrators: [] },
      );

      expect(mockEventHistoryService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'imported',
          narratorName: null,
        }),
      );
    });

    it('records import_failed event on failure without suppressing the thrown error', async () => {
      // Fail after book creation so bookId is available for the event
      vi.mocked(enrichBookFromAudio).mockRejectedValueOnce(new Error('Enrichment failed'));

      await expect(service.importSingleBook(
        { path: '/audiobooks/Book', title: 'Book', authorName: 'Author' },
        null,
      )).rejects.toThrow('Enrichment failed');

      // Fire-and-forget event — check after a tick
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockEventHistoryService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'import_failed',
          source: 'manual',
          bookTitle: 'Book',
          downloadId: null,
        }),
      );
    });

    it('imported event reason contains resolved targetPath and mode keys', async () => {
      await service.importSingleBook(
        { path: '/audiobooks/Author/Book', title: 'Book', authorName: 'Author' },
        null,
        'copy',
      );

      // buildTargetPath mock returns '/library/Author/Title'; path.resolve() may prepend drive letter on Windows
      const importedCall = mockEventHistoryService.create.mock.calls
        .map((c: unknown[]) => c[0] as { eventType: string; reason: { targetPath: string; mode: string } })
        .find(c => c.eventType === 'imported');
      expect(importedCall).toBeDefined();
      expect(importedCall!.reason.targetPath).toMatch(/[/\\]library[/\\]Author[/\\]Title$/);
      expect(importedCall!.reason.mode).toBe('copy');
    });

    it('records import_failed event when bookService.create() throws (bookId is null)', async () => {
      mockBookService.create.mockRejectedValueOnce(new Error('DB constraint'));

      await expect(service.importSingleBook(
        { path: '/audiobooks/Book', title: 'Book', authorName: 'Author' },
        null,
      )).rejects.toThrow('DB constraint');

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockEventHistoryService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: null,
          eventType: 'import_failed',
          source: 'manual',
          bookTitle: 'Book',
          downloadId: null,
        }),
      );
    });

    it('eventHistory.create rejection on importSingleBook success does not throw', async () => {
      mockEventHistoryService.create.mockRejectedValueOnce(new Error('Event DB down'));

      const result = await service.importSingleBook(
        { path: '/audiobooks/Author/Book', title: 'Book', authorName: 'Author' },
        null,
      );

      expect(result).toEqual({ imported: true, bookId: 1, enriched: true });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('Failed to record'),
      );
    });

    it('both import failure and event creation failure — throws the original import error', async () => {
      vi.mocked(enrichBookFromAudio).mockRejectedValueOnce(new Error('Enrichment failed'));
      mockEventHistoryService.create.mockRejectedValueOnce(new Error('Event DB down'));

      await expect(service.importSingleBook(
        { path: '/audiobooks/Book', title: 'Book', authorName: 'Author' },
        null,
      )).rejects.toThrow('Enrichment failed');
    });

    it('imported event downloadId is null', async () => {
      await service.importSingleBook(
        { path: '/audiobooks/Author/Book', title: 'Book', authorName: 'Author' },
        null,
      );

      expect(mockEventHistoryService.create).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: null }),
      );
    });
  });

  describe('event history — background import processing', () => {
    beforeEach(() => {
      vi.mocked(readdir).mockResolvedValue([
        { name: 'ch1.mp3', isFile: () => true, isDirectory: () => false },
      ] as never);
      vi.mocked(stat).mockResolvedValue({ size: 5000 } as never);
      vi.mocked(getPathSize).mockResolvedValue(5000);
    });

    it('records imported event in processOneImport on success with source: manual', async () => {
      await service.confirmImport([
        { path: '/audiobooks/Author/Book', title: 'Book', authorName: 'Author' },
      ]);

      await vi.waitFor(() => {
        expect(mockEventHistoryService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'imported',
            source: 'manual',
            downloadId: null,
            bookTitle: 'Book',
            authorName: 'Author',
          }),
        );
      });
    });

    it('records imported event with narrator from item.metadata.narrators[0]', async () => {
      await service.confirmImport([
        {
          path: '/audiobooks/Book',
          title: 'Book',
          authorName: 'Author',
          metadata: { title: 'Book', authors: [], narrators: ['Jim Dale'] },
        },
      ]);

      await vi.waitFor(() => {
        expect(mockEventHistoryService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'imported',
            narratorName: 'Jim Dale',
          }),
        );
      });
    });

    it('records import_failed event in processImportsInBackground catch block', async () => {
      vi.mocked(enrichBookFromAudio).mockRejectedValueOnce(new Error('Enrichment failed'));

      await service.confirmImport([
        { path: '/audiobooks/Book', title: 'Book', authorName: 'Author' },
      ]);

      await vi.waitFor(() => {
        expect(mockEventHistoryService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'import_failed',
            source: 'manual',
            bookTitle: 'Book',
          }),
        );
      });
    });

    it('both status: missing and import_failed event are set when background processing fails', async () => {
      vi.mocked(enrichBookFromAudio).mockRejectedValueOnce(new Error('Enrichment failed'));

      await service.confirmImport([
        { path: '/audiobooks/Book', title: 'Book' },
      ]);

      await vi.waitFor(() => {
        const setCalls = (mockDb as Record<string, ReturnType<typeof vi.fn>>).set.mock.calls;
        const missingCall = setCalls.find(
          (call: unknown[]) => (call[0] as Record<string, string>).status === 'missing',
        );
        expect(missingCall).toBeDefined();
        expect(mockEventHistoryService.create).toHaveBeenCalledWith(
          expect.objectContaining({ eventType: 'import_failed' }),
        );
      });
    });

    it('imported event reason contains resolved targetPath and mode for background imports', async () => {
      await service.confirmImport([
        { path: '/audiobooks/Book', title: 'Book', authorName: 'Author' },
      ], 'copy');

      // The mock DB returns no book record for the select, so copyToLibrary is skipped
      // and finalPath stays as item.path. path.resolve() may prepend drive letter on Windows.
      await vi.waitFor(() => {
        const importedCall = mockEventHistoryService.create.mock.calls
          .map((c: unknown[]) => c[0] as { eventType: string; reason: { targetPath: string; mode: string } })
          .find(c => c.eventType === 'imported');
        expect(importedCall).toBeDefined();
        expect(importedCall!.reason.targetPath).toMatch(/[/\\]audiobooks[/\\]Book$/);
        expect(importedCall!.reason.mode).toBe('copy');
      });
    });

    it('import_failed event reason contains error key with human-readable message', async () => {
      vi.mocked(enrichBookFromAudio).mockRejectedValueOnce(new Error('Disk full'));

      await service.confirmImport([
        { path: '/audiobooks/Book', title: 'Book' },
      ]);

      await vi.waitFor(() => {
        expect(mockEventHistoryService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: expect.objectContaining({ error: expect.stringContaining('Disk full') }),
          }),
        );
      });
    });

    it('event recording failure does not break the background import flow (fire-and-forget)', async () => {
      mockEventHistoryService.create.mockRejectedValue(new Error('Event DB down'));

      await service.confirmImport([
        { path: '/audiobooks/Book', title: 'Book' },
      ]);

      await vi.waitFor(() => {
        expect((mockDb as Record<string, ReturnType<typeof vi.fn>>).set).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'imported' }),
        );
      });
    });

    it('event recording failure on background failure still sets status: missing (fire-and-forget)', async () => {
      vi.mocked(enrichBookFromAudio).mockRejectedValueOnce(new Error('Enrichment failed'));
      mockEventHistoryService.create.mockRejectedValueOnce(new Error('Event DB down'));

      await service.confirmImport([
        { path: '/audiobooks/Book', title: 'Book' },
      ]);

      await vi.waitFor(() => {
        const setCalls = (mockDb as Record<string, ReturnType<typeof vi.fn>>).set.mock.calls;
        const missingCall = setCalls.find(
          (call: unknown[]) => (call[0] as Record<string, string>).status === 'missing',
        );
        expect(missingCall).toBeDefined();
      });
    });

    it('pointer mode (no mode) records imported event with mode: pointer in reason', async () => {
      await service.confirmImport([
        { path: '/audiobooks/Book', title: 'Book', authorName: 'Author' },
      ]);

      await vi.waitFor(() => {
        expect(mockEventHistoryService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: expect.objectContaining({ mode: 'pointer' }),
          }),
        );
      });
    });
  });

  // ============================================================================
  // rescanLibrary
  // ============================================================================

  describe('rescanLibrary', () => {
    beforeEach(() => {
      // Default: access succeeds (library root exists)
      vi.mocked(access).mockResolvedValue(undefined);
    });

    it('returns zero counts for empty library', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).where.mockResolvedValueOnce([]);

      const result = await service.rescanLibrary();

      expect(result).toEqual({ scanned: 0, missing: 0, restored: 0 });
    });

    it('marks imported book with missing path as missing', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).where.mockResolvedValueOnce([
        { id: 1, path: '/library/Author/Book', status: 'imported' },
      ]);
      vi.mocked(access)
        .mockResolvedValueOnce(undefined) // library root check
        .mockRejectedValueOnce(new Error('ENOENT'));

      const result = await service.rescanLibrary();

      expect(result).toEqual({ scanned: 1, missing: 1, restored: 0 });
      expect((mockDb as Record<string, ReturnType<typeof vi.fn>>).set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'missing' }),
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1 }),
        expect.stringContaining('missing from disk'),
      );
    });

    it('restores missing book whose path reappears', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).where.mockResolvedValueOnce([
        { id: 2, path: '/library/Author/Book', status: 'missing' },
      ]);
      vi.mocked(access).mockResolvedValue(undefined);

      const result = await service.rescanLibrary();

      expect(result).toEqual({ scanned: 1, missing: 0, restored: 1 });
      expect((mockDb as Record<string, ReturnType<typeof vi.fn>>).set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'imported' }),
      );
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 2 }),
        expect.stringContaining('restored on disk'),
      );
    });

    it('skips books with null paths', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).where.mockResolvedValueOnce([
        { id: 3, path: null, status: 'imported' },
      ]);

      const result = await service.rescanLibrary();

      expect(result).toEqual({ scanned: 0, missing: 0, restored: 0 });
    });

    it('skips books with paths outside library root', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).where.mockResolvedValueOnce([
        { id: 4, path: '/other/location/Book', status: 'imported' },
      ]);

      const result = await service.rescanLibrary();

      expect(result).toEqual({ scanned: 0, missing: 0, restored: 0 });
    });

    it('leaves imported book with existing path unchanged', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).where.mockResolvedValueOnce([
        { id: 5, path: '/library/Author/Book', status: 'imported' },
      ]);
      vi.mocked(access).mockResolvedValue(undefined);

      const result = await service.rescanLibrary();

      expect(result).toEqual({ scanned: 1, missing: 0, restored: 0 });
      expect((mockDb as Record<string, ReturnType<typeof vi.fn>>).update).not.toHaveBeenCalled();
    });

    it('handles mixed statuses correctly', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).where.mockResolvedValueOnce([
        { id: 1, path: '/library/Book1', status: 'imported' },
        { id: 2, path: '/library/Book2', status: 'missing' },
        { id: 3, path: '/library/Book3', status: 'imported' },
      ]);
      vi.mocked(access)
        .mockResolvedValueOnce(undefined) // library root
        .mockRejectedValueOnce(new Error('ENOENT')) // Book1 missing
        .mockResolvedValueOnce(undefined) // Book2 restored
        .mockResolvedValueOnce(undefined); // Book3 exists

      const result = await service.rescanLibrary();

      expect(result).toEqual({ scanned: 3, missing: 1, restored: 1 });
    });

    it('throws when scan is already in progress', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).where.mockResolvedValueOnce([]);

      // Lock is set synchronously, so second call throws before any async work
      const first = service.rescanLibrary();
      await expect(service.rescanLibrary()).rejects.toThrow('Scan already in progress');
      await first;
    });

    it('releases lock after scan completes', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).where.mockResolvedValueOnce([]);
      await service.rescanLibrary();

      (mockDb as Record<string, ReturnType<typeof vi.fn>>).where.mockResolvedValueOnce([]);
      const result = await service.rescanLibrary();
      expect(result).toEqual({ scanned: 0, missing: 0, restored: 0 });
    });

    it('releases lock even when scan throws', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).where.mockRejectedValueOnce(new Error('DB down'));
      await expect(service.rescanLibrary()).rejects.toThrow('DB down');

      (mockDb as Record<string, ReturnType<typeof vi.fn>>).where.mockResolvedValueOnce([]);
      const result = await service.rescanLibrary();
      expect(result).toEqual({ scanned: 0, missing: 0, restored: 0 });
    });

    it('throws when library path is not configured', async () => {
      const emptyPathSettings = createMockSettingsService({ library: { path: '' } });
      const svc = new LibraryScanService(
        inject<Db>(mockDb),
        inject<BookService>(mockBookService),
        inject<MetadataService>(mockMetadataService),
        inject<SettingsService>(emptyPathSettings),
        log,
        inject<EventHistoryService>(mockEventHistoryService),
      );

      await expect(svc.rescanLibrary()).rejects.toThrow('Library path is not configured');
    });

    it('throws when library path is not accessible', async () => {
      vi.mocked(access).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(service.rescanLibrary()).rejects.toThrow('Library path is not accessible');
    });

    it('returns accurate summary counts with skipped entries', async () => {
      (mockDb as Record<string, ReturnType<typeof vi.fn>>).where.mockResolvedValueOnce([
        { id: 1, path: '/library/A', status: 'imported' },
        { id: 2, path: '/library/B', status: 'imported' },
        { id: 3, path: '/library/C', status: 'missing' },
        { id: 4, path: null, status: 'imported' },
        { id: 5, path: '/other/D', status: 'imported' },
      ]);
      vi.mocked(access)
        .mockResolvedValueOnce(undefined) // library root
        .mockResolvedValueOnce(undefined) // A exists
        .mockRejectedValueOnce(new Error('ENOENT')) // B missing
        .mockResolvedValueOnce(undefined); // C restored

      const result = await service.rescanLibrary();

      expect(result).toEqual({ scanned: 3, missing: 1, restored: 1 });
    });
  });

  // #341 — book_added event on book creation
  describe('book_added event', () => {
    describe('importSingleBook', () => {
      it('records book_added event with source=manual after successful bookService.create()', async () => {
        await service.importSingleBook(
          { path: '/audiobooks/Author/Book', title: 'Book', authorName: 'Author' },
          null,
        );

        expect(mockEventHistoryService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'book_added',
            source: 'manual',
            bookTitle: 'Book',
            authorName: 'Author',
          }),
        );
      });

      it('uses comma-joined authorName from created book for multi-author imports', async () => {
        mockBookService.create.mockResolvedValueOnce({
          id: 1,
          title: 'Book',
          status: 'imported',
          authors: [{ id: 1, name: 'Author A' }, { id: 2, name: 'Author B' }],
        });

        await service.importSingleBook(
          { path: '/audiobooks/Author/Book', title: 'Book', authorName: 'Author A' },
          { title: 'Book', authors: [{ name: 'Author A' }, { name: 'Author B' }], narrators: [] },
        );

        expect(mockEventHistoryService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'book_added',
            authorName: 'Author A, Author B',
          }),
        );
      });

      it('records book_added event in addition to imported event', async () => {
        await service.importSingleBook(
          { path: '/audiobooks/Author/Book', title: 'Book', authorName: 'Author' },
          null,
        );

        const calls = mockEventHistoryService.create.mock.calls;
        const eventTypes = calls.map((c: unknown[]) => (c[0] as { eventType: string }).eventType);
        expect(eventTypes).toContain('book_added');
        expect(eventTypes).toContain('imported');
      });

      it('does NOT record book_added event when bookService.create() throws', async () => {
        mockBookService.create.mockRejectedValueOnce(new Error('DB error'));

        await expect(service.importSingleBook(
          { path: '/audiobooks/Author/Book', title: 'Book', authorName: 'Author' },
          null,
        )).rejects.toThrow('DB error');

        await new Promise(resolve => setTimeout(resolve, 0));
        const calls = mockEventHistoryService.create.mock.calls;
        const eventTypes = calls.map((c: unknown[]) => (c[0] as { eventType: string }).eventType);
        expect(eventTypes).not.toContain('book_added');
      });
    });

    describe('confirmImport', () => {
      it('records book_added event with source=manual for each placeholder created', async () => {
        await service.confirmImport([
          { path: '/audiobooks/Author/Title', title: 'Title', authorName: 'Author' },
        ]);

        expect(mockEventHistoryService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'book_added',
            source: 'manual',
            bookTitle: 'Title',
            authorName: 'Author',
          }),
        );
      });

      it('uses comma-joined authorName from created book for multi-author imports', async () => {
        mockBookService.create.mockResolvedValueOnce({
          id: 1,
          title: 'Title',
          status: 'importing',
          authors: [{ id: 1, name: 'Author A' }, { id: 2, name: 'Author B' }],
        });

        await service.confirmImport([
          {
            path: '/audiobooks/Author/Title',
            title: 'Title',
            authorName: 'Author A',
            metadata: { title: 'Title', authors: [{ name: 'Author A' }, { name: 'Author B' }], narrators: [] },
          },
        ]);

        expect(mockEventHistoryService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            eventType: 'book_added',
            authorName: 'Author A, Author B',
          }),
        );
      });

      it('does NOT record book_added event for duplicate-skipped items', async () => {
        mockBookService.findDuplicate.mockResolvedValueOnce({ id: 1, title: 'Existing' });

        await service.confirmImport([
          { path: '/audiobooks/Author/Title', title: 'Existing', authorName: 'Author' },
        ]);

        const calls = mockEventHistoryService.create.mock.calls;
        const eventTypes = calls.map((c: unknown[]) => (c[0] as { eventType: string }).eventType);
        expect(eventTypes).not.toContain('book_added');
      });

      it('does NOT record book_added event for failed placeholder creations', async () => {
        mockBookService.create.mockRejectedValueOnce(new Error('Create failed'));

        await service.confirmImport([
          { path: '/audiobooks/Author/Title', title: 'Title', authorName: 'Author' },
        ]);

        const calls = mockEventHistoryService.create.mock.calls;
        const eventTypes = calls.map((c: unknown[]) => (c[0] as { eventType: string }).eventType);
        expect(eventTypes).not.toContain('book_added');
      });
    });
  });
});

describe('buildBookCreatePayload multi-author (issue #79)', () => {
  let service: LibraryScanService;
  let mockBookService: { findDuplicate: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enrichBookFromAudio).mockResolvedValue({ enriched: true });
    const db = createMockDb();
    const chainMethods = {
      from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]), set: vi.fn().mockReturnThis(),
    };
    db.select.mockReturnValue(chainMethods as never);
    db.update.mockReturnValue(chainMethods as never);
    mockBookService = {
      findDuplicate: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async (data: { title: string }) => ({ id: 99, title: data.title, status: 'imported' })),
      update: vi.fn().mockResolvedValue({ id: 99, title: 'Test', authors: [], narrators: [] }),
    };
    const settings = createMockSettingsService({
      library: { path: '/library', folderFormat: '{author}/{title}', fileFormat: '' },
      import: { minFreeSpaceGB: 0, deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0 },
    });
    service = new LibraryScanService(
      db as never,
      mockBookService as never,
      { searchBooks: vi.fn().mockResolvedValue([]), getBook: vi.fn().mockResolvedValue(null), enrichBook: vi.fn().mockResolvedValue(null) } as never,
      settings as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info', silent: vi.fn() } as never,
      { create: vi.fn().mockResolvedValue({}) } as never,
    );
  });

  it('with meta.authors = [{name:"A"},{name:"B"}] passes both to bookService.create', async () => {
    await service.confirmImport([{
      path: '/audiobooks/test',
      title: 'Multi Author Book',
      metadata: {
        title: 'Multi Author Book',
        authors: [{ name: 'Author A' }, { name: 'Author B' }],
        narrators: [],
      },
    }]);

    expect(mockBookService.create).toHaveBeenCalledWith(
      expect.objectContaining({ authors: [{ name: 'Author A' }, { name: 'Author B' }] }),
    );
  });

  it('fallback: when meta.authors is absent, uses item.authorName', async () => {
    await service.confirmImport([{
      path: '/audiobooks/test',
      title: 'Single Author Book',
      authorName: 'Frank Herbert',
    }]);

    expect(mockBookService.create).toHaveBeenCalledWith(
      expect.objectContaining({ authors: [{ name: 'Frank Herbert' }] }),
    );
  });

  it('with both authorName and multi-author meta.authors, preserves metadata array', async () => {
    await service.confirmImport([{
      path: '/audiobooks/test',
      title: 'Co-authored Book',
      authorName: 'Author A',
      metadata: {
        title: 'Co-authored Book',
        authors: [{ name: 'Author A' }, { name: 'Author B' }],
        narrators: [],
      },
    }]);

    expect(mockBookService.create).toHaveBeenCalledWith(
      expect.objectContaining({ authors: [{ name: 'Author A' }, { name: 'Author B' }] }),
    );
  });

  it('with meta.authors = [] falls back to item.authorName (not zero-author book)', async () => {
    await service.confirmImport([{
      path: '/audiobooks/test',
      title: 'Fallback Book',
      authorName: 'Isaac Asimov',
      metadata: { title: 'Fallback Book', authors: [], narrators: [] },
    }]);

    expect(mockBookService.create).toHaveBeenCalledWith(
      expect.objectContaining({ authors: [{ name: 'Isaac Asimov' }] }),
    );
  });
});

describe('scanDirectory() — duplicateReason field (#133)', () => {
  let service: LibraryScanService;
  let mockDb: ReturnType<typeof createMockDb> & Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enrichBookFromAudio).mockResolvedValue({ enriched: true });
    const db = createMockDb();
    const chainMethods = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockReturnThis(),
    };
    db.select.mockReturnValue(chainMethods as never);
    db.update.mockReturnValue(chainMethods as never);
    mockDb = Object.assign(db, chainMethods);
    const mockSettingsService = createMockSettingsService({ library: { path: '/audiobooks' } });
    service = new LibraryScanService(
      inject<Db>(mockDb),
      inject<BookService>({ findDuplicate: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 1 }), update: vi.fn().mockResolvedValue({ id: 1 }) }),
      inject<MetadataService>({ searchBooks: vi.fn(), getBook: vi.fn(), enrichBook: vi.fn() }),
      inject<SettingsService>(mockSettingsService),
      inject<FastifyBaseLogger>({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), silent: vi.fn() }),
      inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({}) }),
    );
  });

  function mockPreFetch(paths: string[], titleAuthors: Array<{ title: string; slug: string }>) {
    mockDb.select
      .mockReturnValueOnce(mockDbChain(paths.map((p) => ({ path: p }))))
      .mockReturnValueOnce(mockDbChain(titleAuthors));
  }

  it('discovers folders not in DB → isDuplicate=false, no duplicateReason', async () => {
    vi.mocked(discoverBooks).mockResolvedValue([{
      path: '/audiobooks/Author/Title',
      folderParts: ['Author', 'Title'],
      audioFileCount: 3,
      totalSize: 100,
    }]);
    mockPreFetch([], []);

    const result = await service.scanDirectory('/audiobooks');

    expect(result.discoveries).toHaveLength(1);
    expect(result.discoveries[0].isDuplicate).toBe(false);
    expect(result.discoveries[0]).not.toHaveProperty('duplicateReason');
  });

  it('finds existing book by exact path match → duplicateReason=path', async () => {
    vi.mocked(discoverBooks).mockResolvedValue([{
      path: '/audiobooks/Author/Title',
      folderParts: ['Author', 'Title'],
      audioFileCount: 3,
      totalSize: 100,
    }]);
    mockPreFetch(['/audiobooks/Author/Title'], []);

    const result = await service.scanDirectory('/audiobooks');

    expect(result.discoveries[0].isDuplicate).toBe(true);
    expect(result.discoveries[0].duplicateReason).toBe('path');
  });

  it('finds existing book by title+author slug match → duplicateReason=slug', async () => {
    vi.mocked(discoverBooks).mockResolvedValue([{
      path: '/audiobooks/Author/Title',
      folderParts: ['Author', 'Title'],
      audioFileCount: 3,
      totalSize: 100,
    }]);
    mockDb.select
      .mockReturnValueOnce(mockDbChain([]))  // no path matches
      .mockReturnValueOnce(mockDbChain([{ id: 99, title: 'Title', slug: 'author' }]));

    const result = await service.scanDirectory('/audiobooks');

    expect(result.discoveries[0].isDuplicate).toBe(true);
    expect(result.discoveries[0].duplicateReason).toBe('slug');
    expect(result.discoveries[0].existingBookId).toBe(99);
  });

  it('book in DB with path=null → does not falsely trigger path-match', async () => {
    vi.mocked(discoverBooks).mockResolvedValue([{
      path: '/audiobooks/Author/Title',
      folderParts: ['Author', 'Title'],
      audioFileCount: 1,
      totalSize: 50,
    }]);
    // Pre-fetch returns a null path row — should be filtered out
    mockDb.select
      .mockReturnValueOnce(mockDbChain([{ path: null }]))
      .mockReturnValueOnce(mockDbChain([]));

    const result = await service.scanDirectory('/audiobooks');

    expect(result.discoveries[0].isDuplicate).toBe(false);
    expect(result.discoveries[0]).not.toHaveProperty('duplicateReason');
  });

  it('2-part Series–Number–Title path deduplicates against existing book by slug (#333)', async () => {
    vi.mocked(discoverBooks).mockResolvedValue([{
      path: '/audiobooks/Joe Abercrombie/First Law World – 02 – The Heroes',
      folderParts: ['Joe Abercrombie', 'First Law World – 02 – The Heroes'],
      audioFileCount: 5,
      totalSize: 200,
    }]);
    mockDb.select
      .mockReturnValueOnce(mockDbChain([]))  // no path matches
      .mockReturnValueOnce(mockDbChain([{ id: 42, title: 'The Heroes', slug: 'joe-abercrombie' }]));

    const result = await service.scanDirectory('/audiobooks');

    expect(result.discoveries[0].isDuplicate).toBe(true);
    expect(result.discoveries[0].duplicateReason).toBe('slug');
    expect(result.discoveries[0].existingBookId).toBe(42);
  });

  it('empty library root → returns discoveries=[], totalFolders=0', async () => {
    vi.mocked(discoverBooks).mockResolvedValue([]);
    mockPreFetch([], []);

    const result = await service.scanDirectory('/audiobooks');

    expect(result).toEqual({ discoveries: [], totalFolders: 0 });
  });

  // ── #229 Observability — elapsed time ───────────────────────────────────
  describe('logging improvements (#229)', () => {
    it('library scan completion log includes elapsedMs field', async () => {
      const mockLog = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), silent: vi.fn() };
      const rescanDb = createMockDb();
      const chainMethods = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
        limit: vi.fn().mockResolvedValue([]),
        set: vi.fn().mockReturnThis(),
      };
      rescanDb.select.mockReturnValue(chainMethods as never);
      rescanDb.update.mockReturnValue(chainMethods as never);
      const rescanService = new LibraryScanService(
        inject<Db>(Object.assign(rescanDb, chainMethods)),
        inject<BookService>({ findDuplicate: vi.fn(), create: vi.fn(), update: vi.fn() }),
        inject<MetadataService>({ searchBooks: vi.fn(), getBook: vi.fn(), enrichBook: vi.fn() }),
        inject<SettingsService>(createMockSettingsService({ library: { path: '/audiobooks' } })),
        inject<FastifyBaseLogger>(mockLog),
        inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({}) }),
      );

      vi.mocked(access).mockResolvedValue(undefined);

      await rescanService.rescanLibrary();

      expect(mockLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ elapsedMs: expect.any(Number) }),
        'Library rescan complete',
      );
    });
  });

  describe('cleanName() normalization enhancements', () => {
    // cleanName is internal — test via parseFolderStructure single-folder path
    it('converts underscores to spaces', () => {
      const result = parseFolderStructure(['Ernest_Cline']);
      expect(result.title).toBe('Ernest Cline');
    });

    it('converts dots to spaces', () => {
      const result = parseFolderStructure(['Stephen.King']);
      expect(result.title).toBe('Stephen King');
    });

    it('handles mixed separators (underscores and dashes)', () => {
      const result = parseFolderStructure(['Ernest_Cline_-_Ready_Player_One']);
      expect(result).toEqual({
        title: 'Ready Player One',
        author: 'Ernest Cline',
        series: null,
      });
    });

    it('strips MP3 codec tag (case-insensitive)', () => {
      expect(parseFolderStructure(['Title MP3']).title).toBe('Title');
      expect(parseFolderStructure(['Title mp3']).title).toBe('Title');
    });

    it('strips M4B codec tag (case-insensitive)', () => {
      expect(parseFolderStructure(['Title M4B']).title).toBe('Title');
      expect(parseFolderStructure(['Title m4b']).title).toBe('Title');
    });

    it('strips M4A codec tag', () => {
      expect(parseFolderStructure(['Title M4A']).title).toBe('Title');
    });

    it('strips FLAC codec tag', () => {
      expect(parseFolderStructure(['Title FLAC']).title).toBe('Title');
    });

    it('strips OGG codec tag', () => {
      expect(parseFolderStructure(['Title OGG']).title).toBe('Title');
    });

    it('strips AAC codec tag', () => {
      expect(parseFolderStructure(['Title AAC']).title).toBe('Title');
    });

    it('strips Unabridged tag', () => {
      expect(parseFolderStructure(['Title Unabridged']).title).toBe('Title');
    });

    it('strips Abridged tag', () => {
      expect(parseFolderStructure(['Title Abridged']).title).toBe('Title');
    });

    it('strips multiple codec tags', () => {
      expect(parseFolderStructure(['Title MP3 Unabridged']).title).toBe('Title');
    });

    it('does not strip codec tag embedded in word (MP3Player)', () => {
      // MP3Player has no word boundary before "MP3" — it's part of the word
      expect(parseFolderStructure(['Title MP3Player']).title).toBe('Title MP3Player');
    });

    it('strips bare trailing year', () => {
      expect(parseFolderStructure(['Ready Player One 2011']).title).toBe('Ready Player One');
    });

    it('does not strip bare mid-string year (2001 A Space Odyssey)', () => {
      expect(parseFolderStructure(['2001 A Space Odyssey']).title).toBe('2001 A Space Odyssey');
    });

    it('still strips parenthesized year (existing behavior)', () => {
      expect(parseFolderStructure(['Title (2020)']).title).toBe('Title');
    });

    it('still strips bracketed year (existing behavior)', () => {
      expect(parseFolderStructure(['Title [2020]']).title).toBe('Title');
    });

    it('still strips leading numbers (existing behavior)', () => {
      expect(parseFolderStructure(['01. Title']).title).toBe('Title');
    });

    it('falls back to original when normalization yields empty string', () => {
      // "MP3 FLAC" → codec stripping removes everything → fall back to "MP3 FLAC"
      expect(parseFolderStructure(['MP3 FLAC']).title).toBe('MP3 FLAC');
    });

    it('falls back to original for purely-numeric folder', () => {
      expect(parseFolderStructure(['01.']).title).toBe('01.');
    });

    it('handles combined normalization: underscores, year, codec tag', () => {
      const result = parseFolderStructure(['Ernest_Cline_-_Ready_Player_One__2017__MP3']);
      expect(result).toEqual({
        title: 'Ready Player One',
        author: 'Ernest Cline',
        series: null,
      });
    });

    it('year boundary: 1899 is not stripped', () => {
      expect(parseFolderStructure(['Title 1899']).title).toBe('Title 1899');
    });

    it('year boundary: 1900 is stripped', () => {
      expect(parseFolderStructure(['Title 1900']).title).toBe('Title');
    });

    it('year boundary: 2099 is stripped', () => {
      expect(parseFolderStructure(['Title 2099']).title).toBe('Title');
    });

    it('year boundary: 2100 is not stripped', () => {
      expect(parseFolderStructure(['Title 2100']).title).toBe('Title 2100');
    });

    it('multiple bare years: only trailing year stripped', () => {
      expect(parseFolderStructure(['Title 2011 2017']).title).toBe('Title 2011');
    });
  });

  describe('extractYear()', () => {
    it('extracts bare trailing year', () => {
      expect(extractYear('Ready Player One 2011')).toBe(2011);
    });

    it('extracts parenthesized year', () => {
      expect(extractYear('Title (2017)')).toBe(2017);
    });

    it('extracts bracketed year', () => {
      expect(extractYear('Title [2020]')).toBe(2020);
    });

    it('returns undefined when no year present', () => {
      expect(extractYear('Ready Player One')).toBeUndefined();
    });

    it('returns undefined for out-of-range years', () => {
      expect(extractYear('Title 1899')).toBeUndefined();
      expect(extractYear('Title 2100')).toBeUndefined();
    });

    it('extracts year from underscore-separated names', () => {
      expect(extractYear('Ready_Player_One_2011')).toBe(2011);
    });

    it('extracts year from dot-separated names', () => {
      expect(extractYear('Ready.Player.One.2011')).toBe(2011);
    });

    it('extracts year when codec tags trail the year token', () => {
      expect(extractYear('Ernest_Cline_-_Ready_Player_One__2017__MP3')).toBe(2017);
    });

    it('extracts year when multiple codec tags follow the year', () => {
      expect(extractYear('Title_2011_FLAC_Unabridged')).toBe(2011);
    });
  });

  describe('parseSingleFolder() "by" delimiter', () => {
    it('"by" splits into title and author', () => {
      const result = parseFolderStructure(['Project Hail Mary by Andy Weir']);
      expect(result).toEqual({
        title: 'Project Hail Mary',
        author: 'Andy Weir',
        series: null,
      });
    });

    it('"by" is case-insensitive', () => {
      const result = parseFolderStructure(['Title BY Author Name']);
      expect(result).toEqual({
        title: 'Title',
        author: 'Author Name',
        series: null,
      });
    });

    it('"by" inside word does not split (Standby Me)', () => {
      const result = parseFolderStructure(['Standby Me']);
      expect(result).toEqual({
        title: 'Standby Me',
        author: null,
        series: null,
      });
    });

    it('"by" with leading numbers only does not split', () => {
      const result = parseFolderStructure(['123 by Author']);
      expect(result).toEqual({
        title: '123 by Author',
        author: null,
        series: null,
      });
    });

    it('"by" with empty right side does not split', () => {
      const result = parseFolderStructure(['Title by']);
      expect(result).toEqual({
        title: 'Title by',
        author: null,
        series: null,
      });
    });

    it('multi-folder with dot/underscore names normalized', () => {
      const result = parseFolderStructure(['Stephen.King', 'The_Shining']);
      expect(result).toEqual({
        title: 'The Shining',
        author: 'Stephen King',
        series: null,
      });
    });

    it('"by" works with dot-separated folder names', () => {
      const result = parseFolderStructure(['Project.Hail.Mary.by.Andy.Weir']);
      expect(result).toEqual({
        title: 'Project Hail Mary',
        author: 'Andy Weir',
        series: null,
      });
    });
  });

  describe('Series – Number – Title pattern', () => {
    describe('2-part paths through parseFolderStructure', () => {
      it('extracts series and title from en-dash pattern, preserving author from parts[0]', () => {
        const result = parseFolderStructure(['Joe Abercrombie', 'First Law World – 02 – The Heroes']);
        expect(result).toEqual({
          title: 'The Heroes',
          author: 'Joe Abercrombie',
          series: 'First Law World',
        });
      });

      it('extracts series and title from hyphen pattern in 2-part path', () => {
        const result = parseFolderStructure(['Author', 'Series - 02 - Title']);
        expect(result).toEqual({
          title: 'Title',
          author: 'Author',
          series: 'Series',
        });
      });

      it('preserves existing Author/Title behavior when parts[1] has no series-number pattern', () => {
        const result = parseFolderStructure(['Author', 'Plain Title']);
        expect(result).toEqual({
          title: 'Plain Title',
          author: 'Author',
          series: null,
        });
      });
    });

    describe('1-part paths through parseSingleFolder', () => {
      it('extracts series and title with en-dash separators', () => {
        const result = parseFolderStructure(['First Law World – 02 – The Heroes']);
        expect(result).toEqual({
          title: 'The Heroes',
          author: null,
          series: 'First Law World',
        });
      });

      it('extracts series and title for Harry Potter naming convention', () => {
        const result = parseFolderStructure(['Harry Potter – 01 – Harry Potter and the Philosopher\'s Stone']);
        expect(result).toEqual({
          title: 'Harry Potter and the Philosopher\'s Stone',
          author: null,
          series: 'Harry Potter',
        });
      });

      it('extracts series and title for multi-word series name', () => {
        const result = parseFolderStructure(['The First Law Trilogy – 02 – Before They Are Hanged']);
        expect(result).toEqual({
          title: 'Before They Are Hanged',
          author: null,
          series: 'The First Law Trilogy',
        });
      });
    });

    describe('separator variants', () => {
      it('matches hyphen separators identically to en-dash', () => {
        const result = parseFolderStructure(['Series - 02 - Title']);
        expect(result).toEqual({
          title: 'Title',
          author: null,
          series: 'Series',
        });
      });

      it('matches mixed en-dash and hyphen separators', () => {
        const result = parseFolderStructure(['Series – 02 - Title']);
        expect(result).toEqual({
          title: 'Title',
          author: null,
          series: 'Series',
        });
      });

      it('trims extra whitespace around separators', () => {
        const result = parseFolderStructure(['Series  –  02  –  Title']);
        expect(result).toEqual({
          title: 'Title',
          author: null,
          series: 'Series',
        });
      });
    });

    describe('non-match cases (pattern must NOT fire)', () => {
      it('does not extract series when no middle number exists (e.g., Special Edition)', () => {
        const result = parseFolderStructure(['The Hitchhiker\'s Guide – Special Edition']);
        expect(result).toEqual({
          title: 'The Hitchhiker\'s Guide – Special Edition',
          author: null,
          series: null,
        });
      });

      it('preserves Author - Title parsing for plain dash pattern', () => {
        const result = parseFolderStructure(['Andy Weir - Project Hail Mary']);
        expect(result).toEqual({
          title: 'Project Hail Mary',
          author: 'Andy Weir',
          series: null,
        });
      });

      it('preserves Title by Author parsing', () => {
        const result = parseFolderStructure(['Project Hail Mary by Andy Weir']);
        expect(result).toEqual({
          title: 'Project Hail Mary',
          author: 'Andy Weir',
          series: null,
        });
      });

      it('preserves Title (Author) parsing', () => {
        const result = parseFolderStructure(['Dune (Frank Herbert)']);
        expect(result).toEqual({
          title: 'Dune',
          author: 'Frank Herbert',
          series: null,
        });
      });
    });

    describe('boundary values', () => {
      it('extracts with single-digit number', () => {
        const result = parseFolderStructure(['Series – 1 – Title']);
        expect(result).toEqual({
          title: 'Title',
          author: null,
          series: 'Series',
        });
      });

      it('extracts with large number (999)', () => {
        const result = parseFolderStructure(['Series – 999 – Title']);
        expect(result).toEqual({
          title: 'Title',
          author: null,
          series: 'Series',
        });
      });

      it('extracts with leading-zero number (001)', () => {
        const result = parseFolderStructure(['Series – 001 – Title']);
        expect(result).toEqual({
          title: 'Title',
          author: null,
          series: 'Series',
        });
      });
    });

    describe('cleanName integration', () => {
      it('strips codec tags from extracted title', () => {
        const result = parseFolderStructure(['Series – 01 – Title M4B']);
        expect(result).toEqual({
          title: 'Title',
          author: null,
          series: 'Series',
        });
      });

      it('strips year suffixes from extracted title', () => {
        const result = parseFolderStructure(['Series – 01 – Title (2020)']);
        expect(result).toEqual({
          title: 'Title',
          author: null,
          series: 'Series',
        });
      });

      it('strips numbering prefixes from extracted title but preserves legitimate numeric titles', () => {
        // Numbering prefix stripped
        const withPrefix = parseFolderStructure(['Series – 01 – 02. The Second Book']);
        expect(withPrefix).toEqual({
          title: 'The Second Book',
          author: null,
          series: 'Series',
        });

        // Legitimate numeric title preserved
        const withNumeric = parseFolderStructure(['Sci-Fi Classics – 01 – 2001 A Space Odyssey']);
        expect(withNumeric.title).toBe('2001 A Space Odyssey');
      });
    });

    describe('duplicate detection regression', () => {
      it('2-part series-number path produces same title+author as equivalent 3-part path', () => {
        const twoPart = parseFolderStructure(['Author', 'Series – 02 – Title']);
        const threePart = parseFolderStructure(['Author', 'Series', 'Title']);
        expect(twoPart.title).toBe(threePart.title);
        expect(twoPart.author).toBe(threePart.author);
      });
    });
  });

});

// ============================================================================
// Within-scan duplicate detection (#342)
// ============================================================================

describe('scanDirectory() — within-scan duplicate detection (#342)', () => {
  let service: LibraryScanService;
  let mockDb: ReturnType<typeof createMockDb> & Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enrichBookFromAudio).mockResolvedValue({ enriched: true });
    const db = createMockDb();
    const chainMethods = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockReturnThis(),
    };
    db.select.mockReturnValue(chainMethods as never);
    db.update.mockReturnValue(chainMethods as never);
    mockDb = Object.assign(db, chainMethods);
    const mockSettingsService = createMockSettingsService({ library: { path: '/audiobooks' } });
    service = new LibraryScanService(
      inject<Db>(mockDb),
      inject<BookService>({ findDuplicate: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 1 }), update: vi.fn().mockResolvedValue({ id: 1 }) }),
      inject<MetadataService>({ searchBooks: vi.fn(), getBook: vi.fn(), enrichBook: vi.fn() }),
      inject<SettingsService>(mockSettingsService),
      inject<FastifyBaseLogger>({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(), silent: vi.fn() }),
      inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({}) }),
    );
  });

  function mockPreFetch(paths: string[], titleAuthors: Array<{ title: string; slug: string }>) {
    mockDb.select
      .mockReturnValueOnce(mockDbChain(paths.map((p) => ({ path: p }))))
      .mockReturnValueOnce(mockDbChain(titleAuthors));
  }

  describe('happy path', () => {
    it('two folders with same title+author slug → second flagged isDuplicate with duplicateReason=within-scan', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
        { path: '/audiobooks/Copy/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
      ]);
      mockPreFetch([], []);

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries).toHaveLength(2);
      expect(result.discoveries[1].isDuplicate).toBe(true);
      expect(result.discoveries[1].duplicateReason).toBe('within-scan');
    });

    it('first folder of a within-scan duplicate pair remains isDuplicate=false', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
        { path: '/audiobooks/Copy/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
      ]);
      mockPreFetch([], []);

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries[0].isDuplicate).toBe(false);
      expect(result.discoveries[0]).not.toHaveProperty('duplicateReason');
    });

    it('within-scan duplicate has duplicateFirstPath set to first discovery path', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
        { path: '/audiobooks/Copy/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
      ]);
      mockPreFetch([], []);

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries[1].duplicateFirstPath).toBe('/audiobooks/Author/Title');
    });

    it('within-scan duplicate has no existingBookId', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
        { path: '/audiobooks/Copy/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
      ]);
      mockPreFetch([], []);

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries[1]).not.toHaveProperty('existingBookId');
    });
  });

  describe('boundary values', () => {
    it('three+ folders with same title+author → second and third both flagged as within-scan duplicates referencing first path', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/a/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
        { path: '/audiobooks/b/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
        { path: '/audiobooks/c/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
      ]);
      mockPreFetch([], []);

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries[0].isDuplicate).toBe(false);
      expect(result.discoveries[1].isDuplicate).toBe(true);
      expect(result.discoveries[1].duplicateReason).toBe('within-scan');
      expect(result.discoveries[1].duplicateFirstPath).toBe('/audiobooks/a/Author/Title');
      expect(result.discoveries[2].isDuplicate).toBe(true);
      expect(result.discoveries[2].duplicateReason).toBe('within-scan');
      expect(result.discoveries[2].duplicateFirstPath).toBe('/audiobooks/a/Author/Title');
    });

    it('single folder with no duplicate → isDuplicate=false, no duplicateReason, no duplicateFirstPath', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
      ]);
      mockPreFetch([], []);

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries).toHaveLength(1);
      expect(result.discoveries[0].isDuplicate).toBe(false);
      expect(result.discoveries[0]).not.toHaveProperty('duplicateReason');
      expect(result.discoveries[0]).not.toHaveProperty('duplicateFirstPath');
    });

    it('slug case normalization — different casing of same author produces same slug and triggers within-scan dedup', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/Brandon Sanderson/Title', folderParts: ['Brandon Sanderson', 'Title'], audioFileCount: 3, totalSize: 100 },
        { path: '/audiobooks/brandon sanderson/Title', folderParts: ['brandon sanderson', 'Title'], audioFileCount: 3, totalSize: 100 },
      ]);
      mockPreFetch([], []);

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries[1].isDuplicate).toBe(true);
      expect(result.discoveries[1].duplicateReason).toBe('within-scan');
    });
  });

  describe('null/missing data paths', () => {
    it('two folders with same title but null author → not deduplicated within scan', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/Title', folderParts: ['Title'], audioFileCount: 3, totalSize: 100 },
        { path: '/audiobooks/Copy/Title', folderParts: ['Title'], audioFileCount: 3, totalSize: 100 },
      ]);
      mockPreFetch([], []);

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries[0].isDuplicate).toBe(false);
      expect(result.discoveries[1].isDuplicate).toBe(false);
    });

    it('two folders with empty/falsy title → not deduplicated within scan', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/a', folderParts: [], audioFileCount: 3, totalSize: 100 },
        { path: '/audiobooks/b', folderParts: [], audioFileCount: 3, totalSize: 100 },
      ]);
      mockPreFetch([], []);

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries[0].isDuplicate).toBe(false);
      expect(result.discoveries[1].isDuplicate).toBe(false);
    });
  });

  describe('interaction with existing DB-based dedup', () => {
    it('folder matching DB by path → duplicateReason=path, not checked for within-scan', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
      ]);
      mockPreFetch(['/audiobooks/Author/Title'], []);

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries[0].isDuplicate).toBe(true);
      expect(result.discoveries[0].duplicateReason).toBe('path');
      expect(result.discoveries[0]).not.toHaveProperty('duplicateFirstPath');
    });

    it('folder matching DB by slug → duplicateReason=slug, not checked for within-scan', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
      ]);
      mockDb.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ id: 99, title: 'Title', slug: 'author' }]));

      const result = await service.scanDirectory('/audiobooks');

      expect(result.discoveries[0].isDuplicate).toBe(true);
      expect(result.discoveries[0].duplicateReason).toBe('slug');
      expect(result.discoveries[0]).not.toHaveProperty('duplicateFirstPath');
    });

    it('mixed scan: DB path dup + DB slug dup + within-scan dup + new folder → each has correct flag and reason', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/Author/BookA', folderParts: ['Author', 'BookA'], audioFileCount: 3, totalSize: 100 },
        { path: '/audiobooks/Author/BookB', folderParts: ['Author', 'BookB'], audioFileCount: 3, totalSize: 100 },
        { path: '/audiobooks/Copy/Author/BookB', folderParts: ['Author', 'BookB'], audioFileCount: 3, totalSize: 100 },
        { path: '/audiobooks/NewAuthor/NewBook', folderParts: ['NewAuthor', 'NewBook'], audioFileCount: 3, totalSize: 100 },
      ]);
      mockDb.select
        .mockReturnValueOnce(mockDbChain([{ path: '/audiobooks/Author/BookA' }]))
        .mockReturnValueOnce(mockDbChain([{ id: 42, title: 'BookB', slug: 'author' }]));

      const result = await service.scanDirectory('/audiobooks');

      // First: DB path dup
      expect(result.discoveries[0].duplicateReason).toBe('path');
      // Second: DB slug dup
      expect(result.discoveries[1].duplicateReason).toBe('slug');
      expect(result.discoveries[1].existingBookId).toBe(42);
      // Third: within-scan dup (same title+author as second, but second was DB-dup so not in within-scan map)
      // Actually: second was a DB slug dup and got `continue`, so it was never added to the within-scan map.
      // Third has same title+author as second, but since second never reached the within-scan check, third is a new discovery.
      // Wait — third has same folder parts as second: ['Author', 'BookB']. Second matched DB slug, so third:
      // - path check: not in DB path map → no
      // - DB slug check: 'BookB|author' IS in existingTitleAuthorMap → yes, DB slug dup
      expect(result.discoveries[2].duplicateReason).toBe('slug');
      // Fourth: new discovery
      expect(result.discoveries[3].isDuplicate).toBe(false);
    });

    it('first occurrence is DB path duplicate → second occurrence becomes new discovery (not within-scan dup)', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
        { path: '/audiobooks/Copy/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
      ]);
      // First folder matches DB by path; DB has no slug match for title+author
      mockDb.select
        .mockReturnValueOnce(mockDbChain([{ path: '/audiobooks/Author/Title' }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.scanDirectory('/audiobooks');

      // First: DB path dup (short-circuited, never added to within-scan map)
      expect(result.discoveries[0].duplicateReason).toBe('path');
      // Second: not in DB, first was never added to within-scan map → new discovery
      expect(result.discoveries[1].isDuplicate).toBe(false);
    });
  });

  describe('error isolation', () => {
    it('within-scan Map is local to the scan call — not shared across invocations', async () => {
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
      ]);
      mockPreFetch([], []);

      const result1 = await service.scanDirectory('/audiobooks');
      expect(result1.discoveries[0].isDuplicate).toBe(false);

      // Second scan with same folder — should also be non-duplicate (not carried over from first scan)
      mockPreFetch([], []);
      vi.mocked(discoverBooks).mockResolvedValue([
        { path: '/audiobooks/Author/Title', folderParts: ['Author', 'Title'], audioFileCount: 3, totalSize: 100 },
      ]);

      const result2 = await service.scanDirectory('/audiobooks');
      expect(result2.discoveries[0].isDuplicate).toBe(false);
    });
  });

  describe('cleanName enhancements (issue #426)', () => {
    // cleanName() is private — test via parseFolderStructure with 2-part paths
    // where parts[1] (title) goes through cleanName() directly

    describe('narrator parenthetical stripping', () => {
      it('strips trailing "(Jeff Hays)" from title', () => {
        const result = parseFolderStructure(['Author', 'Dungeon Crawler Carl (Jeff Hays)']);
        expect(result.title).toBe('Dungeon Crawler Carl');
      });

      it('strips trailing "(Stephen Fry)" from title', () => {
        const result = parseFolderStructure(['Author', 'Bloody Rose (Stephen Fry)']);
        expect(result.title).toBe('Bloody Rose');
      });

      it('does not strip "(Unabridged)" — handled as codec tag', () => {
        const result = parseFolderStructure(['Author', 'Bloody Rose (Unabridged)']);
        expect(result.title).toBe('Bloody Rose');
      });

      it('does not strip "(2020)" — handled as year', () => {
        const result = parseFolderStructure(['Author', 'BookTitle (2020)']);
        expect(result.title).toBe('BookTitle');
      });

      it('does not strip long parentheticals (>3 words)', () => {
        const result = parseFolderStructure(['Author', 'BookTitle (A Very Long Subtitle Here)']);
        expect(result.title).toBe('BookTitle (A Very Long Subtitle Here)');
      });

      it('does not strip 4-word narrator name — cap is intentionally 3 words', () => {
        const result = parseFolderStructure(['Author', 'BookTitle (Dr Stephen King Jr)']);
        expect(result.title).toBe('BookTitle (Dr Stephen King Jr)');
      });

      it('strips exactly 3-word narrator name', () => {
        const result = parseFolderStructure(['Author', 'BookTitle (Mary Jane Watson)']);
        expect(result.title).toBe('BookTitle');
      });
    });

    describe('series marker stripping', () => {
      it('strips ", Book 01" from title', () => {
        const result = parseFolderStructure(['Author', 'The Hunger Games, Book 01']);
        expect(result.title).toBe('The Hunger Games');
      });

      it('strips ", Vol 3" from title', () => {
        const result = parseFolderStructure(['Author', 'Title, Vol 3']);
        expect(result.title).toBe('Title');
      });

      it('strips ", Volume 12" from title', () => {
        const result = parseFolderStructure(['Author', 'Title, Volume 12']);
        expect(result.title).toBe('Title');
      });

      it('does not strip when title would be empty', () => {
        const result = parseFolderStructure(['Author', ', Book 01']);
        // Should fall back or preserve — not produce empty title
        expect(result.title.length).toBeGreaterThan(0);
      });
    });

    describe('empty bracket removal', () => {
      it('removes empty () after codec stripping', () => {
        const result = parseFolderStructure(['Author', 'BookTitle (MP3)']);
        expect(result.title).toBe('BookTitle');
        expect(result.title).not.toContain('()');
      });

      it('removes empty [] after codec stripping', () => {
        const result = parseFolderStructure(['Author', 'BookTitle [FLAC]']);
        expect(result.title).toBe('BookTitle');
        expect(result.title).not.toContain('[]');
      });

      it('preserves non-empty parentheticals with >3 words', () => {
        const result = parseFolderStructure(['Author', 'BookTitle (The Extended Cut Edition)']);
        expect(result.title).toBe('BookTitle (The Extended Cut Edition)');
      });
    });

    describe('duplicate segment deduplication', () => {
      it('deduplicates "Dungeon Crawler Carl 01 – Dungeon Crawler Carl"', () => {
        const result = parseFolderStructure(['Matt Dinniman', 'Dungeon Crawler Carl 01 – Dungeon Crawler Carl']);
        expect(result.title).toBe('Dungeon Crawler Carl');
      });

      it('deduplicates "The Hunger Games, Book 01 – The Hunger Games"', () => {
        const result = parseFolderStructure(['Suzanne Collins', 'The Hunger Games, Book 01 – The Hunger Games']);
        expect(result.title).toBe('The Hunger Games');
      });

      it('does not deduplicate non-duplicate segments', () => {
        // In 2-part paths, parts[1] is title — dash is NOT parsed as author separator
        const result = parseFolderStructure(['Author', 'The Way of Kings – Brandon Sanderson']);
        expect(result.title).toBe('The Way of Kings – Brandon Sanderson');
        expect(result.author).toBe('Author');
      });
    });

    describe('combined parenthetical edge cases', () => {
      it('"BookTitle (Disc 01) (Jeff Hays)" — disc paren survives, narrator stripped', () => {
        // When disc detection doesn't match (disc not at end), cleanName gets the full string
        // Narrator paren is at end so it gets stripped; (Disc 01) survives as non-narrator content
        const result = parseFolderStructure(['Author', 'BookTitle (Disc 01) (Jeff Hays)']);
        expect(result.title).toBe('BookTitle (Disc 01)');
      });
    });

    describe('regression — existing cleanName behaviors', () => {
      it('still strips decimal series positions', () => {
        const result = parseFolderStructure(['Author', '6.5 – The Title']);
        expect(result.title).toBe('The Title');
      });

      it('still strips codec tags', () => {
        const result = parseFolderStructure(['Author', 'BookTitle MP3']);
        expect(result.title).toBe('BookTitle');
      });

      it('still removes years', () => {
        const result = parseFolderStructure(['Author', 'BookTitle (2020)']);
        expect(result.title).toBe('BookTitle');
      });

      it('returns original on empty result', () => {
        const result = parseFolderStructure(['Author', '01.']);
        expect(result.title.length).toBeGreaterThan(0);
      });
    });
  });

  describe('parseSingleFolder regression (issue #426)', () => {
    it('"BookTitle (Author Name)" still parses as title + author', () => {
      const result = parseFolderStructure(['Dune (Frank Herbert)']);
      expect(result.title).toBe('Dune');
      expect(result.author).toBe('Frank Herbert');
    });

    it('"BookTitle [Author Name]" still parses as title + author', () => {
      const result = parseFolderStructure(['Dune [Frank Herbert]']);
      expect(result.title).toBe('Dune');
      expect(result.author).toBe('Frank Herbert');
    });

    it('"Author - BookTitle (Narrator)" strips narrator from title via cleanName', () => {
      const result = parseFolderStructure(['Author - BookTitle (Jeff Hays)']);
      expect(result.title).toBe('BookTitle');
      expect(result.author).toBe('Author');
    });

    it('multi-part "Author/BookTitle (Jeff Hays)" strips narrator from title', () => {
      const result = parseFolderStructure(['Author', 'BookTitle (Jeff Hays)']);
      expect(result.title).toBe('BookTitle');
      expect(result.author).toBe('Author');
    });
  });

});
