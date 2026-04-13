import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitError, TransientError, METADATA_SEARCH_PROVIDER_FACTORIES } from '../../core/index.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import { MetadataService } from './metadata.service.js';

const mockFactories = vi.mocked(METADATA_SEARCH_PROVIDER_FACTORIES);

const mockAudibleProvider = {
  name: 'Audible.com',
  type: 'audible',
  searchAuthors: vi.fn().mockResolvedValue([]),
  searchBooks: vi.fn().mockResolvedValue({ books: [] }),
  searchSeries: vi.fn().mockResolvedValue([]),
  getBook: vi.fn().mockResolvedValue(null),
  test: vi.fn().mockResolvedValue({ success: true }),
};

const mockAudnexus = {
  name: 'Audnexus',
  type: 'audnexus',
  getBook: vi.fn().mockResolvedValue(null),
  getAuthor: vi.fn().mockResolvedValue(null),
};

vi.mock('../../core/index.js', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('../../core/index.js')>();
  return {
    ...actual,
    METADATA_SEARCH_PROVIDER_FACTORIES: {
      audible: vi.fn().mockImplementation(function () { return mockAudibleProvider; }),
    },
    AudnexusProvider: vi.fn().mockImplementation(function () { return mockAudnexus; }),
  };
});

describe('MetadataService', () => {
  let service: MetadataService;
  let mockLog: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock return values
    mockAudibleProvider.searchAuthors.mockResolvedValue([]);
    mockAudibleProvider.searchBooks.mockResolvedValue({ books: [] });
    mockAudibleProvider.searchSeries.mockResolvedValue([]);
    mockAudibleProvider.getBook.mockResolvedValue(null);
    mockAudibleProvider.test.mockResolvedValue({ success: true });
    mockAudnexus.getBook.mockResolvedValue(null);
    mockAudnexus.getAuthor.mockResolvedValue(null);

    mockLog = createMockLogger();
    service = new MetadataService(inject<FastifyBaseLogger>(mockLog));
  });

  describe('search', () => {
    it('calls searchBooks, searchAuthors, searchSeries on search provider', async () => {
      const result = await service.search('test query');
      expect(result.books).toEqual([]);
      expect(result.authors).toEqual([]);
      expect(result.series).toEqual([]);
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('test query');
      expect(mockAudibleProvider.searchAuthors).toHaveBeenCalledWith('test query');
      expect(mockAudibleProvider.searchSeries).toHaveBeenCalledWith('test query');
    });

    it('returns results from search provider', async () => {
      const mockBooks = [{ title: 'Book A' }];
      const mockAuthors = [{ name: 'Author A' }];
      const mockSeries = [{ name: 'Series A' }];
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: mockBooks });
      mockAudibleProvider.searchAuthors.mockResolvedValueOnce(mockAuthors);
      mockAudibleProvider.searchSeries.mockResolvedValueOnce(mockSeries);

      const result = await service.search('query');
      expect(result.books).toEqual(mockBooks);
      expect(result.authors).toEqual(mockAuthors);
      expect(result.series).toEqual(mockSeries);
    });

    describe('language filtering', () => {
      const mockSettingsService = {
        get: vi.fn(),
        getAll: vi.fn(),
        set: vi.fn(),
      };
      let serviceWithSettings: MetadataService;

      beforeEach(() => {
        mockSettingsService.get.mockReset();
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false, monitorForUpgrades: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: ['english'] });
          return Promise.resolve({});
        });
        serviceWithSettings = new MetadataService(inject<FastifyBaseLogger>(mockLog), undefined, mockSettingsService as never);
      });

      it('filters books with non-matching language', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'English Book', language: 'english' },
            { title: 'German Book', language: 'german' },
          ],
        });
        mockAudibleProvider.searchAuthors.mockResolvedValueOnce([]);
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([]);

        const result = await serviceWithSettings.search('test');
        expect(result.books).toEqual([{ title: 'English Book', language: 'english' }]);
      });

      it('passes through books with no language field', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'No Language Field' },
            { title: 'English Book', language: 'english' },
          ],
        });
        mockAudibleProvider.searchAuthors.mockResolvedValueOnce([]);
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([]);

        const result = await serviceWithSettings.search('test');
        expect(result.books).toHaveLength(2);
      });

      it('returns all books when languages array is empty', async () => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false, monitorForUpgrades: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: [] });
          return Promise.resolve({});
        });

        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'German Book', language: 'german' },
            { title: 'English Book', language: 'english' },
          ],
        });
        mockAudibleProvider.searchAuthors.mockResolvedValueOnce([]);
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([]);

        const result = await serviceWithSettings.search('test');
        expect(result.books).toHaveLength(2);
      });

      it('applies case-insensitive language comparison', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Mixed Case', language: 'English' },
            { title: 'Upper Case', language: 'ENGLISH' },
            { title: 'German Book', language: 'German' },
          ],
        });
        mockAudibleProvider.searchAuthors.mockResolvedValueOnce([]);
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([]);

        const result = await serviceWithSettings.search('test');
        expect(result.books).toEqual([
          { title: 'Mixed Case', language: 'English' },
          { title: 'Upper Case', language: 'ENGLISH' },
        ]);
      });

      it('includes books matching any of multiple configured languages', async () => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false, monitorForUpgrades: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: ['english', 'french'] });
          return Promise.resolve({});
        });

        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'English Book', language: 'english' },
            { title: 'French Book', language: 'french' },
            { title: 'German Book', language: 'german' },
          ],
        });
        mockAudibleProvider.searchAuthors.mockResolvedValueOnce([]);
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([]);

        const result = await serviceWithSettings.search('test');
        expect(result.books).toEqual([
          { title: 'English Book', language: 'english' },
          { title: 'French Book', language: 'french' },
        ]);
      });

      it('returns unfiltered results when SettingsService is not injected (fail-open)', async () => {
        const allBooks = [
          { title: 'English Book', language: 'english' },
          { title: 'German Book', language: 'german' },
        ];
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: allBooks });
        mockAudibleProvider.searchAuthors.mockResolvedValueOnce([]);
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([]);

        const result = await service.search('test');
        expect(result.books).toEqual(allBooks);
      });

      it('returns unfiltered results and logs warning when settings lookup throws (fail-open)', async () => {
        mockSettingsService.get.mockRejectedValue(new Error('DB unavailable'));

        const allBooks = [
          { title: 'English Book', language: 'english' },
          { title: 'German Book', language: 'german' },
        ];
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: allBooks });
        mockAudibleProvider.searchAuthors.mockResolvedValueOnce([]);
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([]);

        const result = await serviceWithSettings.search('test');
        expect(result.books).toEqual(allBooks);
        expect(mockLog.warn).toHaveBeenCalled();
      });

      it('returns empty books array when all books are filtered out', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'German Book', language: 'german' },
            { title: 'French Book', language: 'french' },
          ],
        });
        mockAudibleProvider.searchAuthors.mockResolvedValueOnce([]);
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([]);

        const result = await serviceWithSettings.search('test');
        expect(result.books).toEqual([]);
      });

      it('does not filter authors or series results', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [{ title: 'English Book', language: 'english' }],
        });
        mockAudibleProvider.searchAuthors.mockResolvedValueOnce([{ name: 'German Author' }]);
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([{ name: 'German Series' }]);

        const result = await serviceWithSettings.search('test');
        expect(result.authors).toEqual([{ name: 'German Author' }]);
        expect(result.series).toEqual([{ name: 'German Series' }]);
      });
    });
  });

  describe('searchBooks', () => {
    it('delegates to search provider', async () => {
      const mockBooks = [{ title: 'Test Book' }];
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: mockBooks });

      const result = await service.searchBooks('query');
      expect(result).toEqual(mockBooks);
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('query', undefined);
    });
  });

  describe('searchAuthors', () => {
    it('delegates to search provider', async () => {
      const mockAuthors = [{ name: 'Test Author' }];
      mockAudibleProvider.searchAuthors.mockResolvedValueOnce(mockAuthors);

      const result = await service.searchAuthors('query');
      expect(result).toEqual(mockAuthors);
      expect(mockAudibleProvider.searchAuthors).toHaveBeenCalledWith('query');
    });
  });

  describe('getBook', () => {
    it('delegates to search provider', async () => {
      const mockBook = { title: 'The Book' };
      mockAudibleProvider.getBook.mockResolvedValueOnce(mockBook);

      const result = await service.getBook('B123');
      expect(result).toEqual(mockBook);
      expect(mockAudibleProvider.getBook).toHaveBeenCalledWith('B123');
    });
  });

  describe('getAuthor', () => {
    it('delegates to Audnexus enrichment provider', async () => {
      const mockAuthor = { name: 'Test Author', asin: 'B001' };
      mockAudnexus.getAuthor.mockResolvedValueOnce(mockAuthor);

      const result = await service.getAuthor('B001');
      expect(result).toEqual(mockAuthor);
      expect(mockAudnexus.getAuthor).toHaveBeenCalledWith('B001');
    });
  });

  describe('enrichBook', () => {
    it('delegates to Audnexus enrichment provider', async () => {
      const mockEnriched = { title: 'Enriched Book', narrators: ['Jim Dale'], duration: 600 };
      mockAudnexus.getBook.mockResolvedValueOnce(mockEnriched);

      const result = await service.enrichBook('B000TEST');
      expect(result).toEqual(mockEnriched);
      expect(mockAudnexus.getBook).toHaveBeenCalledWith('B000TEST');
    });
  });

  describe('testProviders', () => {
    it('tests only search providers (not Audnexus)', async () => {
      mockAudibleProvider.test.mockResolvedValueOnce({ success: true, message: 'OK' });

      const results = await service.testProviders();
      expect(results).toEqual([{ name: 'Audible.com', type: 'audible', success: true, message: 'OK' }]);
    });
  });

  describe('getProviders', () => {
    it('returns only search providers (not Audnexus)', () => {
      const providers = service.getProviders();
      expect(providers).toEqual([{ name: 'Audible.com', type: 'audible' }]);
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
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: mockBooks });

      const result = await service.getAuthorBooks('B001IGFHW6');
      expect(result).toEqual(mockBooks);
      expect(mockAudnexus.getAuthor).toHaveBeenCalledWith('B001IGFHW6');
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith(
        'Brandon Sanderson',
        expect.objectContaining({ author: 'Brandon Sanderson', maxResults: 50 }),
      );
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

    describe('with SettingsService', () => {
      const mockSettingsService = {
        get: vi.fn(),
        getAll: vi.fn(),
        set: vi.fn(),
      };
      let serviceWithSettings: MetadataService;

      beforeEach(() => {
        mockSettingsService.get.mockReset();
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false, monitorForUpgrades: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: ['english'] });
          return Promise.resolve({});
        });
        serviceWithSettings = new MetadataService(inject<FastifyBaseLogger>(mockLog), undefined, mockSettingsService as never);
      });

      it('passes author param and maxResults: 50 to provider.searchBooks', async () => {
        mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Brandon Sanderson', asin: 'B001IGFHW6' });
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [{ title: 'Mistborn' }] });

        await serviceWithSettings.getAuthorBooks('B001IGFHW6');
        expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith(
          'Brandon Sanderson',
          expect.objectContaining({ author: 'Brandon Sanderson', maxResults: 50 }),
        );
      });

      it('filters results with reject words in title (case-insensitive)', async () => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: 'dramatized', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false, monitorForUpgrades: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: [] });
          return Promise.resolve({});
        });
        mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'B123' });
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Good Book', subtitle: undefined, language: 'english' },
            { title: 'Dramatized Edition', subtitle: undefined, language: 'english' },
          ],
        });

        const result = await serviceWithSettings.getAuthorBooks('B123');
        expect(result).toEqual([{ title: 'Good Book', subtitle: undefined, language: 'english' }]);
      });

      it('filters results with reject words in subtitle only', async () => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: 'full-cast', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false, monitorForUpgrades: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: [] });
          return Promise.resolve({});
        });
        mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'B123' });
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Clean Title', subtitle: 'A Full-Cast Production', language: 'english' },
            { title: 'Also Clean', subtitle: 'Unabridged', language: 'english' },
          ],
        });

        const result = await serviceWithSettings.getAuthorBooks('B123');
        expect(result).toEqual([{ title: 'Also Clean', subtitle: 'Unabridged', language: 'english' }]);
      });

      it('filters results with non-matching language', async () => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false, monitorForUpgrades: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: ['english'] });
          return Promise.resolve({});
        });
        mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'B123' });
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'English Book', language: 'english' },
            { title: 'German Book', language: 'german' },
          ],
        });

        const result = await serviceWithSettings.getAuthorBooks('B123');
        expect(result).toEqual([{ title: 'English Book', language: 'english' }]);
      });

      it('passes through results with no language field', async () => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false, monitorForUpgrades: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: ['english'] });
          return Promise.resolve({});
        });
        mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'B123' });
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'No Language Field' },
            { title: 'English Book', language: 'english' },
          ],
        });

        const result = await serviceWithSettings.getAuthorBooks('B123');
        expect(result).toHaveLength(2);
      });

      it('returns all results when reject words setting is empty', async () => {
        mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'B123' });
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [{ title: 'Book A' }, { title: 'Book B' }],
        });

        const result = await serviceWithSettings.getAuthorBooks('B123');
        expect(result).toHaveLength(2);
      });

      it('returns all results when languages setting is empty array', async () => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false, monitorForUpgrades: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: [] });
          return Promise.resolve({});
        });
        mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'B123' });
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'German Book', language: 'german' },
            { title: 'English Book', language: 'english' },
          ],
        });

        const result = await serviceWithSettings.getAuthorBooks('B123');
        expect(result).toHaveLength(2);
      });

      it('applies both reject word and language filters together', async () => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: 'dramatized', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false, monitorForUpgrades: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: ['english'] });
          return Promise.resolve({});
        });
        mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'B123' });
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Good English', language: 'english' },
            { title: 'Dramatized English', language: 'english' },
            { title: 'Good German', language: 'german' },
            { title: 'Dramatized German', language: 'german' },
          ],
        });

        const result = await serviceWithSettings.getAuthorBooks('B123');
        expect(result).toEqual([{ title: 'Good English', language: 'english' }]);
      });

      it('returns unfiltered results when settings lookup fails (fail open)', async () => {
        mockSettingsService.get.mockRejectedValue(new Error('DB unavailable'));
        mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'B123' });
        const allBooks = [{ title: 'Book A' }, { title: 'Book B' }];
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: allBooks });

        const result = await serviceWithSettings.getAuthorBooks('B123');
        expect(result).toEqual(allBooks);
        expect(mockLog.warn).toHaveBeenCalled();
      });
    });

    it('returns unfiltered results when no SettingsService injected', async () => {
      mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'B123' });
      const allBooks = [{ title: 'Book A' }, { title: 'Book B' }];
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: allBooks });

      const result = await service.getAuthorBooks('B123');
      expect(result).toEqual(allBooks);
    });
  });

  describe('getSeries', () => {
    it('returns null directly without delegating to any provider', async () => {
      const result = await service.getSeries('999');
      expect(result).toBeNull();
      // Should NOT call any provider method
      expect(mockAudibleProvider.getBook).not.toHaveBeenCalled();
    });
  });

  describe('no API keys', () => {
    it('still has Audible provider when no API keys are set', async () => {
      const minService = new MetadataService(inject<FastifyBaseLogger>(createMockLogger()));

      // Audible is always available (no API key required)
      expect(minService.getProviders()).toHaveLength(1);
      expect(minService.getProviders()[0].type).toBe('audible');
    });
  });

  describe('searchBooksForDiscovery', () => {
    it('returns books and empty warnings on success', async () => {
      const mockBooks = [{ asin: 'B001', title: 'Test Book' }];
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: mockBooks });

      const result = await service.searchBooksForDiscovery('Brandon Sanderson');
      expect(result).toEqual({ books: mockBooks, warnings: [] });
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('Brandon Sanderson', undefined);
    });

    it('passes maxResults option to provider', async () => {
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [] });

      await service.searchBooksForDiscovery('Author Name', { maxResults: 25 });
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('Author Name', { maxResults: 25 });
    });

    it('returns warnings when rate limit error occurs mid-query', async () => {
      mockAudibleProvider.searchBooks.mockRejectedValueOnce(
        new RateLimitError(60000, 'Audible.com'),
      );

      const result = await service.searchBooksForDiscovery('test');
      expect(result.books).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('rate limit');
    });

    it('returns default maxResults when no options provided', async () => {
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [] });

      await service.searchBooksForDiscovery('test query');
      // Called with query and undefined options (provider applies its own default)
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('test query', undefined);
    });

    it('surfaces non-rate-limit errors via warnings', async () => {
      mockAudibleProvider.searchBooks.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.searchBooksForDiscovery('test');
      expect(result.books).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Network error');
    });
  });

  describe('TransientError contract verification', () => {
    it('withThrottledSearch: TransientError returns [] with warning containing transient context', async () => {
      const transientErr = new TransientError('Audible.com', 'HTTP 503 Service Unavailable');
      mockAudibleProvider.searchBooks.mockRejectedValueOnce(transientErr);

      const result = await service.search('test');
      expect(result.books).toEqual([]);
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThan(0);
      expect(result.warnings![0]).toContain('transient failure');
    });

    it('withThrottle: TransientError returns fallback and logs warning', async () => {
      const transientErr = new TransientError('Audible.com', 'HTTP 500 Internal Server Error');
      mockAudibleProvider.getBook.mockRejectedValueOnce(transientErr);

      const result = await service.getBook('B000TEST');
      expect(result).toBeNull();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'B000TEST', error: transientErr }),
        'Metadata getBook failed',
      );
    });

    it('getAuthor(): Audnexus TransientError returns null and logs warning', async () => {
      const transientErr = new TransientError('Audnexus', 'HTTP 503 Service Unavailable');
      mockAudnexus.getAuthor.mockRejectedValueOnce(transientErr);

      const result = await service.getAuthor('B001TEST');
      expect(result).toBeNull();
      expect(mockLog.warn).toHaveBeenCalledWith(transientErr, 'Audnexus getAuthor failed');
    });

    it('getAuthor(): Audnexus RateLimitError returns null and sets rate limit', async () => {
      mockAudnexus.getAuthor.mockRejectedValueOnce(new RateLimitError(30000, 'Audnexus'));

      const result = await service.getAuthor('B001TEST');
      expect(result).toBeNull();

      // Subsequent call should be skipped due to rate limit
      const result2 = await service.getAuthor('B002TEST');
      expect(result2).toBeNull();
      // getAuthor should only have been called once (second was skipped)
      expect(mockAudnexus.getAuthor).toHaveBeenCalledTimes(1);
    });

    it('enrichBook(): Audnexus TransientError returns null and logs warning', async () => {
      const transientErr = new TransientError('Audnexus', 'Connection timed out');
      mockAudnexus.getBook.mockRejectedValueOnce(transientErr);

      const result = await service.enrichBook('B000TEST');
      expect(result).toBeNull();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: transientErr, asin: 'B000TEST' }),
        'Audnexus enrichment lookup failed',
      );
    });

    it('enrichBook(): Audnexus RateLimitError re-throws for enrichment job', async () => {
      mockAudnexus.getBook.mockRejectedValueOnce(new RateLimitError(30000, 'Audnexus'));

      await expect(service.enrichBook('B000TEST')).rejects.toThrow(RateLimitError);
    });
  });

  describe('zero search providers (empty registry)', () => {
    let emptyService: MetadataService;

    beforeEach(() => {
      // Temporarily empty the registry
      const saved = { ...mockFactories };
      for (const key of Object.keys(mockFactories)) {
        delete (mockFactories as Record<string, unknown>)[key];
      }
      emptyService = new MetadataService(inject<FastifyBaseLogger>(createMockLogger()));
      // Restore registry for other tests
      Object.assign(mockFactories, saved);
    });

    it('search returns empty results without throwing', async () => {
      const result = await emptyService.search('test');
      expect(result).toEqual({ books: [], authors: [], series: [] });
    });

    it('searchBooks returns empty array', async () => {
      const result = await emptyService.searchBooks('test');
      expect(result).toEqual([]);
    });

    it('searchAuthors returns empty array', async () => {
      const result = await emptyService.searchAuthors('test');
      expect(result).toEqual([]);
    });

    it('getBook returns null', async () => {
      const result = await emptyService.getBook('B123');
      expect(result).toBeNull();
    });

    it('searchBooksForDiscovery returns empty results', async () => {
      const result = await emptyService.searchBooksForDiscovery('test');
      expect(result).toEqual({ books: [], warnings: [] });
    });

    it('getProviders returns empty array', () => {
      expect(emptyService.getProviders()).toEqual([]);
    });

    it('testProviders returns empty array', async () => {
      const result = await emptyService.testProviders();
      expect(result).toEqual([]);
    });

    it('getAuthor still delegates to Audnexus', async () => {
      const mockAuthor = { name: 'Test Author', asin: 'B001' };
      mockAudnexus.getAuthor.mockResolvedValueOnce(mockAuthor);

      const result = await emptyService.getAuthor('B001');
      expect(result).toEqual(mockAuthor);
      expect(mockAudnexus.getAuthor).toHaveBeenCalledWith('B001');
    });

    it('enrichBook still delegates to Audnexus', async () => {
      const mockBook = { title: 'Enriched', narrators: ['Jim Dale'] };
      mockAudnexus.getBook.mockResolvedValueOnce(mockBook);

      const result = await emptyService.enrichBook('B000TEST');
      expect(result).toEqual(mockBook);
      expect(mockAudnexus.getBook).toHaveBeenCalledWith('B000TEST');
    });
  });

  describe('factory config forwarding', () => {
    it('forwards audibleRegion to registry factory', () => {
      const factoryFn = mockFactories.audible as ReturnType<typeof vi.fn>;
      factoryFn.mockClear();

      new MetadataService(inject<FastifyBaseLogger>(createMockLogger()), { audibleRegion: 'uk' });

      expect(factoryFn).toHaveBeenCalledWith({ region: 'uk' });
    });

    it('defaults region when audibleRegion not provided', () => {
      const factoryFn = mockFactories.audible as ReturnType<typeof vi.fn>;
      factoryFn.mockClear();

      new MetadataService(inject<FastifyBaseLogger>(createMockLogger()));

      expect(factoryFn).toHaveBeenCalledWith({ region: 'us' });
    });
  });

  // ── #229 Observability — debug logging ──────────────────────────────────
  describe('debug logging (#229)', () => {
    it('searchBooks() logs { query, provider, resultCount } at debug on completion', async () => {
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [{ title: 'A' }] });
      await service.searchBooks('my query');
      expect(mockLog.debug).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'my query', provider: 'Audible.com', resultCount: 1 }),
        'searchBooks completed',
      );
    });

    it('searchBooks() with zero results logs resultCount: 0', async () => {
      await service.searchBooks('nothing');
      expect(mockLog.debug).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'nothing', resultCount: 0 }),
        'searchBooks completed',
      );
    });

    it('getBook() found case logs { id, provider, found: true } at debug', async () => {
      mockAudibleProvider.getBook.mockResolvedValueOnce({ title: 'Found' });
      await service.getBook('B123');
      expect(mockLog.debug).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'B123', provider: 'Audible.com', found: true }),
        'getBook completed',
      );
    });

    it('getBook() not-found case logs { id, provider, found: false } at debug', async () => {
      await service.getBook('B999');
      expect(mockLog.debug).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'B999', provider: 'Audible.com', found: false }),
        'getBook completed',
      );
    });

    it('Audible parse drop: rawCount > books.length logs { rawCount, parsedCount, provider }', async () => {
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [{ title: 'A' }], rawCount: 3 });
      await service.searchBooks('test');
      expect(mockLog.debug).toHaveBeenCalledWith(
        expect.objectContaining({ rawCount: 3, parsedCount: 1, provider: 'Audible.com' }),
        'Metadata search parse drop detected',
      );
    });

    it('Audible parse drop: rawCount === books.length emits no extra log', async () => {
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [{ title: 'A' }], rawCount: 1 });
      await service.searchBooks('test');
      expect(mockLog.debug).not.toHaveBeenCalledWith(
        expect.anything(),
        'Metadata search parse drop detected',
      );
    });

    it('non-Audible provider omitting rawCount emits no extra log', async () => {
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [{ title: 'A' }] });
      await service.searchBooks('test');
      expect(mockLog.debug).not.toHaveBeenCalledWith(
        expect.anything(),
        'Metadata search parse drop detected',
      );
    });

    it('withThrottle failure log includes query field when context provided', async () => {
      mockAudibleProvider.searchBooks.mockRejectedValueOnce(new Error('fail'));
      await service.searchBooks('my-query');
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'my-query' }),
        'Metadata searchBooks failed',
      );
    });
  });

  // ── #229 Observability — SearchBooksResult contract ─────────────────────
  describe('SearchBooksResult contract (#229)', () => {
    it('search() correctly unwraps .books from SearchBooksResult', async () => {
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [{ title: 'X' }] });
      const result = await service.search('test');
      expect(result.books).toEqual([{ title: 'X' }]);
    });

    it('searchBooks() correctly unwraps .books', async () => {
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [{ title: 'Y' }] });
      const result = await service.searchBooks('test');
      expect(result).toEqual([{ title: 'Y' }]);
    });

    it('searchBooksForDiscovery() correctly unwraps .books', async () => {
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [{ title: 'Z' }] });
      const result = await service.searchBooksForDiscovery('test');
      expect(result.books).toEqual([{ title: 'Z' }]);
    });

    it('getAuthorBooks() correctly unwraps .books', async () => {
      mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'A1' });
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [{ title: 'W' }] });
      const result = await service.getAuthorBooks('A1');
      expect(result).toEqual([{ title: 'W' }]);
    });
  });

  describe('structured search params relay', () => {
    it('relays structured options (title, author) to provider searchBooks', async () => {
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [] });

      await service.searchBooks('fallback', { title: 'Dune', author: 'Frank Herbert' });
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('fallback', { title: 'Dune', author: 'Frank Herbert' });
    });

    it('works without structured options (backward compatibility)', async () => {
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [{ title: 'Result' }] });

      const result = await service.searchBooks('keywords query');
      expect(result).toEqual([{ title: 'Result' }]);
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('keywords query', undefined);
    });
  });
});
