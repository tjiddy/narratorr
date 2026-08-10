import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { RateLimitError, TransientError, METADATA_SEARCH_PROVIDER_FACTORIES, NARRATOR_PLACEHOLDERS } from '@core/index.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import { MetadataService, isRejectedByWords, PSEUDO_NARRATORS } from './metadata.service.js';
import { AMBIGUOUS_WINDOW_COLLAPSED, AMBIGUOUS_WINDOW_HELD, exactTitleCandidates } from './metadata-resolve-book.js';
import type { BookMetadata } from '@core/index.js';

const mockFactories = vi.mocked(METADATA_SEARCH_PROVIDER_FACTORIES);

const mockAudibleProvider = {
  name: 'Audible.com',
  type: 'audible',
  searchBooks: vi.fn().mockResolvedValue({ books: [] }),
  searchSeries: vi.fn().mockResolvedValue([]),
  getBook: vi.fn().mockResolvedValue(null),
  getBookDetailed: vi.fn().mockResolvedValue({ kind: 'not_found' }),
  test: vi.fn().mockResolvedValue({ success: true }),
};

const mockAudnexus = {
  name: 'Audnexus',
  type: 'audnexus',
  getBook: vi.fn().mockResolvedValue(null),
  getBookDetailed: vi.fn().mockResolvedValue({ kind: 'not_found' }),
  getAuthor: vi.fn().mockResolvedValue(null),
  getChapterRuntime: vi.fn().mockResolvedValue({ kind: 'not_found' }),
};

