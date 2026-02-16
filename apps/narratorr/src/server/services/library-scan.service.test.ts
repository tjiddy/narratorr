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
    };
    log = createMockLogger();
    service = new LibraryScanService(
      mockDb as Db,
      mockBookService as unknown as BookService,
      mockMetadataService as unknown as import('./metadata.service.js').MetadataService,
      log,
    );
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
