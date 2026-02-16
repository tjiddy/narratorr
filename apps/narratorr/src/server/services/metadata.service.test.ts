import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitError } from '@narratorr/core';
import { createMockLogger } from '../__tests__/helpers.js';
import { MetadataService } from './metadata.service.js';

const mockProvider = {
  name: 'Hardcover',
  type: 'hardcover',
  search: vi.fn().mockResolvedValue({ books: [], authors: [], series: [] }),
  searchAuthors: vi.fn().mockResolvedValue([]),
  searchBooks: vi.fn().mockResolvedValue([]),
  getAuthor: vi.fn().mockResolvedValue(null),
  getAuthorBooks: vi.fn().mockResolvedValue([]),
  getBook: vi.fn().mockResolvedValue(null),
  getSeries: vi.fn().mockResolvedValue(null),
  searchSeries: vi.fn().mockResolvedValue([]),
  test: vi.fn().mockResolvedValue({ success: true }),
};

const mockAudnexus = {
  name: 'Audnexus',
  type: 'audnexus',
  getBook: vi.fn().mockResolvedValue(null),
};

const mockGoogleProvider = {
  name: 'Google Books',
  type: 'google-books',
  search: vi.fn().mockResolvedValue({ books: [], authors: [], series: [] }),
  searchAuthors: vi.fn().mockResolvedValue([]),
  searchBooks: vi.fn().mockResolvedValue([]),
  getAuthor: vi.fn().mockResolvedValue(null),
  getAuthorBooks: vi.fn().mockResolvedValue([]),
  getBook: vi.fn().mockResolvedValue(null),
  getSeries: vi.fn().mockResolvedValue(null),
  searchSeries: vi.fn().mockResolvedValue([]),
  test: vi.fn().mockResolvedValue({ success: true }),
};

vi.mock('@narratorr/core', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@narratorr/core')>();
  return {
    ...actual,
    HardcoverProvider: vi.fn().mockImplementation(() => mockProvider),
    AudnexusProvider: vi.fn().mockImplementation(() => mockAudnexus),
    GoogleBooksProvider: vi.fn().mockImplementation(() => mockGoogleProvider),
  };
});

