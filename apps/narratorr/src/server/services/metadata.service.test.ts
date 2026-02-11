import { describe, it, expect, beforeEach, vi } from 'vitest';
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

vi.mock('@narratorr/core', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@narratorr/core')>();
  return {
    ...actual,
    HardcoverProvider: vi.fn().mockImplementation(() => mockProvider),
  };
});

describe('MetadataService', () => {
  let service: MetadataService;

  beforeEach(() => {
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
    service = new MetadataService(createMockLogger() as any);
  });

  describe('search', () => {
    it('delegates to the provider', async () => {
      const result = await service.search('Brandon Sanderson');
      expect(result).toEqual({ books: [], authors: [], series: [] });
    });

    it('returns empty results on error', async () => {
      mockProvider.search.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.search('test');
      expect(result).toEqual({ books: [], authors: [], series: [] });
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

  describe('no API key', () => {
    it('returns empty results when HARDCOVER_API_KEY is not set', async () => {
      vi.stubEnv('HARDCOVER_API_KEY', '');
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
