import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetadataService } from './metadata.service.js';

// Mock the AudnexusProvider module
vi.mock('@narratorr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@narratorr/core')>();
  return {
    ...actual,
    AudnexusProvider: vi.fn().mockImplementation(() => ({
      name: 'Audnexus',
      type: 'audnexus',
      search: vi.fn().mockResolvedValue({ books: [], authors: [], series: [] }),
      searchAuthors: vi.fn().mockResolvedValue([]),
      searchBooks: vi.fn().mockResolvedValue([]),
      getAuthor: vi.fn().mockResolvedValue(null),
      getAuthorBooks: vi.fn().mockResolvedValue([]),
      getBook: vi.fn().mockResolvedValue(null),
      getSeries: vi.fn().mockResolvedValue(null),
      test: vi.fn().mockResolvedValue({ success: true }),
    })),
  };
});

describe('MetadataService', () => {
  let service: MetadataService;

  beforeEach(() => {
    service = new MetadataService();
  });

  describe('search', () => {
    it('delegates to the provider', async () => {
      const result = await service.search('Brandon Sanderson');
      expect(result).toEqual({ books: [], authors: [], series: [] });
    });

    it('returns empty results on error', async () => {
      // Override the provider's search to throw
      const provider = (service as any).providers[0];
      provider.search.mockRejectedValueOnce(new Error('Network error'));

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
      const provider = (service as any).providers[0];
      provider.searchAuthors.mockRejectedValueOnce(new Error('fail'));

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
      const result = await service.getAuthor('B001H6UJO8');
      expect(result).toBeNull();
    });

    it('returns author when found', async () => {
      const mockAuthor = { name: 'Brandon Sanderson', asin: 'B001H6UJO8' };
      const provider = (service as any).providers[0];
      provider.getAuthor.mockResolvedValueOnce(mockAuthor);

      const result = await service.getAuthor('B001H6UJO8');
      expect(result).toEqual(mockAuthor);
    });
  });

  describe('getBook', () => {
    it('returns null when not found', async () => {
      const result = await service.getBook('B0030DL4GK');
      expect(result).toBeNull();
    });

    it('returns book when found', async () => {
      const mockBook = { title: 'The Way of Kings', asin: 'B0030DL4GK', authors: [] };
      const provider = (service as any).providers[0];
      provider.getBook.mockResolvedValueOnce(mockBook);

      const result = await service.getBook('B0030DL4GK');
      expect(result).toEqual(mockBook);
    });
  });

  describe('testProviders', () => {
    it('returns test results for all providers', async () => {
      const results = await service.testProviders();
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Audnexus');
      expect(results[0].success).toBe(true);
    });
  });

  describe('getProviders', () => {
    it('returns list of provider info', () => {
      const providers = service.getProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]).toEqual({ name: 'Audnexus', type: 'audnexus' });
    });
  });
});