describe('MetadataService', () => {
  let service: MetadataService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('HARDCOVER_API_KEY', 'test-key');
    // Reset mock return values
    mockProvider.search.mockResolvedValue({ books: [], authors: [], series: [] });
    mockProvider.searchAuthors.mockResolvedValue([]);
    mockProvider.searchBooks.mockResolvedValue([]);
    mockProvider.getAuthor.mockResolvedValue(null);
    mockProvider.getAuthorBooks.mockResolvedValue([]);
    mockProvider.getBook.mockResolvedValue(null);
    mockProvider.getSeries.mockResolvedValue(null);
    mockProvider.test.mockResolvedValue({ success: true });
    mockAudnexus.getBook.mockResolvedValue(null);
    service = new MetadataService(createMockLogger() as any);
  });

  describe('search', () => {
    it('delegates to the provider sub-methods', async () => {
      const result = await service.search('Brandon Sanderson');
      expect(result).toEqual({ books: [], authors: [], series: [] });
      expect(mockProvider.searchBooks).toHaveBeenCalledWith('Brandon Sanderson');
      expect(mockProvider.searchAuthors).toHaveBeenCalledWith('Brandon Sanderson');
      expect(mockProvider.searchSeries).toHaveBeenCalledWith('Brandon Sanderson');
    });

    it('returns empty results on error', async () => {
      mockProvider.searchBooks.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.search('test');
      // Books fail, but authors/series still return
      expect(result.books).toEqual([]);
      expect(mockProvider.searchAuthors).toHaveBeenCalled();
      expect(mockProvider.searchSeries).toHaveBeenCalled();
    });

    it('throttles each sub-search individually to prevent bursting', async () => {
      const callOrder: string[] = [];
      mockProvider.searchBooks.mockImplementation(() => { callOrder.push('books'); return Promise.resolve([]); });
      mockProvider.searchAuthors.mockImplementation(() => { callOrder.push('authors'); return Promise.resolve([]); });
      mockProvider.searchSeries.mockImplementation(() => { callOrder.push('series'); return Promise.resolve([]); });

      await service.search('test');

      // All three should be called sequentially (not via Promise.all)
      expect(callOrder).toEqual(['books', 'authors', 'series']);
      expect(mockProvider.searchBooks).toHaveBeenCalledTimes(1);
      expect(mockProvider.searchAuthors).toHaveBeenCalledTimes(1);
      expect(mockProvider.searchSeries).toHaveBeenCalledTimes(1);
    });
  });

  describe('searchAuthors', () => {
    it('delegates to the provider', async () => {
      const result = await service.searchAuthors('Brandon');
      expect(result).toEqual([]);
    });

    it('returns empty array on error', async () => {
      mockProvider.searchAuthors.mockRejectedValueOnce(new Error('fail'));

      const result = await service.searchAuthors('test');
      expect(result).toEqual([]);
    });
  });

  describe('searchBooks', () => {
    it('delegates to the provider', async () => {
      const result = await service.searchBooks('Way of Kings');
      expect(result).toEqual([]);
    });
  });

  describe('getAuthor', () => {
    it('returns null when not found', async () => {
      const result = await service.getAuthor('15200');
      expect(result).toBeNull();
    });

    it('returns author when found', async () => {
      const mockAuthor = { name: 'Brandon Sanderson' };
      mockProvider.getAuthor.mockResolvedValueOnce(mockAuthor);

      const result = await service.getAuthor('15200');
      expect(result).toEqual(mockAuthor);
    });
  });

  describe('getBook', () => {
    it('returns null when not found', async () => {
      const result = await service.getBook('328491');
      expect(result).toBeNull();
    });

    it('returns book when found', async () => {
      const mockBook = { title: 'The Way of Kings', authors: [] };
      mockProvider.getBook.mockResolvedValueOnce(mockBook);

      const result = await service.getBook('328491');
      expect(result).toEqual(mockBook);
    });
  });

  describe('enrichBook', () => {
    it('returns book metadata from Audnexus on success', async () => {
      const mockBookData = {
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
        narrators: ['Michael Kramer', 'Kate Reading'],
        duration: 2700,
      };
      mockAudnexus.getBook.mockResolvedValueOnce(mockBookData);

      const result = await service.enrichBook('B003P2WO5E');
      expect(result).toEqual(mockBookData);
      expect(mockAudnexus.getBook).toHaveBeenCalledWith('B003P2WO5E');
    });

    it('returns null when Audnexus has no data', async () => {
      const result = await service.enrichBook('B000UNKNOWN');
      expect(result).toBeNull();
    });

    it('returns null on Audnexus error', async () => {
      mockAudnexus.getBook.mockRejectedValueOnce(new Error('500 Internal Server Error'));

      const result = await service.enrichBook('B000BROKEN');
      expect(result).toBeNull();
    });
  });

  describe('testProviders', () => {
    it('returns test results for all providers', async () => {
      const results = await service.testProviders();
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Hardcover');
      expect(results[0].type).toBe('hardcover');
      expect(results[0].success).toBe(true);
    });
  });

  describe('getProviders', () => {
    it('returns list of provider info', () => {
      const providers = service.getProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]).toEqual({ name: 'Hardcover', type: 'hardcover' });
    });
  });

  describe('Google Books registration', () => {
    it('registers Google Books provider when GOOGLE_BOOKS_API_KEY is set', () => {
      vi.stubEnv('GOOGLE_BOOKS_API_KEY', 'test-google-key');
      const googleService = new MetadataService(createMockLogger() as any);

      const providers = googleService.getProviders();
      expect(providers).toHaveLength(2);
      expect(providers[1]).toEqual({ name: 'Google Books', type: 'google-books' });
    });

    it('does not register Google Books when GOOGLE_BOOKS_API_KEY is not set', () => {
      vi.stubEnv('GOOGLE_BOOKS_API_KEY', '');
      const noGoogleService = new MetadataService(createMockLogger() as any);

      const providers = noGoogleService.getProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]).toEqual({ name: 'Hardcover', type: 'hardcover' });
    });

    it('includes Google Books in testProviders results', async () => {
      vi.stubEnv('GOOGLE_BOOKS_API_KEY', 'test-google-key');
      const googleService = new MetadataService(createMockLogger() as any);

      const results = await googleService.testProviders();
      expect(results).toHaveLength(2);
      expect(results[1].name).toBe('Google Books');
      expect(results[1].type).toBe('google-books');
      expect(results[1].success).toBe(true);
    });
  });

  describe('rate limiting', () => {
    it('returns warnings when provider throws RateLimitError on search', async () => {
      mockProvider.searchBooks.mockRejectedValueOnce(new RateLimitError(30000, 'Hardcover'));

      const result = await service.search('test');
      expect(result.books).toEqual([]);
      expect(result.warnings).toBeDefined();
      expect(result.warnings![0]).toContain('rate limit');
      expect(result.warnings![0]).toContain('30s');
    });

    it('skips provider during backoff window after RateLimitError', async () => {
      // First call triggers rate limit on searchBooks
      mockProvider.searchBooks.mockRejectedValueOnce(new RateLimitError(60000, 'Hardcover'));
      await service.search('first');

      // Second call should be skipped (within backoff window)
      const result = await service.search('second');
      expect(result.books).toEqual([]);
      expect(result.warnings).toBeDefined();
      expect(result.warnings![0]).toContain('rate limit');
      // searchBooks should only have been called once (not for the second search)
      expect(mockProvider.searchBooks).toHaveBeenCalledTimes(1);
    });

    it('returns fallback on RateLimitError for non-search methods', async () => {
      mockProvider.getBook.mockRejectedValueOnce(new RateLimitError(30000, 'Hardcover'));

      const result = await service.getBook('123');
      expect(result).toBeNull();
    });

    it('skips non-search methods during backoff window', async () => {
      // Trigger rate limit via searchBooks within search()
      mockProvider.searchBooks.mockRejectedValueOnce(new RateLimitError(60000, 'Hardcover'));
      await service.search('test');

      // All methods should be skipped during backoff
      expect(await service.getBook('123')).toBeNull();
      expect(await service.getAuthor('123')).toBeNull();

      // Provider methods should not have been called after backoff set
      expect(mockProvider.getBook).not.toHaveBeenCalled();
      expect(mockProvider.getAuthor).not.toHaveBeenCalled();
    });

    it('skips enrichBook during Audnexus backoff window', async () => {
      // First call triggers rate limit
      mockAudnexus.getBook.mockRejectedValueOnce(new RateLimitError(60000, 'Audnexus'));
      await expect(service.enrichBook('B000FIRST')).rejects.toThrow(RateLimitError);

      // Second call should be skipped (returns null, no Audnexus call)
      const result = await service.enrichBook('B000SECOND');
      expect(result).toBeNull();
      // Audnexus should only have been called once
      expect(mockAudnexus.getBook).toHaveBeenCalledTimes(1);
    });

    it('re-throws RateLimitError from enrichBook for job handling', async () => {
      mockAudnexus.getBook.mockRejectedValueOnce(new RateLimitError(30000, 'Audnexus'));

      await expect(service.enrichBook('B000TEST')).rejects.toThrow(RateLimitError);
    });
  });

  describe('no API key', () => {
    it('returns empty results when HARDCOVER_API_KEY is not set', async () => {
      vi.stubEnv('HARDCOVER_API_KEY', '');
      vi.stubEnv('GOOGLE_BOOKS_API_KEY', '');
      const noKeyService = new MetadataService(createMockLogger() as any);

      expect(noKeyService.getProviders()).toEqual([]);
      expect(await noKeyService.search('test')).toEqual({ books: [], authors: [], series: [] });
      expect(await noKeyService.searchBooks('test')).toEqual([]);
      expect(await noKeyService.searchAuthors('test')).toEqual([]);
      expect(await noKeyService.getBook('123')).toBeNull();
      expect(await noKeyService.getAuthor('123')).toBeNull();
      expect(await noKeyService.getAuthorBooks('123')).toEqual([]);
      expect(await noKeyService.getSeries('123')).toBeNull();
      expect(await noKeyService.testProviders()).toEqual([]);
    });
  });
});