vi.mock('@core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/index.js')>();
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
    // clearAllMocks leaves *Once queues; reset individual methods to preserve module factories.
    mockAudibleProvider.searchBooks.mockReset();
    mockAudibleProvider.searchSeries.mockReset();
    mockAudibleProvider.getBook.mockReset();
    mockAudibleProvider.getBookDetailed.mockReset();
    mockAudibleProvider.test.mockReset();
    mockAudnexus.getBook.mockReset();
    mockAudnexus.getBookDetailed.mockReset();
    mockAudnexus.getAuthor.mockReset();
    mockAudnexus.getChapterRuntime.mockReset();
    mockAudibleProvider.searchBooks.mockResolvedValue({ books: [] });
    mockAudibleProvider.searchSeries.mockResolvedValue([]);
    mockAudibleProvider.getBook.mockResolvedValue(null);
    mockAudibleProvider.getBookDetailed.mockResolvedValue({ kind: 'not_found' });
    mockAudibleProvider.test.mockResolvedValue({ success: true });
    mockAudnexus.getBook.mockResolvedValue(null);
    mockAudnexus.getBookDetailed.mockResolvedValue({ kind: 'not_found' });
    mockAudnexus.getAuthor.mockResolvedValue(null);
    mockAudnexus.getChapterRuntime.mockResolvedValue({ kind: 'not_found' });

    mockLog = createMockLogger();
    service = new MetadataService(inject<FastifyBaseLogger>(mockLog));
  });

  describe('search', () => {
    it('calls searchBooks once and does NOT call provider.searchSeries (#1020)', async () => {
      const result = await service.search('test query');
      expect(result.books).toEqual([]);
      expect(result.authors).toEqual([]);
      expect(result.series).toEqual([]);
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('test query');
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledTimes(1);
      expect(mockAudibleProvider.searchSeries).not.toHaveBeenCalled();
    });

    it('derives authors and series from the returned books (#1020)', async () => {
      const mockBooks = [
        {
          title: 'Book A',
          authors: [{ name: 'Author A', asin: 'AUTH001' }],
          series: [{ name: 'Series A', asin: 'SER001' }],
        },
      ];
      mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: mockBooks });

      const result = await service.search('query');
      expect(result.books).toEqual(mockBooks);
      expect(result.authors).toEqual([{ name: 'Author A', asin: 'AUTH001' }]);
      expect(result.series).toEqual([{ name: 'Series A', asin: 'SER001', books: [] }]);
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
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false });
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
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([]);

        const result = await serviceWithSettings.search('test');
        expect(result.books).toHaveLength(2);
      });

      it('returns all books when languages array is empty', async () => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: [] });
          return Promise.resolve({});
        });

        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'German Book', language: 'german' },
            { title: 'English Book', language: 'english' },
          ],
        });
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
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([]);

        const result = await serviceWithSettings.search('test');
        expect(result.books).toEqual([
          { title: 'Mixed Case', language: 'English' },
          { title: 'Upper Case', language: 'ENGLISH' },
        ]);
      });

      it('includes books matching any of multiple configured languages', async () => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false });
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
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([]);

        const result = await serviceWithSettings.search('test');
        expect(result.books).toEqual([]);
      });

      it('derives authors and series only from language-kept books (#1020)', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            {
              title: 'English Book',
              language: 'english',
              authors: [{ name: 'English Author' }],
              series: [{ name: 'English Series' }],
            },
            {
              title: 'German Book',
              language: 'german',
              authors: [{ name: 'German Author' }],
              series: [{ name: 'German Series' }],
            },
          ],
        });

        const result = await serviceWithSettings.search('test');
        expect(result.books.map((b) => b.title)).toEqual(['English Book']);
        expect(result.authors).toEqual([{ name: 'English Author' }]);
        expect(result.series).toEqual([{ name: 'English Series', books: [] }]);
      });
    });

    describe('podcast-derived authors/series filtering (#1020)', () => {
      it('returns empty authors and series when every book is filtered as a podcast', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            {
              title: 'Joe Rogan Experience',
              authors: [{ name: 'Joe Rogan' }],
              series: [{ name: 'JRE' }],
              contentDeliveryType: 'PodcastParent',
            },
            {
              title: 'The Daily',
              authors: [{ name: 'Michael Barbaro' }],
              series: [{ name: 'NYT Daily' }],
              contentDeliveryType: 'Periodical',
            },
          ],
        });

        const result = await service.search('joe rogan');
        expect(result.books).toEqual([]);
        expect(result.authors).toEqual([]);
        expect(result.series).toEqual([]);
      });

      it('derives authors and series only from the audiobook subset when results mix audiobooks and podcasts', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            {
              title: 'Brandon Sanderson - Mistborn',
              authors: [{ name: 'Brandon Sanderson', asin: 'AUTH_BS' }],
              series: [{ name: 'Mistborn', asin: 'SER_MB' }],
              contentDeliveryType: 'SinglePartBook',
            },
            {
              title: 'Brandon Sanderson Podcast',
              authors: [{ name: 'Podcast Host' }],
              series: [{ name: 'Podcast Series' }],
              contentDeliveryType: 'PodcastParent',
            },
          ],
        });

        const result = await service.search('brandon sanderson');
        expect(result.books.map((b) => b.title)).toEqual(['Brandon Sanderson - Mistborn']);
        expect(result.authors).toEqual([{ name: 'Brandon Sanderson', asin: 'AUTH_BS' }]);
        expect(result.series).toEqual([{ name: 'Mistborn', asin: 'SER_MB', books: [] }]);
      });

      it('keeps authors and series derived from books with contentDeliveryType === undefined (Audnexus fallback-to-keep)', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            {
              title: 'Audnexus-Origin Book',
              authors: [{ name: 'Older Audible Author' }],
              series: [{ name: 'Older Audible Series' }],
            },
            {
              title: 'Modern Audible Book',
              authors: [{ name: 'Modern Author' }],
              series: [{ name: 'Modern Series' }],
              contentDeliveryType: 'SinglePartBook',
            },
          ],
        });

        const result = await service.search('query');
        expect(result.books).toHaveLength(2);
        expect(result.authors).toEqual([
          { name: 'Older Audible Author' },
          { name: 'Modern Author' },
        ]);
        expect(result.series).toEqual([
          { name: 'Older Audible Series', books: [] },
          { name: 'Modern Series', books: [] },
        ]);
      });

      it('first-occurrence-wins dedup: later book with same author name does NOT overwrite an earlier asin-less entry', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            {
              title: 'First Book',
              authors: [{ name: 'Shared Author' }],
            },
            {
              title: 'Second Book',
              authors: [{ name: 'Shared Author', asin: 'AUTH_LATE' }],
              series: [{ name: 'Shared Series', asin: 'SER_LATE' }],
            },
            {
              title: 'Third Book',
              series: [{ name: 'Shared Series' }],
              authors: [{ name: 'Other' }],
            },
          ],
        });

        const result = await service.search('dedup');
        expect(result.authors).toEqual([
          { name: 'Shared Author' },
          { name: 'Other' },
        ]);
        expect(result.series).toEqual([
          { name: 'Shared Series', asin: 'SER_LATE', books: [] },
        ]);
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

    describe('reject-words filtering (#986)', () => {
      const mockSettingsService = { get: vi.fn(), getAll: vi.fn(), set: vi.fn() };
      let serviceWithSettings: MetadataService;

      const setRejectWords = (rejectWords: string) => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords, requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'none', searchImmediately: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: [] });
          return Promise.resolve({});
        });
      };

      beforeEach(() => {
        mockSettingsService.get.mockReset();
        serviceWithSettings = new MetadataService(inject<FastifyBaseLogger>(mockLog), undefined, mockSettingsService as never);
      });

      it('filters books with reject word in narrators (Virtual Voice knockoff)', async () => {
        setRejectWords('Virtual Voice');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Real Book', authors: [{ name: 'Real Author' }], narrators: ['Jim Dale'] },
            { title: 'Fake Knockoff', authors: [{ name: 'Random Spammer' }], narrators: ['Virtual Voice'] },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([{ title: 'Real Book', authors: [{ name: 'Real Author' }], narrators: ['Jim Dale'] }]);
      });

      it('filters books with reject word in author name', async () => {
        setRejectWords('Amy McMahon');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Sunrise on the Reaping', authors: [{ name: 'Suzanne Collins' }], narrators: [] },
            { title: 'Sunrise on the Reaping', authors: [{ name: 'Amy McMahon' }], narrators: ['Virtual Voice'] },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toHaveLength(1);
        expect(result[0]!.authors![0]!.name).toBe('Suzanne Collins');
      });

      it('filters books with reject word in title (case-insensitive)', async () => {
        setRejectWords('Free Excerpt');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Real Book', authors: [{ name: 'X' }] },
            { title: 'Free Excerpt — Chapter 1', authors: [{ name: 'X' }] },
            { title: 'free EXCERPT teaser', authors: [{ name: 'X' }] },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([{ title: 'Real Book', authors: [{ name: 'X' }] }]);
      });

      it('filters books with reject word in subtitle', async () => {
        setRejectWords('Sample');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Clean', subtitle: 'Unabridged', authors: [{ name: 'X' }] },
            { title: 'Looks Real', subtitle: 'A Sample for the audiobook', authors: [{ name: 'X' }] },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([{ title: 'Clean', subtitle: 'Unabridged', authors: [{ name: 'X' }] }]);
      });

      it('returns all books when rejectWords is empty', async () => {
        setRejectWords('');
        const allBooks = [
          { title: 'Real', authors: [{ name: 'A' }], narrators: ['Virtual Voice'] },
          { title: 'Free Excerpt teaser', authors: [{ name: 'B' }] },
        ];
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: allBooks });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual(allBooks);
      });

      it('returns unfiltered results when settings lookup throws (fail-open)', async () => {
        mockSettingsService.get.mockRejectedValue(new Error('DB unavailable'));
        const allBooks = [
          { title: 'Real', authors: [{ name: 'A' }] },
          { title: 'Free Excerpt teaser', authors: [{ name: 'B' }] },
        ];
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: allBooks });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual(allBooks);
        expect(mockLog.warn).toHaveBeenCalled();
      });

      it('returns unfiltered results when no SettingsService injected', async () => {
        const allBooks = [{ title: 'Free Excerpt teaser', authors: [{ name: 'B' }] }];
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: allBooks });

        const result = await service.searchBooks('query');
        expect(result).toEqual(allBooks);
      });

      it('handles books with missing authors/narrators gracefully', async () => {
        setRejectWords('virtual voice');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'No Authors Field', narrators: ['Virtual Voice'] } as never,
            { title: 'No Narrators Field', authors: [{ name: 'Real' }] } as never,
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([{ title: 'No Narrators Field', authors: [{ name: 'Real' }] }]);
      });

      it('searchBooksForDiscovery applies the same reject-words filter', async () => {
        setRejectWords('Virtual Voice');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Real', authors: [{ name: 'A' }], narrators: ['Jim Dale'] },
            { title: 'Fake', authors: [{ name: 'B' }], narrators: ['Virtual Voice'] },
          ],
        });

        const result = await serviceWithSettings.searchBooksForDiscovery('Author Name');
        expect(result.books).toEqual([{ title: 'Real', authors: [{ name: 'A' }], narrators: ['Jim Dale'] }]);
      });

      it('search() derives authors/series only from rejectWords-kept books (#1020)', async () => {
        setRejectWords('Virtual Voice');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            {
              title: 'Real',
              authors: [{ name: 'A' }],
              series: [{ name: 'Real Series' }],
              narrators: ['Jim Dale'],
            },
            {
              title: 'Fake',
              authors: [{ name: 'Virtual Voice Inc' }],
              series: [{ name: 'Virtual Voice Series' }],
              narrators: ['Virtual Voice'],
            },
          ],
        });

        const result = await serviceWithSettings.search('query');
        expect(result.books).toEqual([
          { title: 'Real', authors: [{ name: 'A' }], series: [{ name: 'Real Series' }], narrators: ['Jim Dale'] },
        ]);
        expect(result.authors).toEqual([{ name: 'A' }]);
        expect(result.series).toEqual([{ name: 'Real Series', books: [] }]);
      });

      it('filters abridged books via formatType surface', async () => {
        setRejectWords('Abridged');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Clean Book', authors: [{ name: 'X' }], formatType: 'unabridged' },
            { title: 'Old Cassette Edition', authors: [{ name: 'X' }], formatType: 'abridged' },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([{ title: 'Clean Book', authors: [{ name: 'X' }], formatType: 'unabridged' }]);
      });

      it('does NOT filter unabridged books when rejectWords is "Abridged" (word-boundary protection)', async () => {
        setRejectWords('Abridged');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'A Book', authors: [{ name: 'X' }], formatType: 'unabridged' },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toHaveLength(1);
        expect(result[0]!.formatType).toBe('unabridged');
      });

      it('Sample matches "Sample Chapters" but not "Sampleyana" (word boundary)', async () => {
        setRejectWords('Sample');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Sample Chapters', authors: [{ name: 'X' }] },
            { title: 'Sampleyana', authors: [{ name: 'X' }] },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([{ title: 'Sampleyana', authors: [{ name: 'X' }] }]);
      });

      it('multi-word phrase "Behind the Scenes" still filters correctly with word boundaries', async () => {
        setRejectWords('Behind the Scenes');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Real Book', authors: [{ name: 'X' }] },
            { title: 'Behind the Scenes Featurette', authors: [{ name: 'X' }] },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([{ title: 'Real Book', authors: [{ name: 'X' }] }]);
      });

      it('with empty rejectWords, abridged books are NOT filtered (override path preserved)', async () => {
        setRejectWords('');
        const books = [
          { title: 'A Book', authors: [{ name: 'X' }], formatType: 'abridged' },
          { title: 'Another', authors: [{ name: 'X' }], formatType: 'unabridged' },
        ];
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual(books);
      });

      it('does NOT reject a book whose narrators include "full cast" literal (Audible Original ensemble)', async () => {
        setRejectWords('Full Cast');
        const thirdEye = {
          title: 'Third Eye',
          authors: [{ name: 'Felicia Day' }],
          narrators: ['Sean Astin', 'Felicia Day', 'Neil Gaiman', 'full cast'],
        };
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [thirdEye] });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([thirdEye]);
      });

      it('DOES reject a book whose title contains "Full Cast" (GraphicAudio-style title match)', async () => {
        setRejectWords('Full Cast');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'The Hobbit (Full Cast Adaptation)', authors: [{ name: 'J.R.R. Tolkien' }], narrators: ['Various Voice Actors'] },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([]);
      });

      it('DOES reject a book whose narrator is "GraphicAudio Full Cast" (real narrator, not pseudo)', async () => {
        setRejectWords('Full Cast');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Some Adaptation', authors: [{ name: 'X' }], narrators: ['GraphicAudio Full Cast'] },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([]);
      });

      it('does NOT reject a book whose narrators include "Various" literal', async () => {
        setRejectWords('Various');
        const ensemble = {
          title: 'Ensemble Production',
          authors: [{ name: 'X' }],
          narrators: ['Jane Doe', 'Various'],
        };
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [ensemble] });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([ensemble]);
      });

      it('does NOT reject a book whose narrators include "unknown" literal', async () => {
        setRejectWords('Unknown');
        const ensemble = {
          title: 'A Quiet Production',
          authors: [{ name: 'Real Author' }],
          narrators: ['Jane Doe', 'unknown'],
        };
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [ensemble] });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([ensemble]);
      });

      it('rejectWord "Various Voices" DOES reject a real narrator "Various Voices Studio" (exact-set, not substring)', async () => {
        setRejectWords('Various Voices');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Some Book', authors: [{ name: 'X' }], narrators: ['Various Voices Studio'] },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([]);
      });

      it('normalizes whitespace and case in pseudo-narrator detection ("  FULL   CAST  ")', async () => {
        setRejectWords('Full Cast');
        const ensemble = {
          title: 'Quirky Payload Book',
          authors: [{ name: 'X' }],
          narrators: ['Real Narrator', '  FULL   CAST  '],
        };
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [ensemble] });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([ensemble]);
      });

      it('does NOT mutate book.narrators — pseudo-narrators still present on returned book', async () => {
        setRejectWords('Full Cast');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Third Eye', authors: [{ name: 'Felicia Day' }], narrators: ['Sean Astin', 'full cast'] },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toHaveLength(1);
        expect(result[0]!.narrators).toEqual(['Sean Astin', 'full cast']);
      });
    });

    describe('language filtering (#1004)', () => {
      const mockSettingsService = { get: vi.fn(), getAll: vi.fn(), set: vi.fn() };
      let serviceWithSettings: MetadataService;

      const setLanguages = (languages: string[], rejectWords = '', minDurationMinutes = 0) => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords, requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'none', searchImmediately: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages, minDurationMinutes });
          return Promise.resolve({});
        });
      };

      beforeEach(() => {
        mockSettingsService.get.mockReset();
        serviceWithSettings = new MetadataService(inject<FastifyBaseLogger>(mockLog), undefined, mockSettingsService as never);
      });

      it('searchBooks: filters out non-matching languages (english only)', async () => {
        setLanguages(['english']);
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'English Book', language: 'english' },
            { title: 'Spanish Book', language: 'spanish' },
            { title: 'German Book', language: 'german' },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([{ title: 'English Book', language: 'english' }]);
      });

      it('searchBooks: keeps books matching any of multiple configured languages', async () => {
        setLanguages(['english', 'spanish']);
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'English Book', language: 'english' },
            { title: 'Spanish Book', language: 'spanish' },
            { title: 'German Book', language: 'german' },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([
          { title: 'English Book', language: 'english' },
          { title: 'Spanish Book', language: 'spanish' },
        ]);
      });

      it('searchBooks: returns all books when languages array is empty (filter disabled)', async () => {
        setLanguages([]);
        const allBooks = [
          { title: 'Spanish Book', language: 'spanish' },
          { title: 'English Book', language: 'english' },
          { title: 'German Book', language: 'german' },
        ];
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: allBooks });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual(allBooks);
      });

      it('searchBooks: passes through books with no language field', async () => {
        setLanguages(['english']);
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'No Language' },
            { title: 'English Book', language: 'english' },
            { title: 'Spanish Book', language: 'spanish' },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([
          { title: 'No Language' },
          { title: 'English Book', language: 'english' },
        ]);
      });

      it('searchBooksForDiscovery: filters out non-matching languages', async () => {
        setLanguages(['english']);
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'English Book', language: 'english' },
            { title: 'Spanish Book', language: 'spanish' },
            { title: 'German Book', language: 'german' },
          ],
        });

        const result = await serviceWithSettings.searchBooksForDiscovery('Author');
        expect(result.books).toEqual([{ title: 'English Book', language: 'english' }]);
      });

      it('searchBooksForDiscovery: returns all books when languages empty', async () => {
        setLanguages([]);
        const allBooks = [
          { title: 'Spanish', language: 'spanish' },
          { title: 'English', language: 'english' },
        ];
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: allBooks });

        const result = await serviceWithSettings.searchBooksForDiscovery('Author');
        expect(result.books).toEqual(allBooks);
      });

      it('searchBooks: tag-pass against Eric multi-language fixture returns only english unabridged', async () => {
        setLanguages(['english'], 'Abridged');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Eric', language: 'english', formatType: 'abridged', duration: 176, authors: [{ name: 'Terry Pratchett' }] },
            { title: 'Eric', language: 'english', formatType: 'unabridged', duration: 238, authors: [{ name: 'Terry Pratchett' }] },
            { title: 'Eric', language: 'spanish', formatType: 'unabridged', duration: 266, authors: [{ name: 'Terry Pratchett' }] },
            { title: 'Eric', language: 'german', formatType: 'unabridged', duration: 297, authors: [{ name: 'Terry Pratchett' }] },
          ],
        });

        const result = await serviceWithSettings.searchBooks('Eric Discworld Terry Pratchett', { title: 'Eric', author: 'Terry Pratchett' });
        expect(result).toEqual([
          { title: 'Eric', language: 'english', formatType: 'unabridged', duration: 238, authors: [{ name: 'Terry Pratchett' }] },
        ]);
      });

      it('searchBooks: Dark Forest fixture (only spanish result) returns empty after language filter', async () => {
        setLanguages(['english']);
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'El bosque oscuro [The Dark Forest]', language: 'spanish', duration: 1359, authors: [{ name: 'Cixin Liu' }] },
          ],
        });

        const result = await serviceWithSettings.searchBooks('The Dark Forest Cixin Liu');
        expect(result).toEqual([]);
      });
    });

    describe('symmetric fail-open (#1004)', () => {
      const mockSettingsService = { get: vi.fn(), getAll: vi.fn(), set: vi.fn() };
      let serviceWithSettings: MetadataService;

      beforeEach(() => {
        mockSettingsService.get.mockReset();
        serviceWithSettings = new MetadataService(inject<FastifyBaseLogger>(mockLog), undefined, mockSettingsService as never);
      });

      const stubMetadataFails = () => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: 'Virtual Voice', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'none', searchImmediately: false });
          if (key === 'metadata') return Promise.reject(new Error('DB unavailable'));
          return Promise.resolve({});
        });
      };

      const stubQualityFails = () => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.reject(new Error('DB unavailable'));
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: ['english'], minDurationMinutes: 30 });
          return Promise.resolve({});
        });
      };

      const fixture = () => [
        { title: 'Real', language: 'english', duration: 768, authors: [{ name: 'A' }], narrators: ['Jim Dale'] },
        { title: 'Spanish', language: 'spanish', duration: 768, authors: [{ name: 'A' }], narrators: ['Jim Dale'] },
        { title: 'Short', language: 'english', duration: 18, authors: [{ name: 'A' }], narrators: ['Jim Dale'] },
        { title: 'Knockoff', language: 'english', duration: 768, authors: [{ name: 'B' }], narrators: ['Virtual Voice'] },
      ];

      it('searchBooks: metadata-slice failure leaves rejectWords applied', async () => {
        stubMetadataFails();
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: fixture() });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result.map((b) => b.title)).toEqual(['Real', 'Spanish', 'Short']);
        expect(mockLog.warn).toHaveBeenCalled();
      });

      it('searchBooks: quality-slice failure leaves language + duration applied', async () => {
        stubQualityFails();
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: fixture() });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result.map((b) => b.title)).toEqual(['Real', 'Knockoff']);
        expect(mockLog.warn).toHaveBeenCalled();
      });

      it('searchBooksForDiscovery: metadata-slice failure leaves rejectWords applied', async () => {
        stubMetadataFails();
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: fixture() });

        const result = await serviceWithSettings.searchBooksForDiscovery('query');
        expect(result.books.map((b) => b.title)).toEqual(['Real', 'Spanish', 'Short']);
      });

      it('searchBooksForDiscovery: quality-slice failure leaves language + duration applied', async () => {
        stubQualityFails();
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: fixture() });

        const result = await serviceWithSettings.searchBooksForDiscovery('query');
        expect(result.books.map((b) => b.title)).toEqual(['Real', 'Knockoff']);
      });

      it('search: metadata-slice failure leaves rejectWords applied (books only)', async () => {
        stubMetadataFails();
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: fixture() });
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([]);

        const result = await serviceWithSettings.search('query');
        expect(result.books.map((b) => b.title)).toEqual(['Real', 'Spanish', 'Short']);
      });

      it('search: quality-slice failure leaves language + duration applied (books only)', async () => {
        stubQualityFails();
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: fixture() });
        mockAudibleProvider.searchSeries.mockResolvedValueOnce([]);

        const result = await serviceWithSettings.search('query');
        expect(result.books.map((b) => b.title)).toEqual(['Real', 'Knockoff']);
      });

      it('getAuthorBooks: metadata-slice failure leaves rejectWords applied (behavior diff vs old early-bail)', async () => {
        stubMetadataFails();
        mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'B123' });
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: fixture() });

        const result = await serviceWithSettings.getAuthorBooks('B123');
        expect(result.map((b) => b.title)).toEqual(['Real', 'Spanish', 'Short']);
        expect(mockLog.warn).toHaveBeenCalled();
      });

      it('getAuthorBooks: quality-slice failure leaves language + duration applied', async () => {
        stubQualityFails();
        mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'B123' });
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: fixture() });

        const result = await serviceWithSettings.getAuthorBooks('B123');
        expect(result.map((b) => b.title)).toEqual(['Real', 'Knockoff']);
      });
    });

    describe('min-duration filtering (#987)', () => {
      const mockSettingsService = { get: vi.fn(), getAll: vi.fn(), set: vi.fn() };
      let serviceWithSettings: MetadataService;

      const setMinDuration = (minDurationMinutes: number, rejectWords = '') => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords, requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'none', searchImmediately: false });
          if (key === 'metadata') return Promise.resolve({ audibleRegion: 'us', languages: [], minDurationMinutes });
          return Promise.resolve({});
        });
      };

      beforeEach(() => {
        mockSettingsService.get.mockReset();
        serviceWithSettings = new MetadataService(inject<FastifyBaseLogger>(mockLog), undefined, mockSettingsService as never);
      });

      it('searchBooks: filters books with duration below threshold and keeps null/undefined duration', async () => {
        setMinDuration(30);
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Knockoff', authors: [{ name: 'X' }], duration: 18 },
            { title: 'Real', authors: [{ name: 'X' }], duration: 768 },
            { title: 'Unknown', authors: [{ name: 'X' }] },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([
          { title: 'Real', authors: [{ name: 'X' }], duration: 768 },
          { title: 'Unknown', authors: [{ name: 'X' }] },
        ]);
      });

      it('searchBooks: returns all books when minDurationMinutes is 0 (filter disabled)', async () => {
        setMinDuration(0);
        const allBooks = [
          { title: 'Short', authors: [{ name: 'X' }], duration: 18 },
          { title: 'Long', authors: [{ name: 'X' }], duration: 768 },
          { title: 'Unknown', authors: [{ name: 'X' }] },
        ];
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: allBooks });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual(allBooks);
      });

      it('searchBooks: passes through duration exactly at threshold (>=)', async () => {
        setMinDuration(30);
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Just Below', authors: [{ name: 'X' }], duration: 29 },
            { title: 'At Threshold', authors: [{ name: 'X' }], duration: 30 },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([{ title: 'At Threshold', authors: [{ name: 'X' }], duration: 30 }]);
      });

      it('search(): derives authors/series only from duration-kept books (#1020)', async () => {
        setMinDuration(30);
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            {
              title: 'Knockoff',
              authors: [{ name: 'Knockoff Author' }],
              series: [{ name: 'Knockoff Series' }],
              duration: 18,
            },
            {
              title: 'Real',
              authors: [{ name: 'Real Author' }],
              series: [{ name: 'Real Series' }],
              duration: 768,
            },
            {
              title: 'Unknown',
              authors: [{ name: 'Unknown Author' }],
              series: [{ name: 'Unknown Series' }],
            },
          ],
        });

        const result = await serviceWithSettings.search('query');
        expect(result.books).toEqual([
          { title: 'Real', authors: [{ name: 'Real Author' }], series: [{ name: 'Real Series' }], duration: 768 },
          { title: 'Unknown', authors: [{ name: 'Unknown Author' }], series: [{ name: 'Unknown Series' }] },
        ]);
        expect(result.authors).toEqual([
          { name: 'Real Author' },
          { name: 'Unknown Author' },
        ]);
        expect(result.series).toEqual([
          { name: 'Real Series', books: [] },
          { name: 'Unknown Series', books: [] },
        ]);
      });

      it('searchBooksForDiscovery: applies the same min-duration filter', async () => {
        setMinDuration(30);
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Knockoff', authors: [{ name: 'X' }], duration: 18 },
            { title: 'Real', authors: [{ name: 'X' }], duration: 768 },
          ],
        });

        const result = await serviceWithSettings.searchBooksForDiscovery('Author');
        expect(result.books).toEqual([{ title: 'Real', authors: [{ name: 'X' }], duration: 768 }]);
      });

      it('getBook: does NOT apply min-duration filter (direct ASIN lookup is authoritative)', async () => {
        setMinDuration(30);
        mockAudibleProvider.getBook.mockResolvedValueOnce({ title: 'Short Book', duration: 18 });

        const result = await serviceWithSettings.getBook('B000SHORT');
        expect(result).toEqual({ title: 'Short Book', duration: 18 });
      });

      it('enrichBook: does NOT apply min-duration filter (direct ASIN lookup is authoritative)', async () => {
        setMinDuration(30);
        mockAudnexus.getBook.mockResolvedValueOnce({ title: 'Short Book', duration: 18 });

        const result = await serviceWithSettings.enrichBook('B000SHORT');
        expect(result).toEqual({ title: 'Short Book', duration: 18 });
      });

      it('stacks with rejectWords: a book hit by both filters is dropped exactly once', async () => {
        setMinDuration(30, 'Virtual Voice');
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Real', authors: [{ name: 'X' }], duration: 768 },
            { title: 'Knockoff', authors: [{ name: 'X' }], narrators: ['Virtual Voice'], duration: 18 },
          ],
        });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual([{ title: 'Real', authors: [{ name: 'X' }], duration: 768 }]);
      });

      it('returns unfiltered results when settings lookup throws (fail-open)', async () => {
        mockSettingsService.get.mockImplementation((key: string) => {
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'none', searchImmediately: false });
          if (key === 'metadata') return Promise.reject(new Error('DB unavailable'));
          return Promise.resolve({});
        });
        const allBooks = [
          { title: 'Short', authors: [{ name: 'X' }], duration: 18 },
          { title: 'Long', authors: [{ name: 'X' }], duration: 768 },
        ];
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: allBooks });

        const result = await serviceWithSettings.searchBooks('query');
        expect(result).toEqual(allBooks);
        expect(mockLog.warn).toHaveBeenCalled();
      });

      it('returns unfiltered results when no SettingsService injected', async () => {
        const allBooks = [{ title: 'Short', authors: [{ name: 'X' }], duration: 18 }];
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: allBooks });

        const result = await service.searchBooks('query');
        expect(result).toEqual(allBooks);
      });

      it('getAuthorBooks (filterAuthorBooks) applies the same min-duration filter', async () => {
        setMinDuration(30);
        mockAudnexus.getAuthor.mockResolvedValueOnce({ name: 'Author', asin: 'B123' });
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Knockoff', authors: [{ name: 'X' }], duration: 18 },
            { title: 'Real', authors: [{ name: 'X' }], duration: 768 },
          ],
        });

        const result = await serviceWithSettings.getAuthorBooks('B123');
        expect(result).toEqual([{ title: 'Real', authors: [{ name: 'X' }], duration: 768 }]);
      });
    });

    describe('podcast filtering (#1013)', () => {
      it('drops books with contentDeliveryType === "PodcastParent"', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'The Last Hero', authors: [{ name: 'Terry Pratchett' }], contentDeliveryType: 'SinglePartBook' },
            { title: 'Discworld 27 - The Last Hero', authors: [{ name: 'Terry Pratchett' }], contentDeliveryType: 'PodcastParent' },
          ],
        });

        const result = await service.searchBooks('The Last Hero');
        expect(result).toEqual([
          { title: 'The Last Hero', authors: [{ name: 'Terry Pratchett' }], contentDeliveryType: 'SinglePartBook' },
        ]);
      });

      it('drops books with contentDeliveryType === "Periodical"', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Real Book', authors: [{ name: 'X' }], contentDeliveryType: 'MultiPartBook' },
            { title: 'Old Magazine', authors: [{ name: 'X' }], contentDeliveryType: 'Periodical' },
          ],
        });

        const result = await service.searchBooks('query');
        expect(result).toEqual([
          { title: 'Real Book', authors: [{ name: 'X' }], contentDeliveryType: 'MultiPartBook' },
        ]);
      });

      it('keeps books with contentDeliveryType === undefined (fallback-to-keep)', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Audnexus-Origin Book', authors: [{ name: 'X' }] },
            { title: 'Older Audible Record', authors: [{ name: 'X' }] },
          ],
        });

        const result = await service.searchBooks('query');
        expect(result).toEqual([
          { title: 'Audnexus-Origin Book', authors: [{ name: 'X' }] },
          { title: 'Older Audible Record', authors: [{ name: 'X' }] },
        ]);
      });

      it('keeps books with unrecognized contentDeliveryType (blacklist semantics, not whitelist)', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Box Set', authors: [{ name: 'X' }], contentDeliveryType: 'MultiPartBookCollection' },
            { title: 'Future Variant', authors: [{ name: 'X' }], contentDeliveryType: 'SomeNewShape' },
          ],
        });

        const result = await service.searchBooks('query');
        expect(result).toEqual([
          { title: 'Box Set', authors: [{ name: 'X' }], contentDeliveryType: 'MultiPartBookCollection' },
          { title: 'Future Variant', authors: [{ name: 'X' }], contentDeliveryType: 'SomeNewShape' },
        ]);
      });

      it('logs a debug entry with title + contentDeliveryType when dropping a podcast', async () => {
        mockAudibleProvider.searchBooks.mockResolvedValueOnce({
          books: [
            { title: 'Discworld 27 - The Last Hero', authors: [{ name: 'Terry Pratchett' }], contentDeliveryType: 'PodcastParent' },
          ],
        });

        await service.searchBooks('The Last Hero');
        expect(mockLog.debug).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Discworld 27 - The Last Hero',
            contentDeliveryType: 'PodcastParent',
          }),
          expect.stringContaining('Dropping non-audiobook'),
        );
      });
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

    it('returns null when contentDeliveryType is PodcastParent', async () => {
      mockAudibleProvider.getBook.mockResolvedValueOnce({
        title: 'A Podcast',
        contentDeliveryType: 'PodcastParent',
      });

      const result = await service.getBook('B000PODCAST');
      expect(result).toBeNull();
    });

    it('returns null when contentDeliveryType is Periodical', async () => {
      mockAudibleProvider.getBook.mockResolvedValueOnce({
        title: 'A Magazine',
        contentDeliveryType: 'Periodical',
      });

      const result = await service.getBook('B000MAG');
      expect(result).toBeNull();
    });

    it('returns book when contentDeliveryType is SinglePartBook', async () => {
      const mockBook = { title: 'A Real Book', contentDeliveryType: 'SinglePartBook' };
      mockAudibleProvider.getBook.mockResolvedValueOnce(mockBook);

      const result = await service.getBook('B000BOOK');
      expect(result).toEqual(mockBook);
    });

    it('returns book when contentDeliveryType is undefined (fallback-to-keep)', async () => {
      const mockBook = { title: 'Legacy Book' };
      mockAudibleProvider.getBook.mockResolvedValueOnce(mockBook);

      const result = await service.getBook('B000LEGACY');
      expect(result).toEqual(mockBook);
    });

    it('returns book when contentDeliveryType is an unknown variant (blacklist semantics)', async () => {
      const mockBook = { title: 'Future Book', contentDeliveryType: 'MultiPartBookCollection' };
      mockAudibleProvider.getBook.mockResolvedValueOnce(mockBook);

      const result = await service.getBook('B000FUTURE');
      expect(result).toEqual(mockBook);
    });

    it('logs at debug level with { id, title, contentDeliveryType } when dropping a podcast', async () => {
      mockAudibleProvider.getBook.mockResolvedValueOnce({
        title: 'A Podcast',
        contentDeliveryType: 'PodcastParent',
      });

      await service.getBook('B000PODCAST');

      const debugSpy = mockLog.debug as ReturnType<typeof vi.fn>;
      const dropCalls = debugSpy.mock.calls.filter(
        ([, msg]) => msg === 'Direct lookup dropped — non-audiobook content type',
      );
      expect(dropCalls).toHaveLength(1);
      expect(dropCalls[0]?.[0]).toEqual({
        id: 'B000PODCAST',
        title: 'A Podcast',
        contentDeliveryType: 'PodcastParent',
      });
      // Keep direct-lookup and search-path messages distinct for log-grep.
      const searchPathCalls = debugSpy.mock.calls.filter(
        ([, msg]) => msg === 'Dropping non-audiobook from search results',
      );
      expect(searchPathCalls).toHaveLength(0);
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

      const mockAuthor = { name: 'Test Author', asin: '123' };
      mockAudnexus.getAuthor.mockResolvedValueOnce(mockAuthor);
      expect(await service.getAuthor('123')).toEqual(mockAuthor);
      expect(mockAudnexus.getAuthor).toHaveBeenCalledWith('123');
    });

    it('throws during the Audnexus backoff window (rate-limit state stays distinct from a miss)', async () => {
      mockAudnexus.getBook.mockRejectedValueOnce(new RateLimitError(60000, 'Audnexus'));
      await expect(service.enrichBook('B000FIRST')).rejects.toThrow(RateLimitError);

      await expect(service.enrichBook('B000SECOND')).rejects.toThrow(RateLimitError);
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
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false });
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
          if (key === 'quality') return Promise.resolve({ rejectWords: 'dramatized', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false });
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
          if (key === 'quality') return Promise.resolve({ rejectWords: 'full-cast', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false });
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
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false });
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
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false });
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
          if (key === 'quality') return Promise.resolve({ rejectWords: '', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false });
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
          if (key === 'quality') return Promise.resolve({ rejectWords: 'dramatized', requiredWords: '', grabFloor: 0, minSeeders: 1, protocolPreference: 'any', searchImmediately: false });
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
      expect(mockAudibleProvider.getBook).not.toHaveBeenCalled();
    });
  });

  describe('no API keys', () => {
    it('still has Audible provider when no API keys are set', async () => {
      const minService = new MetadataService(inject<FastifyBaseLogger>(createMockLogger()));

      expect(minService.getProviders()).toHaveLength(1);
      expect(minService.getProviders()[0]!.type).toBe('audible');
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
        expect.objectContaining({ query: 'B000TEST', error: expect.objectContaining({ message: 'Audible.com transient failure: HTTP 500 Internal Server Error', type: 'TransientError' }) }),
        'Metadata getBook failed',
      );
    });

    it('getAuthor(): Audnexus TransientError returns null and logs warning', async () => {
      const transientErr = new TransientError('Audnexus', 'HTTP 503 Service Unavailable');
      mockAudnexus.getAuthor.mockRejectedValueOnce(transientErr);

      const result = await service.getAuthor('B001TEST');
      expect(result).toBeNull();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: transientErr.message, type: 'TransientError' }) }),
        'Audnexus getAuthor failed',
      );
    });

    it('getAuthor(): Audnexus RateLimitError returns null and sets rate limit', async () => {
      mockAudnexus.getAuthor.mockRejectedValueOnce(new RateLimitError(30000, 'Audnexus'));

      const result = await service.getAuthor('B001TEST');
      expect(result).toBeNull();

      const result2 = await service.getAuthor('B002TEST');
      expect(result2).toBeNull();
      expect(mockAudnexus.getAuthor).toHaveBeenCalledTimes(1);
      // A non-finite window serializes as null; this log must expose the finite retry interval.
      expect(mockLog.warn).toHaveBeenCalledWith(
        { provider: 'Audnexus', retryAfterMs: 30000 },
        'Provider rate limited',
      );
    });

    it('enrichBook(): Audnexus TransientError returns null and logs warning', async () => {
      const transientErr = new TransientError('Audnexus', 'Connection timed out');
      mockAudnexus.getBook.mockRejectedValueOnce(transientErr);

      const result = await service.enrichBook('B000TEST');
      expect(result).toBeNull();
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'Audnexus transient failure: Connection timed out', type: 'TransientError' }), asin: 'B000TEST' }),
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
      const saved = { ...mockFactories };
      for (const key of Object.keys(mockFactories)) {
        delete (mockFactories as Record<string, unknown>)[key];
      }
      emptyService = new MetadataService(inject<FastifyBaseLogger>(createMockLogger()));
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

  describe('Audnexus provider region threading (#1088)', () => {
    it('constructs AudnexusProvider with the resolved region', async () => {
      const { AudnexusProvider } = await import('@core/index.js');
      const audnexusCtor = vi.mocked(AudnexusProvider);
      audnexusCtor.mockClear();

      new MetadataService(inject<FastifyBaseLogger>(createMockLogger()), { audibleRegion: 'uk' });

      expect(audnexusCtor).toHaveBeenCalledWith({ region: 'uk' });
    });
  });

  // Use the real service to exercise its shared throttle and provider-wide Audnexus backoff.
  describe('getChapterRuntimeSeconds bridge (#1942/#2168)', () => {
    const ASIN = 'B00CXXEX8W';
    // Fablehaven's live fixture has no trimmable tail, so full and trimmed totals match.
    const FABLEHAVEN_OK = { kind: 'ok', runtimeLengthMs: 33219490, isAccurate: true, trimmedRuntimeMs: 33219490, trimmedChapterCount: 0 } as const;
    // No usable runtime is {}, never undefined.
    const NONE = {};

    it('#2168 — a trimmed record bridges BOTH references through in SECONDS', async () => {
      mockAudnexus.getChapterRuntime.mockResolvedValue({
        kind: 'ok', runtimeLengthMs: 86_400_000, isAccurate: true, trimmedRuntimeMs: 85_134_000, trimmedChapterCount: 1,
      });

      await expect(service.getChapterRuntimeSeconds(ASIN)).resolves.toEqual({ fullSeconds: 86_400, trimmedSeconds: 85_134 });
    });

    it('returns the trusted chapter runtime in SECONDS', async () => {
      mockAudnexus.getChapterRuntime.mockResolvedValue(FABLEHAVEN_OK);

      await expect(service.getChapterRuntimeSeconds(ASIN)).resolves.toEqual({ fullSeconds: 33219.49, trimmedSeconds: 33219.49 });
      expect(mockAudnexus.getChapterRuntime).toHaveBeenCalledExactlyOnceWith(ASIN);
    });

    it('a returned 429 sets the shared backoff, so the IMMEDIATELY subsequent Audnexus call short-circuits', async () => {
      mockAudnexus.getChapterRuntime.mockResolvedValue({ kind: 'rate_limited', retryAfterMs: 60_000 });

      await expect(service.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
      expect(mockLog.warn).toHaveBeenCalledWith(
        { provider: 'Audnexus', retryAfterMs: 60_000 },
        'Provider rate limited',
      );

      // Backoff is provider-wide, not per method or ASIN.
      await expect(service.getAuthor('B001H6UJO8')).resolves.toBeNull();
      expect(mockAudnexus.getAuthor).not.toHaveBeenCalled();
      await service.getChapterRuntimeSeconds('B_OTHER');
      expect(mockAudnexus.getChapterRuntime).toHaveBeenCalledTimes(1);
    });

    it('the backoff window is FINITE — a NaN window would make the gate a silent no-op (F16)', async () => {
      mockAudnexus.getChapterRuntime.mockResolvedValue({ kind: 'rate_limited', retryAfterMs: Number.NaN });

      await service.getChapterRuntimeSeconds(ASIN);

      // Date.now() + NaN disables the gate, so a bad adapter window causes an immediate retry.
      await service.getChapterRuntimeSeconds('B_OTHER');
      expect(mockAudnexus.getChapterRuntime).toHaveBeenCalledTimes(2);
    });

    // Fake only Date: real timers stay live while the exact deadline remains deterministic.
    describe('backoff window expiry, frozen clock', () => {
      const NOW = Date.parse('2026-07-25T12:00:00.000Z');

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
      });
      afterEach(() => { vi.useRealTimers(); });

      it('holds the gate up to the last millisecond of the window, then retries and promotes', async () => {
        mockAudnexus.getChapterRuntime.mockResolvedValueOnce({ kind: 'rate_limited', retryAfterMs: 60_000 });
        await expect(service.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
        expect(mockAudnexus.getChapterRuntime).toHaveBeenCalledTimes(1);

        vi.setSystemTime(NOW + 59_999);
        await expect(service.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
        expect(mockAudnexus.getChapterRuntime).toHaveBeenCalledTimes(1);

        vi.setSystemTime(NOW + 60_000);
        mockAudnexus.getChapterRuntime.mockResolvedValue(FABLEHAVEN_OK);
        await expect(service.getChapterRuntimeSeconds(ASIN)).resolves.toEqual({ fullSeconds: 33219.49, trimmedSeconds: 33219.49 });
        expect(mockAudnexus.getChapterRuntime).toHaveBeenCalledTimes(2);

        await expect(service.getChapterRuntimeSeconds(ASIN)).resolves.toEqual({ fullSeconds: 33219.49, trimmedSeconds: 33219.49 });
        expect(mockAudnexus.getChapterRuntime).toHaveBeenCalledTimes(2);
      });

      it('a rate-limited lookup leaves no cache entry, so the post-window retry is a real request', async () => {
        mockAudnexus.getChapterRuntime.mockResolvedValueOnce({ kind: 'rate_limited', retryAfterMs: 60_000 });
        await service.getChapterRuntimeSeconds(ASIN);

        vi.setSystemTime(NOW + 60_000);
        mockAudnexus.getChapterRuntime.mockResolvedValue({ kind: 'not_found' });

        await expect(service.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
        expect(mockAudnexus.getChapterRuntime.mock.calls).toEqual([[ASIN], [ASIN]]);
      });
    });

    it('an active backoff from ANOTHER path skips the chapter lookup entirely', async () => {
      mockAudnexus.getBook.mockRejectedValue(new RateLimitError(60_000, 'Audnexus'));
      await expect(service.enrichBook(ASIN)).rejects.toBeInstanceOf(RateLimitError);

      await expect(service.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
      expect(mockAudnexus.getChapterRuntime).not.toHaveBeenCalled();
    });

    it('never throws — a provider that rejects degrades to "no usable runtime"', async () => {
      mockAudnexus.getChapterRuntime.mockRejectedValue(new Error('boom'));

      await expect(service.getChapterRuntimeSeconds(ASIN)).resolves.toEqual(NONE);
    });

    it('cache state is per-service-instance, so a second service performs its own lookup (F14)', async () => {
      mockAudnexus.getChapterRuntime.mockResolvedValue(FABLEHAVEN_OK);
      await service.getChapterRuntimeSeconds(ASIN);
      await service.getChapterRuntimeSeconds(ASIN);
      expect(mockAudnexus.getChapterRuntime).toHaveBeenCalledTimes(1);

      const other = new MetadataService(inject<FastifyBaseLogger>(createMockLogger()), { audibleRegion: 'uk' });
      await other.getChapterRuntimeSeconds(ASIN);

      expect(mockAudnexus.getChapterRuntime).toHaveBeenCalledTimes(2);
    });
  });

  describe('lookupForFixMatch (#1129)', () => {
    const audibleBook = {
      asin: 'B_NEW',
      title: 'New Title',
      authors: [{ name: 'Author' }],
      narrators: ['Narrator 1'],
      description: 'desc',
      coverUrl: 'https://example.com/cover.jpg',
      duration: 600,
      publishedDate: '2024-01-01',
      series: [{ name: 'Series', position: 2 }],
    };
    const audnexusBook = {
      asin: 'B_NEW',
      title: 'New Title (Audnexus)',
      authors: [{ name: 'Author' }],
      narrators: ['Narrator 1', 'Narrator 2'],
      seriesPrimary: { name: 'Series', position: 2, asin: 'SERIES_ID' },
      genres: ['Fantasy'],
      isbn: '9781234567890',
    };

    it('both providers ok → merged record with Audnexus seriesPrimary/genres/isbn/richer narrators', async () => {
      mockAudibleProvider.getBookDetailed.mockResolvedValueOnce({ kind: 'ok', book: audibleBook });
      mockAudnexus.getBookDetailed.mockResolvedValueOnce({ kind: 'ok', book: audnexusBook });

      const result = await service.lookupForFixMatch('B_NEW');
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.book.title).toBe('New Title'); // Audible remains authoritative.
        expect(result.book.seriesPrimary?.asin).toBe('SERIES_ID');
        expect(result.book.genres).toEqual(['Fantasy']);
        expect(result.book.isbn).toBe('9781234567890');
        expect(result.book.narrators).toEqual(['Narrator 1', 'Narrator 2']);
      }
    });

    it('Audible not_found → propagates verbatim', async () => {
      mockAudibleProvider.getBookDetailed.mockResolvedValueOnce({ kind: 'not_found' });
      const result = await service.lookupForFixMatch('B_NEW');
      expect(result.kind).toBe('not_found');
      expect(mockAudnexus.getBookDetailed).not.toHaveBeenCalled();
    });

    it('Audible rate_limited → sets backoff and propagates retryAfterMs', async () => {
      mockAudibleProvider.getBookDetailed.mockResolvedValueOnce({ kind: 'rate_limited', retryAfterMs: 5_000 });
      const result = await service.lookupForFixMatch('B_NEW');
      expect(result.kind).toBe('rate_limited');
      if (result.kind === 'rate_limited') {
        expect(result.retryAfterMs).toBe(5_000);
      }
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'Audible.com', retryAfterMs: 5_000 }),
        'Provider rate limited',
      );
      expect(mockAudnexus.getBookDetailed).not.toHaveBeenCalled();
    });

    it('Audible invalid_record (mapped or raw) → propagates as invalid_record', async () => {
      mockAudibleProvider.getBookDetailed.mockResolvedValueOnce({ kind: 'invalid_record', source: 'mapped' });
      const r1 = await service.lookupForFixMatch('B1');
      expect(r1.kind).toBe('invalid_record');

      mockAudibleProvider.getBookDetailed.mockResolvedValueOnce({ kind: 'invalid_record', source: 'raw' });
      const r2 = await service.lookupForFixMatch('B2');
      expect(r2.kind).toBe('invalid_record');
    });

    it('Audible transient_failure → propagates message', async () => {
      mockAudibleProvider.getBookDetailed.mockResolvedValueOnce({ kind: 'transient_failure', message: 'HTTP 500' });
      const result = await service.lookupForFixMatch('B_NEW');
      expect(result.kind).toBe('transient_failure');
      if (result.kind === 'transient_failure') {
        expect(result.message).toBe('HTTP 500');
      }
    });

    it('Audible ok + Audnexus rate_limited → ok, sets Audnexus backoff, WARN logged', async () => {
      mockAudibleProvider.getBookDetailed.mockResolvedValueOnce({ kind: 'ok', book: audibleBook });
      mockAudnexus.getBookDetailed.mockResolvedValueOnce({ kind: 'rate_limited', retryAfterMs: 10_000 });

      const result = await service.lookupForFixMatch('B_NEW');
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.book.genres).toBeUndefined();
        expect(result.book.isbn).toBeUndefined();
      }
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'Audnexus', retryAfterMs: 10_000 }),
        'Provider rate limited',
      );
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ asin: 'B_NEW', audnexusKind: 'rate_limited' }),
        expect.stringContaining('Audnexus failed'),
      );
    });

    it('Audible ok + Audnexus transient_failure → ok with Audible-only fields, WARN logged', async () => {
      mockAudibleProvider.getBookDetailed.mockResolvedValueOnce({ kind: 'ok', book: audibleBook });
      mockAudnexus.getBookDetailed.mockResolvedValueOnce({ kind: 'transient_failure', message: 'HTTP 503' });

      const result = await service.lookupForFixMatch('B_NEW');
      expect(result.kind).toBe('ok');
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ asin: 'B_NEW', audnexusKind: 'transient_failure' }),
        expect.stringContaining('Audnexus failed'),
      );
    });

    it('Audible ok + Audnexus not_found → ok with Audible-only fields', async () => {
      mockAudibleProvider.getBookDetailed.mockResolvedValueOnce({ kind: 'ok', book: audibleBook });
      mockAudnexus.getBookDetailed.mockResolvedValueOnce({ kind: 'not_found' });

      const result = await service.lookupForFixMatch('B_NEW');
      expect(result.kind).toBe('ok');
    });

    it('Audible ok + Audnexus invalid_record → ok with Audible-only fields', async () => {
      mockAudibleProvider.getBookDetailed.mockResolvedValueOnce({ kind: 'ok', book: audibleBook });
      mockAudnexus.getBookDetailed.mockResolvedValueOnce({ kind: 'invalid_record', source: 'mapped' });

      const result = await service.lookupForFixMatch('B_NEW');
      expect(result.kind).toBe('ok');
    });
  });
});

