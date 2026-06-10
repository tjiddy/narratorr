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
    // Every harvested DROP_GENRES key — a sole dropped entry yields undefined,
    // so deleting any key from the set fails its row.
    const DROPPED = [
      'Genre Fiction',
      'Movie, TV & Video Game Tie-Ins',
      'United States',
      'Difficult Situations',
    ];

    describe('DROP_GENRES', () => {
      it.each(DROPPED)('drops "%s" when it is the sole entry', (genre) => {
        expect(normalizeGenres([genre])).toBeUndefined();
      });

      it('drops a noise genre while leaving the meaningful sibling', () => {
        expect(normalizeGenres(['Genre Fiction', 'Thriller & Suspense'])).toEqual(['Thriller']);
      });
    });

    describe('synonym additions', () => {
      // Every harvested SYNONYM_MAP entry: raw key (case-insensitive) → canonical
      // single-genre output. Deleting any entry fails its row.
      const SYNONYMS: [string, string][] = [
        ['Teen & Young Adult', 'Young Adult'],
        ['Epic', 'Epic Fantasy'],
        ['Comedy & Humor', 'Humor'],
        ['Humorous', 'Humor'],
        ['Paranormal & Urban', 'Urban Fantasy'],
        ['Thriller & Suspense', 'Thriller'],
        ['Fantasy & Magic', 'Fantasy'],
        ["Children's Audiobooks", "Children's"],
      ];

      it.each(SYNONYMS)('maps "%s" to "%s"', (raw, canonical) => {
        expect(normalizeGenres([raw])).toEqual([canonical]);
      });

      it('maps "Epic" to "Epic Fantasy" and coexists with Fantasy', () => {
        expect(normalizeGenres(['Epic', 'Fantasy'])).toEqual(['Epic Fantasy', 'Fantasy']);
      });
    });

    describe("contextual 'historical' remap (#1383)", () => {
      // Bare 'Historical' is fiction-side ONLY when no non-fiction marker
      // co-occurs. Audible files non-fiction "Historical" under these markers,
      // where remapping fabricates a wrong fiction label (live-verified on
      // Endurance B002V9ZA6C — narrative non-fiction acquiring Historical Fiction).
      const NONFICTION_MARKERS = ['Biographies & Memoirs', 'History', 'Computers & Technology'];

      it.each(NONFICTION_MARKERS)(
        'does NOT map "Historical" to "Historical Fiction" alongside marker "%s"',
        (marker) => {
          expect(normalizeGenres(['Historical', marker])).not.toContain('Historical Fiction');
        },
      );

      it('matches non-fiction markers case-insensitively', () => {
        expect(normalizeGenres(['Historical', 'biographies & memoirs'])).not.toContain(
          'Historical Fiction',
        );
      });

      it('maps bare "Historical" to "Historical Fiction" with no non-fiction marker', () => {
        expect(normalizeGenres(['Historical'])).toEqual(['Historical Fiction']);
      });

      it('maps "Historical" with fiction siblings (no non-fiction marker)', () => {
        expect(normalizeGenres(['Historical', 'Fantasy'])).toContain('Historical Fiction');
      });

      it('maps BISAC "Fiction / Historical" to "Historical Fiction"', () => {
        expect(normalizeGenres(['Fiction / Historical'])).toContain('Historical Fiction');
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

      // Lone-parent survival pinned for ALL three new Audible parents: each
      // survives unchanged when no child is present AND is not tracked as an
      // unmatched genre (it's a known GENERIC_PARENTS member). (#1383)
      const NEW_PARENTS = [
        'Science Fiction & Fantasy',
        'Literature & Fiction',
        'Mystery, Thriller & Suspense',
      ];

      it.each(NEW_PARENTS)('keeps lone parent "%s" and does not track it', (parent) => {
        expect(normalizeGenres([parent])).toEqual([parent]);
        expect(findUnmatchedGenres(normalizeGenres([parent]))).toEqual([]);
      });
    });

    describe('GENERIC_PARENTS BISAC dual-consumer pins (#1383)', () => {
      // splitBisacPath collapses a parent-prefixed path to its leaf — pin exact
      // output for all three new parents so a future parent-batch edit can't
      // silently alter BISAC output (the unpinned change from #1322).
      const BISAC_PINS: [string, string[]][] = [
        ['Science Fiction & Fantasy / Space Opera', ['Space Opera']],
        ['Literature & Fiction / Classics', ['Classics']],
        ['Mystery, Thriller & Suspense / Crime Thrillers', ['Crime Thrillers']],
      ];

      it.each(BISAC_PINS)('splits "%s" to exact output', (path, expected) => {
        expect(normalizeGenres([path])).toEqual(expected);
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

  // Every harvested GENRE_CHILDREN entry must register as "known" so it stops
  // polluting the tracking table. Deleting any entry from the set fails its row.
  const HARVESTED_CHILDREN = [
    'Space Opera', 'Hard Science Fiction', 'Sword & Sorcery', 'Military',
    'Classics', "Women's Fiction", 'Family Life', 'Psychological',
    'Domestic Thrillers', 'Crime Thrillers', 'Espionage', 'Fairy Tales',
    'Superhero', 'Dragons & Mythical Creatures', 'Sagas', 'World Literature',
    "Children's",
  ];

  it.each(HARVESTED_CHILDREN)('treats harvested child "%s" as known (#1322)', (child) => {
    expect(findUnmatchedGenres([child])).toEqual([]);
  });

  // Every harvested DROP_GENRES key is "known" for defense in depth — a raw
  // dropped genre passed directly to tracking returns []. Deleting any key fails.
  const DROPPED_KEYS = [
    'genre fiction',
    'movie, tv & video game tie-ins',
    'united states',
    'difficult situations',
  ];

  it.each(DROPPED_KEYS)('treats raw dropped genre "%s" as known (#1322)', (dropped) => {
    expect(findUnmatchedGenres([dropped])).toEqual([]);
  });

  it('reports no unmatched genres across the full harvested AC corpus (#1322)', () => {
    const raw = [
      'Science Fiction & Fantasy', 'Space Opera',
      'Literature & Fiction', 'Mystery, Thriller & Suspense', 'Crime Thrillers',
      'Teen & Young Adult', 'Epic', 'Fantasy',
      'Genre Fiction', 'Thriller & Suspense',
    ];
    // Pin the EXACT normalized output, not just tracking emptiness — the
    // tracking-only check passes even if the pipeline regresses (e.g. parent
    // removal disabled entirely). (#1383)
    expect(normalizeGenres(raw)).toEqual([
      'Space Opera', 'Crime Thrillers', 'Young Adult', 'Epic Fantasy', 'Fantasy', 'Thriller',
    ]);
    expect(findUnmatchedGenres(normalizeGenres(raw))).toEqual([]);
  });
});
