import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject, createMockDb, mockDbChain, createMockSettingsService } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { BookService } from './book.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { parseFolderStructure, LibraryScanService } from './library-scan.service.js';

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

  it('handles folder with only numbers (gets stripped by cleanName)', () => {
    const result = parseFolderStructure(['01. ']);
    expect(result.title).toBe('');
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
      create: vi.fn().mockImplementation(async (data: { title: string }) => ({
        id: 1,
        title: data.title,
        status: 'imported',
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
          narrators: undefined,
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
        skippedDuplicates: 0,
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
      });
      expect(result.totalFolders).toBe(1);
      expect(result.skippedDuplicates).toBe(0);
    });

    it('skips folders that already exist by path in DB', async () => {
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

      expect(result.discoveries).toHaveLength(0);
      expect(result.skippedDuplicates).toBe(1);
      expect(result.totalFolders).toBe(1);
    });

    it('skips folders that match existing book by title+author', async () => {
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

      expect(result.discoveries).toHaveLength(0);
      expect(result.skippedDuplicates).toBe(1);
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

      expect(result.discoveries).toHaveLength(2);
      expect(result.discoveries[0].parsedTitle).toBe('Book1');
      expect(result.discoveries[1].parsedTitle).toBe('Book2');
      expect(result.skippedDuplicates).toBe(2);
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
        expect(result.skippedDuplicates).toBe(0);
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

    it('proceeds with copy when source is inside library root but target path differs', async () => {
      // Source is inside library but folder format would rename it
      const result = await service.importSingleBook(
        { path: '/library/old-folder-name', title: 'Title', authorName: 'Author' },
        null,
        'copy',
      );

      // buildTargetPath returns '/library/Author/Title' which differs from source
      expect(result.imported).toBe(true);
      expect(cp).toHaveBeenCalledWith('/library/old-folder-name', '/library/Author/Title', expect.anything());
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

      // buildTargetPath mock returns '/library/Author/Title' (absolute — resolve is a no-op)
      expect(mockEventHistoryService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.objectContaining({ targetPath: '/library/Author/Title', mode: 'copy' }),
        }),
      );
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
      // and finalPath stays as item.path. resolve('/audiobooks/Book') is a no-op (already absolute).
      await vi.waitFor(() => {
        expect(mockEventHistoryService.create).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: expect.objectContaining({ targetPath: '/audiobooks/Book', mode: 'copy' }),
          }),
        );
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
      import: { minFreeSpaceGB: 0, deleteAfterImport: false, minSeedTime: 0 },
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