describe('isRejectedByWords (shared predicate)', () => {
  const book = (overrides?: Partial<BookMetadata>): BookMetadata =>
    ({ title: 'Clean Title', authors: [{ name: 'Real Author' }], ...overrides }) as BookMetadata;

  it('returns false when rejectWords is empty', () => {
    expect(isRejectedByWords(book(), '')).toBe(false);
  });

  it('rejects on a title match', () => {
    expect(isRejectedByWords(book({ title: 'Free Excerpt — Chapter 1' }), 'Free Excerpt')).toBe(true);
  });

  it('rejects on a subtitle-only match', () => {
    expect(isRejectedByWords(book({ subtitle: 'A Sample for the audiobook' }), 'Sample')).toBe(true);
  });

  it('rejects on an author-name match', () => {
    expect(isRejectedByWords(book({ authors: [{ name: 'Amy McMahon' }] }), 'Amy McMahon')).toBe(true);
  });

  it('rejects on a narrator-only match', () => {
    expect(isRejectedByWords(book({ narrators: ['Virtual Voice'] }), 'Virtual Voice')).toBe(true);
  });

  it('rejects on a formatType-only match (word boundary: unabridged survives)', () => {
    expect(isRejectedByWords(book({ formatType: 'abridged' }), 'Abridged')).toBe(true);
    expect(isRejectedByWords(book({ formatType: 'unabridged' }), 'Abridged')).toBe(false);
  });

  it('does NOT reject when the word matches only a pseudo-narrator (stripped from surface)', () => {
    expect(isRejectedByWords(book({ narrators: ['full cast'] }), 'Full Cast')).toBe(false);
    expect(isRejectedByWords(book({ narrators: ['GraphicAudio Full Cast'] }), 'Full Cast')).toBe(true);
  });

  it('agrees with the search filter: searchBooks keeps exactly the books the predicate does not reject', async () => {
    const REJECT = 'Virtual Voice';
    const fixtures: BookMetadata[] = [
      book({ title: 'Real Book', narrators: ['Jim Dale'] }),
      book({ title: 'Fake Knockoff', authors: [{ name: 'Spammer' }], narrators: ['Virtual Voice'] }),
      book({ title: 'Clean Sequel', narrators: ['Kate Reading'] }),
    ];
    const mockSettings = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === 'quality') return Promise.resolve({ rejectWords: REJECT });
        if (key === 'metadata') return Promise.resolve({ languages: [], minDurationMinutes: 0 });
        return Promise.resolve({});
      }),
    };
    const svc = new MetadataService(inject<FastifyBaseLogger>(createMockLogger()), undefined, mockSettings as never);
    mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: fixtures });

    const kept = await svc.searchBooks('query');

    const expectedKept = fixtures.filter((b) => !isRejectedByWords(b, REJECT));
    expect(kept).toEqual(expectedKept);
    expect(kept).toHaveLength(2);
  });
});

