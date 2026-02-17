import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@narratorr/db';
import type { BookService } from './book.service.js';
import { parseFolderStructure, LibraryScanService } from './library-scan.service.js';

vi.mock('./enrichment-utils.js', () => ({
  enrichBookFromAudio: vi.fn().mockResolvedValue({ enriched: true }),
}));

import { enrichBookFromAudio } from './enrichment-utils.js';

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
});

// ============================================================================
// LibraryScanService (mocked DB/FS)
// ============================================================================

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as FastifyBaseLogger;
}

describe('LibraryScanService', () => {
  let service: LibraryScanService;
  let mockDb: unknown;
  let mockBookService: {
    findDuplicate: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  let mockMetadataService: {
    searchBooks: ReturnType<typeof vi.fn>;
    getBook: ReturnType<typeof vi.fn>;
    enrichBook: ReturnType<typeof vi.fn>;
  };
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enrichBookFromAudio).mockResolvedValue({ enriched: true });
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
    };
    mockBookService = {
      findDuplicate: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async (data: { title: string }) => ({
        id: 1,
        title: data.title,
        status: 'imported',
      })),
    };
    mockMetadataService = {
      searchBooks: vi.fn().mockResolvedValue([]),
      getBook: vi.fn().mockResolvedValue(null),
      enrichBook: vi.fn().mockResolvedValue(null),
    };
    log = createMockLogger();
    service = new LibraryScanService(
      mockDb as Db,
      mockBookService as unknown as BookService,
      mockMetadataService as unknown as import('./metadata.service.js').MetadataService,
      log,
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
        expect.objectContaining({ title: 'Test Book', authorName: 'Test Author', status: 'imported' }),
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
          narrator: undefined,
        }),
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

  describe('confirmImport', () => {
    it('creates book records for each item', async () => {
      const result = await service.confirmImport([
        { path: '/audiobooks/Author/Title', title: 'Title', authorName: 'Author' },
      ]);

      expect(mockBookService.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Title', authorName: 'Author', status: 'imported' }),
      );
      expect(result.imported).toBe(1);
      expect(result.failed).toBe(0);
    });

    it('skips duplicates during import', async () => {
      mockBookService.findDuplicate.mockResolvedValueOnce({ id: 1, title: 'Existing' });

      const result = await service.confirmImport([
        { path: '/audiobooks/Author/Title', title: 'Existing', authorName: 'Author' },
      ]);

      expect(mockBookService.create).not.toHaveBeenCalled();
      expect(result.imported).toBe(0);
    });

    it('counts failures and continues', async () => {
      mockBookService.create
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce({ id: 2, title: 'Book 2', status: 'imported' });

      const result = await service.confirmImport([
        { path: '/a/b', title: 'Book 1' },
        { path: '/a/c', title: 'Book 2' },
      ]);

      expect(result.imported).toBe(1);
      expect(result.failed).toBe(1);
    });

    it('calls enrichBookFromAudio for each imported book', async () => {
      mockBookService.create
        .mockResolvedValueOnce({ id: 10, title: 'Book A', status: 'imported', narrator: null, duration: null, coverUrl: null })
        .mockResolvedValueOnce({ id: 11, title: 'Book B', status: 'imported', narrator: null, duration: null, coverUrl: null });

      await service.confirmImport([
        { path: '/audiobooks/A', title: 'Book A' },
        { path: '/audiobooks/B', title: 'Book B' },
      ]);

      expect(enrichBookFromAudio).toHaveBeenCalledTimes(2);
      expect(enrichBookFromAudio).toHaveBeenCalledWith(
        10, '/audiobooks/A', expect.objectContaining({ narrator: null }), expect.anything(), expect.anything(),
      );
      expect(enrichBookFromAudio).toHaveBeenCalledWith(
        11, '/audiobooks/B', expect.objectContaining({ narrator: null }), expect.anything(), expect.anything(),
      );
    });

    it('returns enrichment counts', async () => {
      vi.mocked(enrichBookFromAudio).mockResolvedValue({ enriched: true });

      const result = await service.confirmImport([
        { path: '/audiobooks/A', title: 'Book A' },
      ]);

      expect(result.enriched).toBe(1);
      expect(result.enrichmentFailed).toBe(0);
    });

    it('counts enrichment failures without blocking import', async () => {
      vi.mocked(enrichBookFromAudio).mockResolvedValue({ enriched: false, error: 'No audio files' });

      const result = await service.confirmImport([
        { path: '/audiobooks/A', title: 'Book A' },
      ]);

      expect(result.imported).toBe(1);
      expect(result.enrichmentFailed).toBe(1);
    });

    it('does not call enrichment for skipped duplicates', async () => {
      mockBookService.findDuplicate.mockResolvedValueOnce({ id: 1, title: 'Existing' });

      await service.confirmImport([
        { path: '/audiobooks/A', title: 'Existing', authorName: 'Author' },
      ]);

      expect(enrichBookFromAudio).not.toHaveBeenCalled();
    });

    it('searches metadata providers and passes results to book create', async () => {
      mockMetadataService.searchBooks.mockResolvedValue([{
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
      }]);

      await service.confirmImport([
        { path: '/audiobooks/HP1', title: 'Harry Potter', authorName: 'J.K. Rowling' },
      ]);

      expect(mockMetadataService.searchBooks).toHaveBeenCalledWith('Harry Potter J.K. Rowling');
      expect(mockBookService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Harry Potter',
          authorName: 'J.K. Rowling',
          asin: 'B017V4IM1G',
          description: 'The boy who lived...',
          narrator: 'Stephen Fry',
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

      expect(result.imported).toBe(1);
      expect(mockBookService.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Obscure Book' }),
      );
    });

    it('still imports when metadata lookup throws', async () => {
      mockMetadataService.searchBooks.mockRejectedValue(new Error('API timeout'));

      const result = await service.confirmImport([
        { path: '/audiobooks/Timeout', title: 'Timeout Book' },
      ]);

      expect(result.imported).toBe(1);
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
          authorName: 'My Author',
          coverUrl: '/my/cover.jpg',
          asin: 'MY-ASIN',
        }),
      );
    });
  });
});
