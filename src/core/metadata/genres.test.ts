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

  describe('Audible taxonomy harvest (#1322)', () => {
    describe('DROP_GENRES', () => {
      it('drops "Genre Fiction" leaving the meaningful sibling', () => {
        expect(normalizeGenres(['Genre Fiction', 'Thriller & Suspense'])).toEqual(['Thriller']);
      });

      it('returns undefined when a dropped genre is the sole entry', () => {
        expect(normalizeGenres(['Genre Fiction'])).toBeUndefined();
      });
    });

    describe('synonym additions', () => {
      it('maps "Teen & Young Adult" to "Young Adult"', () => {
        expect(normalizeGenres(['Teen & Young Adult'])).toEqual(['Young Adult']);
      });

      it('maps "Comedy & Humor" to "Humor"', () => {
        expect(normalizeGenres(['Comedy & Humor'])).toEqual(['Humor']);
      });

      it('maps "Historical" to "Historical Fiction"', () => {
        expect(normalizeGenres(['Historical'])).toEqual(['Historical Fiction']);
      });

      it('maps "Epic" to "Epic Fantasy" and coexists with Fantasy', () => {
        expect(normalizeGenres(['Epic', 'Fantasy'])).toEqual(['Epic Fantasy', 'Fantasy']);
      });
    });

    describe('Audible generic parents', () => {
      it('removes "Science Fiction & Fantasy" when a child is present', () => {
        expect(normalizeGenres(['Science Fiction & Fantasy', 'Space Opera'])).toEqual(['Space Opera']);
      });

      it('collapses two Audible parents to the lone known child', () => {
        expect(
          normalizeGenres(['Literature & Fiction', 'Mystery, Thriller & Suspense', 'Crime Thrillers']),
        ).toEqual(['Crime Thrillers']);
      });

      it('keeps a lone Audible parent when no child is present', () => {
        expect(normalizeGenres(['Mystery, Thriller & Suspense'])).toEqual([
          'Mystery, Thriller & Suspense',
        ]);
      });
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
    const unmatched = findUnmatchedGenres(['Fantasy', 'Cozy Mystery', 'Progression Fantasy']);

    // Fantasy is a known fiction child, so it's matched
    expect(unmatched).not.toContain('Fantasy');
    // These are unknown
    expect(unmatched).toContain('Cozy Mystery');
    expect(unmatched).toContain('Progression Fantasy');
  });

  it('returns empty for null input', () => {
    expect(findUnmatchedGenres(null)).toEqual([]);
  });

  it('returns empty when all genres are known', () => {
    const result = findUnmatchedGenres(['Fantasy', 'Science Fiction']);
    expect(result).toEqual([]);
  });

  it('does not flag synonym keys or BISAC paths once normalized', () => {
    // Raw provider genres the normalizer fully handles: a synonym key,
    // a BISAC path, and a generic parent removed alongside its child.
    const raw = ['Sci-Fi', 'Fiction / Fantasy / Epic', 'Fiction'];
    const result = findUnmatchedGenres(normalizeGenres(raw));
    expect(result).toEqual([]);
  });

  it('flags only the genuinely unknown genre from a mixed raw list', () => {
    const raw = ['Sci-Fi', 'Weird Western'];
    const result = findUnmatchedGenres(normalizeGenres(raw));
    expect(result).toEqual(['Weird Western']);
  });

  it('treats newly-harvested Audible children as known (#1322)', () => {
    expect(findUnmatchedGenres(['Space Opera', 'Crime Thrillers', 'Military'])).toEqual([]);
  });

  it('treats a raw dropped genre as known for defense in depth (#1322)', () => {
    expect(findUnmatchedGenres(['genre fiction'])).toEqual([]);
  });

  it('reports no unmatched genres across the full harvested AC corpus (#1322)', () => {
    const raw = [
      'Science Fiction & Fantasy', 'Space Opera',
      'Literature & Fiction', 'Mystery, Thriller & Suspense', 'Crime Thrillers',
      'Teen & Young Adult', 'Epic', 'Fantasy',
      'Genre Fiction', 'Thriller & Suspense',
    ];
    expect(findUnmatchedGenres(normalizeGenres(raw))).toEqual([]);
  });
});