describe('MetadataService.resolveBook', () => {
  let service: MetadataService;
  let mockLog: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAudibleProvider.searchBooks.mockReset().mockResolvedValue({ books: [] });
    mockAudnexus.getBook.mockReset().mockResolvedValue(null);
    mockLog = createMockLogger();
    service = new MetadataService(inject<FastifyBaseLogger>(mockLog));
  });

  const audiobook: BookMetadata = {
    asin: 'B0AUDIO', title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }],
    narrators: ['Michael Kramer'], duration: 2700,
  };

  it('ASIN resolves via enrichBook → returns the ASIN match; search NOT called', async () => {
    mockAudnexus.getBook.mockResolvedValueOnce(audiobook);

    const result = await service.resolveBook({ asin: 'B0AUDIO', title: 'The Way of Kings', author: 'Brandon Sanderson' });

    expect(result).toEqual(audiobook);
    expect(mockAudnexus.getBook).toHaveBeenCalledWith('B0AUDIO');
    expect(mockAudibleProvider.searchBooks).not.toHaveBeenCalled();
  });

  it('ASIN present but enrichBook returns null → falls back to search → returns validated candidate', async () => {
    mockAudnexus.getBook.mockResolvedValueOnce(null);
    mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [audiobook] });

    const result = await service.resolveBook({ asin: '1338589016', title: 'The Way of Kings', author: 'Brandon Sanderson' });

    expect(result).toEqual(audiobook);
    expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('The Way of Kings Brandon Sanderson');
  });

  it('no ASIN → search → returns validated candidate', async () => {
    mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [audiobook] });

    const result = await service.resolveBook({ title: 'The Way of Kings', author: 'Brandon Sanderson' });

    expect(result).toEqual(audiobook);
    expect(mockAudnexus.getBook).not.toHaveBeenCalled();
  });

  it("empty-string and whitespace ASINs are treated as absent → straight to search (enrichBook NOT called)", async () => {
    mockAudibleProvider.searchBooks.mockResolvedValue({ books: [audiobook] });

    await service.resolveBook({ asin: '', title: 'The Way of Kings', author: 'Brandon Sanderson' });
    await service.resolveBook({ asin: '   ', title: 'The Way of Kings', author: 'Brandon Sanderson' });

    expect(mockAudnexus.getBook).not.toHaveBeenCalled();
    expect(mockAudibleProvider.searchBooks).toHaveBeenCalledTimes(2);
  });

  it('ASIN miss + search miss → null', async () => {
    mockAudnexus.getBook.mockResolvedValueOnce(null);
    mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [] });

    const result = await service.resolveBook({ asin: 'B_DEAD', title: 'Obscure', author: 'Nobody' });
    expect(result).toBeNull();
  });

  it('ASIN miss + non-matching top candidate → validation rejects → null', async () => {
    mockAudnexus.getBook.mockResolvedValueOnce(null);
    mockAudibleProvider.searchBooks.mockResolvedValueOnce({
      books: [{ title: 'The Way of Kings', authors: [{ name: 'Some Romance Author' }], asin: 'B_WRONG' }],
    });

    const result = await service.resolveBook({ asin: 'B_DEAD', title: 'The Way of Kings', author: 'Brandon Sanderson' });
    expect(result).toBeNull();
  });

  it('author absent → query is built from title alone (no literal "undefined" appended)', async () => {
    mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [{ title: 'Standalone', authors: [{ name: 'X' }] }] });

    await service.resolveBook({ title: 'Standalone' });

    expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('Standalone');
  });

  it('#1629: validates beyond books[0] — a later candidate is returned when the top one fails', async () => {
    // Filters preserve provider order, so resolution must scan a top-N window rather than trust books[0].
    mockAudibleProvider.searchBooks.mockResolvedValueOnce({
      books: [
        { title: 'The Way of Kings', authors: [{ name: 'Some Romance Author' }], asin: 'B_WRONG' },
        audiobook,
      ],
    });

    const result = await service.resolveBook({ title: 'The Way of Kings', author: 'Brandon Sanderson' });
    expect(result).toEqual(audiobook);
  });

  it('#1629: whitespace-only author is normalized to absent — title-only query, no junk appended', async () => {
    mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [audiobook] });

    const result = await service.resolveBook({ title: 'The Way of Kings', author: '   ' });

    expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('The Way of Kings');
    expect(result).toEqual(audiobook);
  });

  it('#1629: a 0.70–0.84 title-only match is rejected → null (no fuzzy ASIN to write back)', async () => {
    // Dice is about 0.83: above the general 0.70 gate but below the no-author 0.85 gate.
    mockAudibleProvider.searchBooks.mockResolvedValueOnce({
      books: [{ title: 'The Last Hero', authors: [{ name: 'Whoever' }], asin: 'B_FUZZY' }],
    });

    const result = await service.resolveBook({ title: 'The Lost Hero' });
    expect(result).toBeNull();
  });

  it('provider RateLimitError on the enrichBook path → re-throws (NOT swallowed to null)', async () => {
    mockAudnexus.getBook.mockRejectedValueOnce(new RateLimitError(30000, 'Audnexus'));

    await expect(
      service.resolveBook({ asin: 'B0AUDIO', title: 'The Way of Kings', author: 'Brandon Sanderson' }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('F1/B5: ASIN path propagates the rate limit even when Audnexus is ALREADY in backoff (not treated as a miss)', async () => {
    mockAudnexus.getBook.mockRejectedValueOnce(new RateLimitError(60000, 'Audnexus'));
    await expect(
      service.resolveBook({ asin: 'B0AUDIO', title: 'The Way of Kings', author: 'Brandon Sanderson' }),
    ).rejects.toBeInstanceOf(RateLimitError);

    // Active backoff must throw before either provider runs; it is not an ASIN miss.
    mockAudnexus.getBook.mockClear();
    mockAudibleProvider.searchBooks.mockClear();
    await expect(
      service.resolveBook({ asin: 'B0AUDIO2', title: 'Words of Radiance', author: 'Brandon Sanderson' }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(mockAudnexus.getBook).not.toHaveBeenCalled();
    expect(mockAudibleProvider.searchBooks).not.toHaveBeenCalled();
  });

  it('F5: provider RateLimitError on the FALLBACK SEARCH path → re-throws (NOT swallowed to [] / null)', async () => {
    mockAudnexus.getBook.mockResolvedValueOnce(null);
    mockAudibleProvider.searchBooks.mockRejectedValueOnce(new RateLimitError(30000, 'Audible.com'));

    await expect(
      service.resolveBook({ asin: 'B_DEAD', title: 'The Way of Kings', author: 'Brandon Sanderson' }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('the public search() still swallows a search rate limit to [] (resolver does not change discovery behavior)', async () => {
    mockAudibleProvider.searchBooks.mockRejectedValueOnce(new RateLimitError(30000, 'Audible.com'));
    const result = await service.search('The Way of Kings');
    expect(result.books).toEqual([]);
  });

  it('#1628: provider TransientError on the FALLBACK SEARCH path → re-throws (NOT swallowed to [] / null)', async () => {
    mockAudnexus.getBook.mockResolvedValueOnce(null);
    mockAudibleProvider.searchBooks.mockRejectedValueOnce(new TransientError('Audible.com', 'HTTP 503'));

    // Propagation lets callers keep the book pending instead of recording a no-match.
    await expect(
      service.resolveBook({ asin: 'B_DEAD', title: 'The Way of Kings', author: 'Brandon Sanderson' }),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it('#1628: a generic Error on the FALLBACK SEARCH path → re-throws (any caught fallback error is transient)', async () => {
    mockAudnexus.getBook.mockResolvedValueOnce(null);
    mockAudibleProvider.searchBooks.mockRejectedValueOnce(new Error('Network error'));

    await expect(
      service.resolveBook({ asin: 'B_DEAD', title: 'The Way of Kings', author: 'Brandon Sanderson' }),
    ).rejects.toThrow('Network error');
  });

  it('#1628: an empty fallback search result is still a no-match → null (NOT a throw)', async () => {
    mockAudnexus.getBook.mockResolvedValueOnce(null);
    mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books: [] });

    const result = await service.resolveBook({ asin: 'B_DEAD', title: 'Obscure', author: 'Nobody' });
    expect(result).toBeNull();
  });

  it('#1628: a fallback RateLimitError records the backoff (setRateLimited) so a later resolve is pre-empted', async () => {
    mockAudnexus.getBook.mockResolvedValue(null);
    mockAudibleProvider.searchBooks.mockRejectedValueOnce(new RateLimitError(60000, 'Audible.com'));

    await expect(
      service.resolveBook({ asin: 'B_DEAD', title: 'The Way of Kings', author: 'Brandon Sanderson' }),
    ).rejects.toBeInstanceOf(RateLimitError);

    mockAudibleProvider.searchBooks.mockClear();
    await expect(
      service.resolveBook({ title: 'Words of Radiance', author: 'Brandon Sanderson' }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(mockAudibleProvider.searchBooks).not.toHaveBeenCalled();
  });
});

describe('MetadataService.resolveBook — ambiguous validation windows (#2202)', () => {
  // The unchanged arms (one passing, zero passing, empty result, #1629 books[1] recovery, and every
  // error-propagation case) are the pre-existing controls in the block above; they must stay green.
  let service: MetadataService;
  let mockLog: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks leaves *Once queues intact; window fixtures queue several, so reset outright.
    mockAudibleProvider.searchBooks.mockReset().mockResolvedValue({ books: [] });
    mockAudnexus.getBook.mockReset().mockResolvedValue(null);
    mockLog = createMockLogger();
    service = new MetadataService(inject<FastifyBaseLogger>(mockLog));
  });

  function candidate(title: string, author: string, overrides: Partial<BookMetadata> = {}): BookMetadata {
    return { title, authors: [{ name: author }], ...overrides };
  }

  function window(...books: BookMetadata[]): void {
    mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books });
  }

  function holdLogCalls(): unknown[][] {
    return (mockLog.info as Mock).mock.calls.filter((call) => call[1] === AMBIGUOUS_WINDOW_HELD);
  }

  const HERBERT = 'Frank Herbert';
  const COLFER = 'Eoin Colfer';

  describe('the hold (AC1, AC4)', () => {
    it('two distinct passing candidates and no exact-title match → null, not an arbitrary pick', async () => {
      window(
        candidate('Dune', HERBERT, { asin: 'B_DUNE' }),
        candidate('Dune Messiah', HERBERT, { asin: 'B_MESSIAH' }),
      );

      const result = await service.resolveBook({ title: 'Dune Chronicles Messiah', author: HERBERT });

      expect(result).toBeNull();
    });

    it('all five window entries passing with no exact-title match → null', async () => {
      window(
        ...['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((part, i) =>
          candidate(`Artemis Fowl Chronicles: ${part}`, COLFER, { asin: `B_${i}` })),
      );

      const result = await service.resolveBook({ title: 'Artemis Fowl Chronicles', author: COLFER });

      expect(result).toBeNull();
    });

    it('AC4: a sixth passing candidate is outside the window, so books[0] resolves instead of holding', async () => {
      window(
        candidate('Dune', HERBERT, { asin: 'B_DUNE' }),
        candidate('Mistborn', HERBERT, { asin: 'B_1' }),
        candidate('Elantris', HERBERT, { asin: 'B_2' }),
        candidate('Warbreaker', HERBERT, { asin: 'B_3' }),
        candidate('Skyward', HERBERT, { asin: 'B_4' }),
        candidate('Dune Messiah', HERBERT, { asin: 'B_MESSIAH' }),
      );

      const result = await service.resolveBook({ title: 'Dune Chronicles Messiah', author: HERBERT });

      expect(result).toEqual(candidate('Dune', HERBERT, { asin: 'B_DUNE' }));
      expect(holdLogCalls()).toHaveLength(0);
    });

    it('AC4 inverse: the two passing candidates sit at the window tail → null', async () => {
      window(
        candidate('Mistborn', HERBERT, { asin: 'B_1' }),
        candidate('Elantris', HERBERT, { asin: 'B_2' }),
        candidate('Warbreaker', HERBERT, { asin: 'B_3' }),
        candidate('Dune', HERBERT, { asin: 'B_DUNE' }),
        candidate('Dune Messiah', HERBERT, { asin: 'B_MESSIAH' }),
      );

      const result = await service.resolveBook({ title: 'Dune Chronicles Messiah', author: HERBERT });

      expect(result).toBeNull();
    });

    it('title-only path: two same-titled editions both clear 0.85 → null (the tie-break names two)', async () => {
      window(
        candidate('Leviathan Wakes', 'James S A Corey', { asin: 'B_ED1' }),
        candidate('Leviathan Wakes', 'James S A Corey', { asin: 'B_ED2' }),
      );

      expect(await service.resolveBook({ title: 'Leviathan Wakes' })).toBeNull();

      window(candidate('Leviathan Wakes', 'James S A Corey', { asin: 'B_ED1' }));

      expect(await service.resolveBook({ title: 'Leviathan Wakes' }))
        .toEqual(candidate('Leviathan Wakes', 'James S A Corey', { asin: 'B_ED1' }));
    });
  });

  describe('candidate identity (AC3)', () => {
    it.each([
      ['undefined + undefined', undefined, undefined],
      ['undefined + empty string', undefined, ''],
      ['empty string + whitespace', '', '   '],
    ])('canonical-null ASINs never collapse with each other: %s → null', async (_label, left, right) => {
      window(
        candidate('Dune', HERBERT, { asin: left }),
        candidate('Dune Messiah', HERBERT, { asin: right }),
      );

      const result = await service.resolveBook({ title: 'Dune Chronicles Messiah', author: HERBERT });

      expect(result).toBeNull();
    });

    it('a canonical-null key never collapses with a non-null key → null', async () => {
      window(
        candidate('Dune', HERBERT, { asin: 'B_DUNE' }),
        candidate('Dune Messiah', HERBERT, { asin: '' }),
      );

      const result = await service.resolveBook({ title: 'Dune Chronicles Messiah', author: HERBERT });

      expect(result).toBeNull();
    });

    it('a single passing candidate with no ASIN is still returned (missing identity is not a hold)', async () => {
      window(candidate('Dune Messiah', HERBERT, { asin: undefined }));

      const result = await service.resolveBook({ title: 'Dune Messiah', author: HERBERT });

      expect(result).toEqual(candidate('Dune Messiah', HERBERT, { asin: undefined }));
      expect(holdLogCalls()).toHaveLength(0);
    });

    it('equal non-null ASINs differing only in case collapse to one candidate → returned, not held', async () => {
      window(
        candidate('Dune', HERBERT, { asin: 'b0dune' }),
        candidate('Dune Messiah', HERBERT, { asin: 'B0DUNE' }),
      );

      const result = await service.resolveBook({ title: 'Dune Chronicles Messiah', author: HERBERT });

      expect(result).toEqual(candidate('Dune', HERBERT, { asin: 'b0dune' }));
      expect(holdLogCalls()).toHaveLength(0);
    });

    it('negative control: the same window with two genuinely different ASINs holds', async () => {
      window(
        candidate('Dune', HERBERT, { asin: 'B0DUNE' }),
        candidate('Dune Messiah', HERBERT, { asin: 'B0MESSIAH' }),
      );

      const result = await service.resolveBook({ title: 'Dune Chronicles Messiah', author: HERBERT });

      expect(result).toBeNull();
    });

    it('a candidate the gate rejects for empty authors does not contribute to the count', async () => {
      window(
        candidate('Dune', HERBERT, { asin: 'B_DUNE', authors: [] }),
        candidate('Dune Messiah', HERBERT, { asin: 'B_MESSIAH' }),
      );

      const result = await service.resolveBook({ title: 'Dune Chronicles Messiah', author: HERBERT });

      expect(result).toEqual(candidate('Dune Messiah', HERBERT, { asin: 'B_MESSIAH' }));
      expect(holdLogCalls()).toHaveLength(0);
    });
  });

  describe('filter and ASIN-path interactions (AC5, AC6, AC7)', () => {
    it('AC5: a sibling dropped by the podcast filter leaves one passing candidate → returned', async () => {
      window(
        candidate('Dune', HERBERT, { asin: 'B_DUNE', contentDeliveryType: 'PodcastParent' }),
        candidate('Dune Messiah', HERBERT, { asin: 'B_MESSIAH' }),
      );

      const result = await service.resolveBook({ title: 'Dune Chronicles Messiah', author: HERBERT });

      expect(result).toEqual(candidate('Dune Messiah', HERBERT, { asin: 'B_MESSIAH' }));
      expect(holdLogCalls()).toHaveLength(0);
    });

    it('AC6: the ASIN fast path wins over a five-way ambiguous window; search is never called', async () => {
      const direct = candidate('Dune', HERBERT, { asin: 'B0AUDIO' });
      mockAudnexus.getBook.mockResolvedValueOnce(direct);
      window(
        ...['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((part, i) =>
          candidate(`Artemis Fowl Chronicles: ${part}`, COLFER, { asin: `B_${i}` })),
      );

      const result = await service.resolveBook({ asin: 'B0AUDIO', title: 'Artemis Fowl Chronicles', author: COLFER });

      expect(result).toEqual(direct);
      expect(mockAudibleProvider.searchBooks).not.toHaveBeenCalled();
    });

    it('AC6: a whitespace-only ASIN goes straight to search, where the ambiguous window holds', async () => {
      window(
        candidate('Dune', HERBERT, { asin: 'B_DUNE' }),
        candidate('Dune Messiah', HERBERT, { asin: 'B_MESSIAH' }),
      );

      const result = await service.resolveBook({ asin: '   ', title: 'Dune Chronicles Messiah', author: HERBERT });

      expect(result).toBeNull();
      expect(mockAudnexus.getBook).not.toHaveBeenCalled();
    });

    it.each([
      ['TransientError', new TransientError('Audnexus', 'HTTP 503')],
      ['a generic Error', new Error('Network error')],
    ])('AC7: %s on the ASIN path is swallowed by enrichBook, so the ambiguous fallback window holds', async (_label, error) => {
      mockAudnexus.getBook.mockRejectedValueOnce(error);
      window(
        candidate('Dune', HERBERT, { asin: 'B_DUNE' }),
        candidate('Dune Messiah', HERBERT, { asin: 'B_MESSIAH' }),
      );

      const result = await service.resolveBook({ asin: 'B_DEAD', title: 'Dune Chronicles Messiah', author: HERBERT });

      expect(result).toBeNull();
      expect(mockAudibleProvider.searchBooks).toHaveBeenCalledWith('Dune Chronicles Messiah Frank Herbert');
      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ asin: 'B_DEAD' }),
        'Audnexus enrichment lookup failed',
      );
    });
  });

  describe('the exact-title tie-break (AC13)', () => {
    it('recovers the correct sibling when the wrong one is first — the #2202 wrong-sibling bug', async () => {
      const messiah = candidate('Dune Messiah', HERBERT, { asin: 'B_MESSIAH' });
      window(candidate('Dune', HERBERT, { asin: 'B_DUNE' }), messiah);

      const result = await service.resolveBook({ title: 'Dune Messiah', author: HERBERT });

      expect(result).toEqual(messiah);
      expect(holdLogCalls()).toHaveLength(0);
    });

    it('counterfactual twin: the same rule when the exact match is already first (fixture order decides the tag)', async () => {
      const opener = candidate('Artemis Fowl', COLFER, { asin: 'B_OPENER' });
      window(
        opener,
        candidate('The Artemis Fowl Files', COLFER, { asin: 'B_FILES' }),
        candidate('Artemis Fowl: The Arctic Incident', COLFER, { asin: 'B_ARCTIC' }),
        candidate('Artemis Fowl: The Eternity Code', COLFER, { asin: 'B_CODE' }),
        candidate('Artemis Fowl: The Opal Deception', COLFER, { asin: 'B_OPAL' }),
      );

      const result = await service.resolveBook({ title: 'Artemis Fowl', author: COLFER });

      expect(result).toEqual(opener);
    });

    it.each([
      ['a parenthesised audio-edition tail', 'Artemis Fowl (Unabridged)'],
      ['a bracketed audio-edition tail', 'Artemis Fowl [Audible]'],
    ])('the fold tolerates case, doubled whitespace and %s', async (_label, exactTitle) => {
      const exact = candidate(exactTitle, COLFER, { asin: 'B_EXACT' });
      window(candidate('The Artemis Fowl Files', COLFER, { asin: 'B_FILES' }), exact);

      const result = await service.resolveBook({ title: 'artemis  fowl', author: COLFER });

      expect(result).toEqual(exact);
    });

    it('the fold tolerates a curly apostrophe against a straight one', async () => {
      const exact = candidate('Artemis Fowl’s Tale', COLFER, { asin: 'B_EXACT' });
      window(candidate("Artemis Fowl's Tale: The Files", COLFER, { asin: 'B_FILES' }), exact);

      const result = await service.resolveBook({ title: "artemis  fowl's tale", author: COLFER });

      expect(result).toEqual(exact);
    });

    it.each([
      ['Cyrillic', 'Дозоры', 'Дозоры II'],
      ['Japanese', '影の書', '影の書物'],
    ])('%s: the fold preserves the script, so a byte-identical candidate behind a sibling still wins', async (_label, rowTitle, sibling) => {
      const exact = candidate(rowTitle, 'A B', { asin: 'B_EXACT' });
      window(candidate(sibling, 'A B', { asin: 'B_SIBLING' }), exact);

      const result = await service.resolveBook({ title: rowTitle, author: 'A B' });

      expect(result).toEqual(exact);
    });

    it('two different non-Latin candidates, neither an exact match → null (the fold did not empty them)', async () => {
      window(
        candidate('影の書物', 'A B', { asin: 'B_ONE' }),
        candidate('影の書庫', 'A B', { asin: 'B_TWO' }),
      );

      const result = await service.resolveBook({ title: '影の書', author: 'A B' });

      expect(result).toBeNull();
    });
  });

  describe('the tie-break fold must be identity-preserving, not the tolerant dedup fold', () => {
    // Each row below is uniquely "matched" to the WRONG sibling by normalizeTitleCore, which strips
    // trailing volume markers and generic parentheticals. These pin that collapse out of the resolver.
    it.each([
      ['numbered siblings', 'Saga Book 1', 'A B', 'Saga Companion', 'Saga Book 2'],
      ['comma and Vol marker forms', 'Saga, Book 1', 'A B', 'Saga Companion', 'Saga Vol 2'],
      ['a numbered sibling ahead of a companion', 'Dune Book 1', HERBERT, 'Dune Book 2', 'Dune Companion'],
      ['a differing generic parenthetical', 'Dune', HERBERT, 'Dune Messiah', 'Dune (Book 2)'],
      [
        'a series-position parenthetical',
        'The Farthest Shore',
        'Ursula K Le Guin',
        'The Farthest Shore Companion',
        'The Farthest Shore (The Earthsea Cycle Book 3)',
      ],
    ])('%s hold instead of resolving', async (_label, rowTitle, author, first, second) => {
      window(
        candidate(first, author, { asin: 'B_ONE' }),
        candidate(second, author, { asin: 'B_TWO' }),
      );

      const result = await service.resolveBook({ title: rowTitle, author });

      expect(result).toBeNull();
    });
  });

  describe('observability (AC11)', () => {
    it('a hold emits exactly one info line carrying the query, the distinct passing count and the window size', async () => {
      window(
        candidate('Dune', HERBERT, { asin: 'B_DUNE' }),
        candidate('Dune Messiah', HERBERT, { asin: 'B_MESSIAH' }),
      );

      await service.resolveBook({ title: 'Dune Chronicles Messiah', author: HERBERT });

      expect(holdLogCalls()).toEqual([
        [
          // exact: 0 — neither candidate survives the lossless fold against this query.
          expect.objectContaining({ query: 'Dune Chronicles Messiah Frank Herbert', passing: 2, exact: 0, window: 5 }),
          AMBIGUOUS_WINDOW_HELD,
        ],
      ]);
    });

    // The two hold populations need opposite fixes — a title/normalization miss versus a failed
    // equivalence proof — and `passing` alone cannot tell them apart. Both arms are pinned so the
    // field cannot be dropped without a test failing.
    it('distinguishes the two hold populations: exact 0 for a title miss, exact >= 2 for a failed equivalence proof', async () => {
      window(
        candidate('Dune Messiah', HERBERT, { asin: 'B_ONE', duration: 600, narrators: ['Scott Brick'] }),
        candidate('Dune Messiah', HERBERT, { asin: 'B_TWO', duration: 900, narrators: ['Simon Vance'] }),
      );

      await service.resolveBook({ title: 'Dune Messiah', author: HERBERT });

      expect(holdLogCalls()).toEqual([
        [
          expect.objectContaining({ query: 'Dune Messiah Frank Herbert', passing: 2, exact: 2, window: 5 }),
          AMBIGUOUS_WINDOW_HELD,
        ],
      ]);
    });

    it('the tie-break-resolved, one-passing and zero-passing branches emit no hold line', async () => {
      window(candidate('Dune', HERBERT, { asin: 'B_DUNE' }), candidate('Dune Messiah', HERBERT, { asin: 'B_MESSIAH' }));
      await service.resolveBook({ title: 'Dune Messiah', author: HERBERT });

      window(candidate('Dune Messiah', HERBERT, { asin: 'B_MESSIAH' }));
      await service.resolveBook({ title: 'Dune Messiah', author: HERBERT });

      window(candidate('Mistborn', 'Brandon Sanderson', { asin: 'B_MIST' }));
      await service.resolveBook({ title: 'Dune Messiah', author: HERBERT });

      expect(holdLogCalls()).toHaveLength(0);
    });
  });

  describe('exactTitleCandidates — the empty-fold domain guard (AC13)', () => {
    // Asserted at the helper: no window reachable through matchPassesValidation distinguishes
    // guard-present from guard-absent, so a resolveBook-level test here would be vacuous.
    it('a row title whose lossless fold is empty never names a winner, even against a lone twin', () => {
      const twin: BookMetadata = { title: '!!!', authors: [{ name: 'A B' }] };

      expect(exactTitleCandidates([twin], '!!!')).toEqual([]);
    });

    it('positive control: a non-empty fold still names its unique match', () => {
      const winner: BookMetadata = { title: 'Dune Messiah', authors: [{ name: HERBERT }] };
      const other: BookMetadata = { title: 'Dune', authors: [{ name: HERBERT }] };

      const exact = exactTitleCandidates([other, winner], 'dune  messiah');

      expect(exact).toHaveLength(1);
      expect(exact[0]).toBe(winner);
    });
  });
});

describe('MetadataService.resolveBook — collapsing proven-equivalent duplicate listings (#2219)', () => {
  let service: MetadataService;
  let mockLog: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks leaves *Once queues intact; window fixtures queue several, so reset outright.
    mockAudibleProvider.searchBooks.mockReset().mockResolvedValue({ books: [] });
    mockAudnexus.getBook.mockReset().mockResolvedValue(null);
    mockLog = createMockLogger();
    service = new MetadataService(inject<FastifyBaseLogger>(mockLog));
  });

  const TCHAIKOVSKY = 'Adrian Tchaikovsky';
  const BEAR_HEAD_NARRATORS = ['Sophie Aldred', 'Mark Elstob', 'Ben Allen'];
  /** 12h57m expressed in MINUTES — `BookMetadata.duration` is minutes, not seconds. */
  const BEAR_HEAD_MINUTES = 777;

  function candidate(title: string, author: string, overrides: Partial<BookMetadata> = {}): BookMetadata {
    return { title, authors: [{ name: author }], ...overrides };
  }

  /** A collapse-eligible listing: exact title, canonical ASIN, positive duration, narrator signal. */
  function listing(asin: string, overrides: Partial<BookMetadata> = {}): BookMetadata {
    return candidate('Bear Head', TCHAIKOVSKY, {
      asin,
      duration: BEAR_HEAD_MINUTES,
      narrators: BEAR_HEAD_NARRATORS,
      ...overrides,
    });
  }

  function window(...books: BookMetadata[]): void {
    mockAudibleProvider.searchBooks.mockResolvedValueOnce({ books });
  }

  function holdLogCalls(): unknown[][] {
    return (mockLog.info as Mock).mock.calls.filter((call) => call[1] === AMBIGUOUS_WINDOW_HELD);
  }

  function collapseLogCalls(): unknown[][] {
    return (mockLog.debug as Mock).mock.calls.filter((call) => call[1] === AMBIGUOUS_WINDOW_COLLAPSED);
  }

  function resolveBearHead(): Promise<BookMetadata | null> {
    return service.resolveBook({ title: 'Bear Head', author: TCHAIKOVSKY });
  }

  describe('the collapse set is the exact-title candidates, never the passing window (AC2)', () => {
    // The sibling reaches recording scope on purpose: matchesLibraryIdentity folds through
    // normalizeTitleCore, which strips `Book N`, so `Saga Book 2` compares same-recording against
    // BOTH `Saga Book 1` listings (#1896 pins that collapse and it must not be "fixed" here).
    // Exactness of the collapse set — not the recording predicate — is what excludes it.
    it('a same-recording sibling whose ASIN sorts first is never selected', async () => {
      const sibling = candidate('Saga Book 2', 'A B', { asin: 'B00000000', duration: 600, narrators: ['Jim Dale'] });
      const first = candidate('Saga Book 1', 'A B', { asin: 'B00000001', duration: 600, narrators: ['Jim Dale'] });
      const second = candidate('Saga Book 1', 'A B', { asin: 'B00000009', duration: 600, narrators: ['Jim Dale'] });
      window(sibling, first, second);

      const result = await service.resolveBook({ title: 'Saga Book 1', author: 'A B' });

      expect(result).toEqual(first);
      expect(collapseLogCalls()).toEqual([
        [
          expect.objectContaining({ selectedAsin: 'B00000001', equivalentAsins: ['B00000001', 'B00000009'] }),
          AMBIGUOUS_WINDOW_COLLAPSED,
        ],
      ]);
      expect(holdLogCalls()).toHaveLength(0);
    });
  });

  describe('the Bear Head specimen (AC1)', () => {
    it('two regional listings of one recording — same narrators in a different order — resolve instead of holding', async () => {
      const regionA = listing('B08REGIONA');
      const regionB = listing('B09REGIONB', { narrators: [...BEAR_HEAD_NARRATORS].reverse() });
      window(regionA, regionB);

      const result = await resolveBearHead();

      expect(result).toEqual(regionA);
      expect(holdLogCalls()).toHaveLength(0);
    });
  });

  describe('gate negatives — each still holds (AC3, AC4, AC5, AC7)', () => {
    it('a non-transitive triple holds: 600 and 608 minutes are a duration mismatch even though each adjacent pair matches', async () => {
      window(
        listing('B_D600', { duration: 600 }),
        listing('B_D604', { duration: 604 }),
        listing('B_D608', { duration: 608 }),
      );

      expect(await resolveBearHead()).toBeNull();
      expect(collapseLogCalls()).toHaveLength(0);
      expect(holdLogCalls()).toHaveLength(1);
    });

    it.each([
      ['duration absent on both sides', { duration: undefined }, { duration: undefined }],
      ['duration zero on one side', {}, { duration: 0 }],
      ['a negative duration on one side', {}, { duration: -BEAR_HEAD_MINUTES }],
      ['an empty-string ASIN on one side', {}, { asin: '' }],
      ['a whitespace-only ASIN on one side', {}, { asin: '   ' }],
      ['narrators absent on both sides', { narrators: undefined }, { narrators: undefined }],
      ['an empty narrator array on one side', {}, { narrators: [] }],
      ['placeholder-only narrators on one side', {}, { narrators: ['Full Cast'] }],
      ['a different narrator set', {}, { narrators: ['Someone Else'] }],
      ['a production-form conflict', { formatType: 'abridged' }, { formatType: 'unabridged' }],
    ])('%s → held', async (_label, left, right) => {
      window(listing('B_LEFT', left), listing('B_RIGHT', right));

      expect(await resolveBearHead()).toBeNull();
      expect(collapseLogCalls()).toHaveLength(0);
      expect(holdLogCalls()).toHaveLength(1);
    });

    it('divergent primary author spellings hold — bibliographic scope refuses the pair', async () => {
      // Title-only input: an author on the row would reject the divergent spelling at the gate,
      // leaving one candidate, so the refusal being asserted would never be reached.
      window(listing('B_TCH'), listing('B_CZA', { authors: [{ name: 'Adrian Czajkowski' }] }));

      expect(await service.resolveBook({ title: 'Bear Head' })).toBeNull();
      expect(collapseLogCalls()).toHaveLength(0);
    });

    it('two authorless listings that fold equal but differ raw hold — scope compares raw titles there', async () => {
      const authorless = (title: string, asin: string): BookMetadata => ({
        title, authors: [], asin, duration: 600, narrators: ['Nathaniel Parker'],
      });
      window(authorless('Artemis Fowl', 'B_AF1'), authorless('artemis  fowl', 'B_AF2'));

      expect(await service.resolveBook({ title: 'Artemis Fowl' })).toBeNull();
      expect(collapseLogCalls()).toHaveLength(0);
    });

    it.each([
      ['an absent formatType on the other side', {}],
      ['an unrecognized formatType on the other side', { formatType: 'audiodrama' }],
    ])('the production veto needs two KNOWN, different forms: %s still collapses', async (_label, right) => {
      window(listing('B_AAA', { formatType: 'unabridged' }), listing('B_ZZZ', right));

      expect((await resolveBearHead())?.asin).toBe('B_AAA');
      expect(collapseLogCalls()).toHaveLength(1);
    });
  });

  describe('selection among the collapsed set (AC8, AC9, AC10)', () => {
    it('the pick and the debug payload are independent of provider order', async () => {
      const rich = listing('B_ZZZ', { coverUrl: 'https://example.com/z.jpg' });
      const plain = listing('B_AAA');

      window(rich, plain);
      const forwards = await resolveBearHead();
      window(plain, rich);
      const backwards = await resolveBearHead();

      expect(forwards).toEqual(rich);
      expect(backwards).toEqual(rich);
      expect(collapseLogCalls()).toEqual([
        [expect.objectContaining({ selectedAsin: 'B_ZZZ', equivalentAsins: ['B_AAA', 'B_ZZZ'] }), AMBIGUOUS_WINDOW_COLLAPSED],
        [expect.objectContaining({ selectedAsin: 'B_ZZZ', equivalentAsins: ['B_AAA', 'B_ZZZ'] }), AMBIGUOUS_WINDOW_COLLAPSED],
      ]);
    });

    // Every row is two otherwise-identical equivalent listings arranged so the ASIN tie-break would
    // pick the OTHER one, so a green row proves the series rule fired and not the fallback.
    it.each([
      ['a seriesPrimary with a usable name', { seriesPrimary: { name: 'Dogs of War' } }, 'B_ZZZ'],
      ['series[0] with a usable name and no primary', { series: [{ name: 'Dogs of War' }] }, 'B_ZZZ'],
      ['both shapes present and usable', { seriesPrimary: { name: 'Dogs of War' }, series: [{ name: 'Other' }] }, 'B_ZZZ'],
      ['an empty seriesPrimary name', { seriesPrimary: { name: '' } }, 'B_AAA'],
      ['a whitespace-only seriesPrimary name', { seriesPrimary: { name: '   ' } }, 'B_AAA'],
      // AC9b: pickPrimarySeries resolves on the OBJECT, so a blank primary shadows a good series[0].
      // An implementation that ORs the two shapes together passes every other row and fails this one.
      ['a blank seriesPrimary shadowing a usable series[0]', { seriesPrimary: { name: '  ' }, series: [{ name: 'Dogs of War' }] }, 'B_AAA'],
      ['an empty series array', { series: [] }, 'B_AAA'],
      ['a whitespace-only series[0] name', { series: [{ name: '   ' }] }, 'B_AAA'],
    ])('AC9.2 series usability — %s', async (_label, shape, expectedAsin) => {
      window(listing('B_ZZZ', shape), listing('B_AAA'));

      expect((await resolveBearHead())?.asin).toBe(expectedAsin);
    });

    it('AC9.2 outranks AC9.3: a series-bearing candidate beats a peer with more useful fields', async () => {
      window(
        listing('B_ZZZ', { seriesPrimary: { name: 'Dogs of War' } }),
        listing('B_AAA', { coverUrl: 'https://example.com/a.jpg', description: 'Blurb', publisher: 'Tor' }),
      );

      expect((await resolveBearHead())?.asin).toBe('B_ZZZ');
    });

    it.each([
      ['coverUrl', { coverUrl: 'https://example.com/c.jpg' }],
      ['description', { description: 'A real blurb' }],
      ['subtitle', { subtitle: 'A Novel' }],
      ['publisher', { publisher: 'Tor' }],
      ['publishedDate', { publishedDate: '2021-01-01' }],
      ['language', { language: 'english' }],
      ['genres', { genres: ['Science Fiction'] }],
    ])('AC9.3 a usable %s outranks a bare peer whose ASIN sorts first', async (_label, extra) => {
      window(listing('B_ZZZ', extra), listing('B_AAA'));

      expect((await resolveBearHead())?.asin).toBe('B_ZZZ');
    });

    it('AC9.3 counts the fields: two useful fields beat one', async () => {
      window(
        listing('B_AAA', { publisher: 'Tor' }),
        listing('B_ZZZ', { coverUrl: 'https://example.com/z.jpg', description: 'Blurb' }),
      );

      expect((await resolveBearHead())?.asin).toBe('B_ZZZ');
    });

    // The blank-bearing candidate holds the SMALLER ASIN, so counting a blank would flip the pick.
    it.each([
      ['a whitespace-only publisher', { publisher: '   ' }],
      ['an empty description', { description: '' }],
      ['a whitespace-only description', { description: '  ' }],
      ['an empty subtitle', { subtitle: '' }],
      ['a whitespace-only language', { language: '   ' }],
      ['a whitespace-only publishedDate', { publishedDate: ' ' }],
      ['an empty genres array', { genres: [] }],
      ['a genres array of blanks', { genres: ['   ', ''] }],
    ])('AC9 %s is not a useful field, so the peer carrying one real field wins', async (_label, blank) => {
      window(listing('B_AAA', blank), listing('B_ZZZ', { publisher: 'Tor' }));

      expect((await resolveBearHead())?.asin).toBe('B_ZZZ');
    });

    it('AC9.4 two equally rich, series-less listings fall to the smallest canonical ASIN, from either order', async () => {
      window(listing('B_AAA'), listing('B_ZZZ'));
      expect((await resolveBearHead())?.asin).toBe('B_AAA');

      window(listing('B_ZZZ'), listing('B_AAA'));
      expect((await resolveBearHead())?.asin).toBe('B_AAA');
    });

    it('AC9.1 the requested ASIN wins over a richer peer and over the smaller ASIN, comparing canonically', async () => {
      window(
        listing('B_AAA', { coverUrl: 'https://example.com/a.jpg', description: 'Blurb' }),
        listing('B_REGIONAL'),
      );

      // The ASIN fast path misses (getBook → null), so resolution falls through to the window.
      const result = await service.resolveBook({ asin: 'b_regional', title: 'Bear Head', author: TCHAIKOVSKY });

      expect(result?.asin).toBe('B_REGIONAL');
      expect(mockAudnexus.getBook).toHaveBeenCalledWith('b_regional');
    });

    it('AC9.1 an input ASIN absent from the collapsed set does not disturb the ranking', async () => {
      window(listing('B_AAA'), listing('B_ZZZ', { publisher: 'Tor' }));

      const result = await service.resolveBook({ asin: 'B_ELSEWHERE', title: 'Bear Head', author: TCHAIKOVSKY });

      expect(result?.asin).toBe('B_ZZZ');
    });

    it('AC10 the selected object is returned verbatim — no peer field is merged in', async () => {
      const rich = listing('B_ZZZ', { coverUrl: 'https://example.com/z.jpg', description: 'Blurb' });
      const plain = listing('B_AAA', { publisher: 'Tor' });
      window(rich, plain);

      const result = await resolveBearHead();

      expect(result).toEqual(rich);
      expect(result).not.toHaveProperty('publisher');
    });
  });

  describe('observability (AC15, AC16, AC17)', () => {
    it('a collapse emits exactly one debug line with the full payload and no hold line', async () => {
      window(
        listing('B_AAA'),
        listing('B_ZZZ'),
        candidate('Bear Head Companion', TCHAIKOVSKY, { asin: 'B_COMP', duration: 100, narrators: ['Someone Else'] }),
      );

      await resolveBearHead();

      expect(collapseLogCalls()).toEqual([
        [
          {
            query: 'Bear Head Adrian Tchaikovsky',
            passing: 3,
            exact: 2,
            selectedAsin: 'B_AAA',
            equivalentAsins: ['B_AAA', 'B_ZZZ'],
          },
          AMBIGUOUS_WINDOW_COLLAPSED,
        ],
      ]);
      expect(holdLogCalls()).toHaveLength(0);
    });

    it('equivalentAsins is sorted, so the payload is identical from either provider order', async () => {
      window(listing('B_ZZZ'), listing('B_AAA'));
      await resolveBearHead();

      expect(collapseLogCalls()[0]![0]).toEqual(
        expect.objectContaining({ equivalentAsins: ['B_AAA', 'B_ZZZ'] }),
      );
    });

    it('a true hold still emits exactly one info line with the existing payload and no collapse line', async () => {
      window(listing('B_AAA', { duration: 600 }), listing('B_ZZZ', { duration: 900 }));

      await resolveBearHead();

      expect(holdLogCalls()).toEqual([
        [
          expect.objectContaining({ query: 'Bear Head Adrian Tchaikovsky', passing: 2, window: 5 }),
          AMBIGUOUS_WINDOW_HELD,
        ],
      ]);
      expect(collapseLogCalls()).toHaveLength(0);
    });
  });

  describe('unchanged paths (AC11, AC12, AC13)', () => {
    it('a single passing candidate is returned without consulting the collapse arm', async () => {
      window(listing('B_ONLY'));

      expect((await resolveBearHead())?.asin).toBe('B_ONLY');
      expect(collapseLogCalls()).toHaveLength(0);
      expect(holdLogCalls()).toHaveLength(0);
    });

    it('zero passing candidates still return null with no collapse line', async () => {
      window(candidate('Something Else Entirely', 'Nobody At All', { asin: 'B_NO' }));

      expect(await resolveBearHead()).toBeNull();
      expect(collapseLogCalls()).toHaveLength(0);
    });

    it('AC11: two listings sharing a canonical ASIN collapse at distinctness, not at the recording gate', async () => {
      window(listing('b08regiona'), listing('B08REGIONA', { duration: 900 }));

      // Distinctness drops the second, leaving one passing candidate — a duration that would have
      // failed the collapse gate never gets consulted.
      expect((await resolveBearHead())?.asin).toBe('b08regiona');
      expect(collapseLogCalls()).toHaveLength(0);
      expect(holdLogCalls()).toHaveLength(0);
    });
  });
});

describe('narrator-placeholder vocabulary subset consistency (#1657)', () => {
  // Reject-word pseudo narrators are intentionally narrower than the fuzzy-match no-signal vocabulary.

  it('PSEUDO_NARRATORS ⊆ NARRATOR_PLACEHOLDERS (every reject-word marker is a known placeholder)', () => {
    for (const marker of PSEUDO_NARRATORS) {
      expect(NARRATOR_PLACEHOLDERS.has(marker)).toBe(true);
    }
  });

  it('PSEUDO_NARRATORS stays its current narrow 3-value reject-word set (behavior unchanged)', () => {
    expect([...PSEUDO_NARRATORS].sort()).toEqual(['full cast', 'unknown', 'various']);
  });
});
