import { describe, it, expect } from 'vitest';
import { normalizeGenres, findUnmatchedGenres } from './genres.js';

describe('normalizeGenres', () => {
  describe('BISAC path splitting', () => {
    it('extracts leaf from BISAC path', () => {
      const result = normalizeGenres(['Fiction / Fantasy / Epic']);
      expect(result).toContain('Epic Fantasy');
    });

    it('drops "General" leaf', () => {
      const result = normalizeGenres(['Fiction / Fantasy / General']);
      expect(result).toContain('Fantasy');
      expect(result).not.toContain('General');
    });

    it('handles two-part BISAC path', () => {
      const result = normalizeGenres(['Fiction / Fantasy']);
      expect(result).toContain('Fantasy');
    });

    it('handles "Fiction / General"', () => {
      const result = normalizeGenres(['Fiction / General']);
      expect(result).toContain('Fiction');
    });

    it('combines leaf with parent for context', () => {
      const result = normalizeGenres(['Fiction / Fantasy / Action & Adventure']);
      expect(result).toContain('Action & Adventure Fantasy');
    });
  });

  describe('synonym mapping', () => {
    it('normalizes Sci-Fi to Science Fiction', () => {
      const result = normalizeGenres(['Sci-Fi']);
      expect(result).toContain('Science Fiction');
    });

    it('normalizes SciFi to Science Fiction', () => {
      const result = normalizeGenres(['SciFi']);
      expect(result).toContain('Science Fiction');
    });

    it('normalizes Nonfiction to Non-Fiction', () => {
      const result = normalizeGenres(['Nonfiction']);
      expect(result).toContain('Non-Fiction');
    });

    it('normalizes LitRPG variants', () => {
      expect(normalizeGenres(['Lit RPG'])).toContain('LitRPG');
      expect(normalizeGenres(['litrpg'])).toContain('LitRPG');
    });

    it('normalizes YA to Young Adult', () => {
      const result = normalizeGenres(['YA']);
      expect(result).toContain('Young Adult');
    });
  });

  describe('compound removal', () => {
    it('removes "Science Fiction & Fantasy" when both components exist', () => {
      const result = normalizeGenres(['Fantasy', 'Science Fiction', 'Science Fiction & Fantasy']);
      expect(result).toContain('Fantasy');
      expect(result).toContain('Science Fiction');
      expect(result).not.toContain('Science Fiction & Fantasy');
    });

    it('keeps compound when components are missing', () => {
      const result = normalizeGenres(['Science Fiction & Fantasy']);
      expect(result).toContain('Science Fiction & Fantasy');
    });
  });

  describe('generic parent removal', () => {
    it('removes "Fiction" when child genre exists', () => {
      const result = normalizeGenres(['Fiction', 'Fantasy']);
      expect(result).toContain('Fantasy');
      expect(result).not.toContain('Fiction');
    });

    it('keeps "Fiction" when no child genre exists', () => {
      const result = normalizeGenres(['Fiction']);
      expect(result).toContain('Fiction');
    });

    it('removes "Non-Fiction" when child exists', () => {
      const result = normalizeGenres(['Non-Fiction', 'True Crime']);
      expect(result).not.toContain('Non-Fiction');
      expect(result).toContain('True Crime');
    });
  });

  describe('deduplication', () => {
    it('deduplicates case-insensitively', () => {
      const result = normalizeGenres(['Fantasy', 'fantasy', 'FANTASY']);
      expect(result).toEqual(['Fantasy']);
    });

    it('preserves first occurrence', () => {
      const result = normalizeGenres(['fantasy', 'Fantasy']);
      expect(result?.[0]).toBe('fantasy');
    });
  });

  describe('order preservation', () => {
    it('preserves original ordering after normalization', () => {
      const result = normalizeGenres(['Fantasy', 'Adventure', 'Mystery']);
      expect(result).toEqual(['Fantasy', 'Adventure', 'Mystery']);
    });
  });

  describe('edge cases', () => {
    it('returns undefined for null input', () => {
      expect(normalizeGenres(null)).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
      expect(normalizeGenres(undefined)).toBeUndefined();
    });

    it('returns undefined for empty array', () => {
      expect(normalizeGenres([])).toBeUndefined();
    });

    it('handles single genre', () => {
      expect(normalizeGenres(['Fantasy'])).toEqual(['Fantasy']);
    });
  });

  describe('full normalization pipeline', () => {
    it('normalizes complex real-world genre list', () => {
      const raw = [
        'Fantasy', 'Fiction', 'Science Fiction', 'Adventure',
        'Science Fiction & Fantasy', 'Historical Fantasy',
        'Fiction / Fantasy / Epic', 'Fiction / Fantasy / Action & Adventure',
        'Fiction / Fantasy / Historical', 'Fiction / Fantasy / General',
      ];
      const result = normalizeGenres(raw);

      // Should keep meaningful genres
      expect(result).toContain('Fantasy');
      expect(result).toContain('Science Fiction');
      expect(result).toContain('Adventure');
      expect(result).toContain('Historical Fantasy');
      expect(result).toContain('Epic Fantasy');

      // Should remove
      expect(result).not.toContain('Fiction');
      expect(result).not.toContain('Science Fiction & Fantasy');

      // Should not have duplicates
      const lowerSet = result!.map((g) => g.toLowerCase());
      expect(new Set(lowerSet).size).toBe(lowerSet.length);
    });
  });
});

describe('findUnmatchedGenres', () => {
  it('identifies genres not in any known list', () => {
    const normalized = ['Fantasy', 'Cozy Mystery', 'Progression Fantasy'];
    const unmatched = findUnmatchedGenres(normalized, normalized);

    // Fantasy is a known fiction child, so it's matched
    expect(unmatched).not.toContain('Fantasy');
    // These are unknown
    expect(unmatched).toContain('Cozy Mystery');
    expect(unmatched).toContain('Progression Fantasy');
  });

  it('returns empty for null input', () => {
    expect(findUnmatchedGenres(null, null)).toEqual([]);
  });

  it('returns empty when all genres are known', () => {
    const result = findUnmatchedGenres(['Fantasy', 'Science Fiction'], ['Fantasy', 'Science Fiction']);
    expect(result).toEqual([]);
  });
});
