import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitError } from '@narratorr/core';
import { createMockLogger } from '../__tests__/helpers.js';
import { MetadataService } from './metadata.service.js';

const mockAudibleProvider = {
  name: 'Audible.com',
  type: 'audible',
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
  getAuthor: vi.fn().mockResolvedValue(null),
};

vi.mock('@narratorr/core', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@narratorr/core')>();
  return {
    ...actual,
    AudibleProvider: vi.fn().mockImplementation(() => mockAudibleProvider),
    AudnexusProvider: vi.fn().mockImplementation(() => mockAudnexus),
  };
});

describe('MetadataService', () => {
  let service: MetadataService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock return values
    mockAudibleProvider.search.mockResolvedValue({ books: [], authors: [], series: [] });
    mockAudibleProvider.searchAuthors.mockResolvedValue([]);
    mockAudibleProvider.searchBooks.mockResolvedValue([]);
    mockAudibleProvider.getAuthor.mockResolvedValue(null);
    mockAudibleProvider.getAuthorBooks.mockResolvedValue([]);
    mockAudibleProvider.getBook.mockResolvedValue(null);
    mockAudibleProvider.getSeries.mockResolvedValue(null);
    mockAudibleProvider.test.mockResolvedValue({ success: true });
    mockAudnexus.getBook.mockResolvedValue(null);
    mockAudnexus.getAuthor.mockResolvedValue(null);
    service = new MetadataService(createMockLogger() as any);
  });

  describe('search', () => {
    it('delegates to the primary provider (Audible)', async () => {
      const result = await service.search('Brandon Sanderson');
      expect(result).toEqual({ books: [], authors: [], series: [] });
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('Brandon Sanderson');
      expect(mockAudibleProvider.searchAuthors).toHaveBeenCalledWith('Brandon Sanderson');
      expect(mockAudibleProvider.searchSeries).toHaveBeenCalledWith('Brandon Sanderson');
    });

    it('returns empty results on error', async () => {
      mockAudibleProvider.searchBooks.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.search('test');
      expect(result.books).toEqual([]);
      expect(mockAudibleProvider.searchAuthors).toHaveBeenCalled();
      expect(mockAudibleProvider.searchSeries).toHaveBeenCalled();
    });

    it('throttles each sub-search individually to prevent bursting', async () => {
      const callOrder: string[] = [];
      mockAudibleProvider.searchBooks.mockImplementation(() => { callOrder.push('books'); return Promise.resolve([]); });
      mockAudibleProvider.searchAuthors.mockImplementation(() => { callOrder.push('authors'); return Promise.resolve([]); });
      mockAudibleProvider.searchSeries.mockImplementation(() => { callOrder.push('series'); return Promise.resolve([]); });

      await service.search('test');

      expect(callOrder).toEqual(['books', 'authors', 'series']);
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledTimes(1);
      expect(mockAudibleProvider.searchAuthors).toHaveBeenCalledTimes(1);
      expect(mockAudibleProvider.searchSeries).toHaveBeenCalledTimes(1);
    });
  });

  describe('searchAuthors', () => {
    it('delegates to the provider', async () => {
      const result = await service.searchAuthors('Brandon');
      expect(result).toEqual([]);
    });

    it('returns empty array on error', async () => {
      mockAudibleProvider.searchAuthors.mockRejectedValueOnce(new Error('fail'));

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
    it('routes to Audnexus and returns author when found', async () => {
      const mockAuthor = { name: 'Brandon Sanderson', asin: 'B001IGFHW6' };
      mockAudnexus.getAuthor.mockResolvedValueOnce(mockAuthor);

      const result = await service.getAuthor('B001IGFHW6');
      expect(result).toEqual(mockAuthor);
      expect(mockAudnexus.getAuthor).toHaveBeenCalledWith('B001IGFHW6');
      expect(mockAudibleProvider.getAuthor).not.toHaveBeenCalled();
    });

    it('returns null when Audnexus has no data', async () => {
      const result = await service.getAuthor('UNKNOWN');
      expect(result).toBeNull();
      expect(mockAudnexus.getAuthor).toHaveBeenCalledWith('UNKNOWN');
    });

    it('returns null on Audnexus error', async () => {
      mockAudnexus.getAuthor.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.getAuthor('B001IGFHW6');
      expect(result).toBeNull();
    });

    it('returns null when Audnexus is rate limited', async () => {
      mockAudnexus.getBook.mockRejectedValueOnce(new RateLimitError(60000, 'Audnexus'));
      await expect(service.enrichBook('B000FIRST')).rejects.toThrow(RateLimitError);

      const result = await service.getAuthor('B001IGFHW6');
      expect(result).toBeNull();
      expect(mockAudnexus.getAuthor).not.toHaveBeenCalled();
    });
  });

  describe('getBook', () => {
    it('returns null when not found', async () => {
      const result = await service.getBook('328491');
      expect(result).toBeNull();
    });

    it('returns book when found', async () => {
      const mockBook = { title: 'The Way of Kings', authors: [] };
      mockAudibleProvider.getBook.mockResolvedValueOnce(mockBook);

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

    it('returns partial data with only narrators (no duration)', async () => {
      mockAudnexus.getBook.mockResolvedValueOnce({
        title: 'Partial',
        authors: [{ name: 'Author' }],
        narrators: ['Jim Dale'],
      });

      const result = await service.enrichBook('B_PARTIAL');
      expect(result).not.toBeNull();
      expect(result!.narrators).toEqual(['Jim Dale']);
      expect(result!.duration).toBeUndefined();
    });

    it('returns data with empty narrators array', async () => {
      mockAudnexus.getBook.mockResolvedValueOnce({
        title: 'Empty Narr',
        authors: [{ name: 'Author' }],
        narrators: [],
        duration: 480,
      });

      const result = await service.enrichBook('B_EMPTY');
      expect(result).not.toBeNull();
      expect(result!.narrators).toEqual([]);
      expect(result!.duration).toBe(480);
    });

    it('returns data with only duration (no narrators)', async () => {
      mockAudnexus.getBook.mockResolvedValueOnce({
        title: 'Duration Only',
        authors: [{ name: 'Author' }],
        duration: 300,
      });

      const result = await service.enrichBook('B_DUR_ONLY');
      expect(result).not.toBeNull();
      expect(result!.narrators).toBeUndefined();
      expect(result!.duration).toBe(300);
    });
  });

  describe('provider registration', () => {
    it('registers Audible as the only provider', () => {
      const providers = service.getProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]).toEqual({ name: 'Audible.com', type: 'audible' });
    });

    it('registers Audible with custom region', () => {
      const ukService = new MetadataService(createMockLogger() as any, { audibleRegion: 'uk' });
      const providers = ukService.getProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].type).toBe('audible');
    });

    it('testProviders includes only Audible', async () => {
      const results = await service.testProviders();
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Audible.com');
      expect(results[0].type).toBe('audible');
    });
  });

  describe('rate limiting', () => {
    it('returns warnings when provider throws RateLimitError on search', async () => {
      mockAudibleProvider.searchBooks.mockRejectedValueOnce(new RateLimitError(30000, 'Audible.com'));

      const result = await service.search('test');
      expect(result.books).toEqual([]);
      expect(result.warnings).toBeDefined();
      expect(result.warnings![0]).toContain('rate limit');
      expect(result.warnings![0]).toContain('30s');
    });

    it('skips provider during backoff window after RateLimitError', async () => {
      mockAudibleProvider.searchBooks.mockRejectedValueOnce(new RateLimitError(60000, 'Audible.com'));
      await service.search('first');

      const result = await service.search('second');
      expect(result.books).toEqual([]);
      expect(result.warnings).toBeDefined();
      expect(result.warnings![0]).toContain('rate limit');
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledTimes(1);
    });

    it('returns fallback on RateLimitError for non-search methods', async () => {
      mockAudibleProvider.getBook.mockRejectedValueOnce(new RateLimitError(30000, 'Audible.com'));

      const result = await service.getBook('123');
      expect(result).toBeNull();
    });

    it('skips non-search methods during Audible backoff window', async () => {
      mockAudibleProvider.searchBooks.mockRejectedValueOnce(new RateLimitError(60000, 'Audible.com'));
      await service.search('test');

      expect(await service.getBook('123')).toBeNull();
      expect(mockAudibleProvider.getBook).not.toHaveBeenCalled();

      // getAuthor uses Audnexus, not Audible — should still work during Audible backoff
      const mockAuthor = { name: 'Test Author', asin: '123' };
      mockAudnexus.getAuthor.mockResolvedValueOnce(mockAuthor);
      expect(await service.getAuthor('123')).toEqual(mockAuthor);
      expect(mockAudnexus.getAuthor).toHaveBeenCalledWith('123');
    });

    it('skips enrichBook during Audnexus backoff window', async () => {
      mockAudnexus.getBook.mockRejectedValueOnce(new RateLimitError(60000, 'Audnexus'));
      await expect(service.enrichBook('B000FIRST')).rejects.toThrow(RateLimitError);

      const result = await service.enrichBook('B000SECOND');
      expect(result).toBeNull();
      expect(mockAudnexus.getBook).toHaveBeenCalledTimes(1);
    });

    it('re-throws RateLimitError from enrichBook for job handling', async () => {
      mockAudnexus.getBook.mockRejectedValueOnce(new RateLimitError(30000, 'Audnexus'));

      await expect(service.enrichBook('B000TEST')).rejects.toThrow(RateLimitError);
    });
  });

  describe('enrichBook edge cases', () => {
    it('returns data with empty narrators array and undefined duration', async () => {
      mockAudnexus.getBook.mockResolvedValueOnce({
        title: 'Sparse Data',
        authors: [{ name: 'Author' }],
        narrators: [],
        duration: undefined,
      });

      const result = await service.enrichBook('B_SPARSE');
      expect(result).not.toBeNull();
      expect(result!.narrators).toEqual([]);
      expect(result!.duration).toBeUndefined();
    });

    it('handles enrichBook with empty ASIN string gracefully', async () => {
      // Empty string ASIN — Audnexus should still be called (validation is caller's job)
      mockAudnexus.getBook.mockResolvedValueOnce(null);

      const result = await service.enrichBook('');
      expect(result).toBeNull();
      expect(mockAudnexus.getBook).toHaveBeenCalledWith('');
    });
  });

  describe('getAuthorBooks', () => {
    it('resolves author name via Audnexus then searches Audible', async () => {
      const mockAuthor = { name: 'Brandon Sanderson', asin: 'B001IGFHW6' };
      const mockBooks = [{ title: 'The Way of Kings' }, { title: 'Mistborn' }];
      mockAudnexus.getAuthor.mockResolvedValueOnce(mockAuthor);
      mockAudibleProvider.searchBooks.mockResolvedValueOnce(mockBooks);

      const result = await service.getAuthorBooks('B001IGFHW6');
      expect(result).toEqual(mockBooks);
      expect(mockAudnexus.getAuthor).toHaveBeenCalledWith('B001IGFHW6');
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('Brandon Sanderson');
    });

    it('returns empty array when author not found in Audnexus', async () => {
      const result = await service.getAuthorBooks('UNKNOWN');
      expect(result).toEqual([]);
      expect(mockAudibleProvider.searchBooks).not.toHaveBeenCalled();
    });

    it('returns empty array when Audible search fails', async () => {
      mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'B123' });
      mockAudibleProvider.searchBooks.mockRejectedValueOnce(new Error('fail'));

      const result = await service.getAuthorBooks('B123');
      expect(result).toEqual([]);
    });
  });

  describe('getSeries', () => {
    it('returns null when not found', async () => {
      const result = await service.getSeries('999');
      expect(result).toBeNull();
    });

    it('returns series when found', async () => {
      const mockSeries = { name: 'The Stormlight Archive', books: [] };
      mockAudibleProvider.getSeries.mockResolvedValueOnce(mockSeries);

      const result = await service.getSeries('100');
      expect(result).toEqual(mockSeries);
    });

    it('returns fallback on error', async () => {
      mockAudibleProvider.getSeries.mockRejectedValueOnce(new Error('fail'));

      const result = await service.getSeries('100');
      expect(result).toBeNull();
    });
  });

  describe('no API keys', () => {
    it('still has Audible provider when no API keys are set', async () => {
      const minService = new MetadataService(createMockLogger() as any);

      // Audible is always available (no API key required)
      expect(minService.getProviders()).toHaveLength(1);
      expect(minService.getProviders()[0].type).toBe('audible');
    });
  });
});
