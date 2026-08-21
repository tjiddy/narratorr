import { describe, it, expect } from 'vitest';
import {
  normalizeGenres,
  findUnmatchedGenres,
  inferGenresFromTitleMarkers,
  mergeInferredGenres,
} from './genres.js';

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
    // Exhaustive pins make every harvested drop key mutation-visible.
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
      // Exhaustive pins make every harvested synonym mutation-visible.
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
      // Each marker must block the otherwise valid Historical Fiction remap.
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

      // Generic parents survive alone but are still known to unmatched tracking.
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
      // Pin the generic-parent set's second consumer: BISAC leaf extraction.
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

      expect(result).toContain('Fantasy');
      expect(result).toContain('Science Fiction');
      expect(result).toContain('Adventure');
      expect(result).toContain('Historical Fantasy');
      expect(result).toContain('Epic Fantasy');

      expect(result).not.toContain('Fiction');
      expect(result).not.toContain('Science Fiction & Fantasy');

      const lowerSet = result!.map((g) => g.toLowerCase());
      expect(new Set(lowerSet).size).toBe(lowerSet.length);
    });
  });
});

describe('findUnmatchedGenres', () => {
  it('identifies genres not in any known list', () => {
    const unmatched = findUnmatchedGenres(['Fantasy', 'Cozy Mystery', 'Progression Fantasy']);

    expect(unmatched).not.toContain('Fantasy');
    expect(unmatched).toContain('Cozy Mystery');
    // #2535 made Progression Fantasy canonical; Cozy Mystery keeps the genuinely-unknown arm honest.
    expect(unmatched).not.toContain('Progression Fantasy');
  });

  it('returns empty for null input', () => {
    expect(findUnmatchedGenres(null)).toEqual([]);
  });

  it('returns empty when all genres are known', () => {
    const result = findUnmatchedGenres(['Fantasy', 'Science Fiction']);
    expect(result).toEqual([]);
  });

  it('does not flag synonym keys or BISAC paths once normalized', () => {
    const raw = ['Sci-Fi', 'Fiction / Fantasy / Epic', 'Fiction'];
    const result = findUnmatchedGenres(normalizeGenres(raw));
    expect(result).toEqual([]);
  });

  it('flags only the genuinely unknown genre from a mixed raw list', () => {
    const raw = ['Sci-Fi', 'Weird Western'];
    const result = findUnmatchedGenres(normalizeGenres(raw));
    expect(result).toEqual(['Weird Western']);
  });

  // Exhaustive pins keep every harvested child out of unmatched tracking.
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

  // Exhaustive pins keep every dropped key out of unmatched tracking.
  const DROPPED_KEYS = [
    'genre fiction',
    'movie, tv & video game tie-ins',
    'united states',
    'difficult situations',
  ];

  it.each(DROPPED_KEYS)('treats raw dropped genre "%s" as known (#1322)', (dropped) => {
    expect(findUnmatchedGenres([dropped])).toEqual([]);
  });

  describe("context-gated 'historical' tracking defense (#1383, #1405)", () => {
    it('does not track gated historical alongside History (AC1)', () => {
      expect(findUnmatchedGenres(normalizeGenres(['Historical', 'History']))).toEqual([]);
    });

    it('excludes the bare historical token, case-insensitively', () => {
      expect(findUnmatchedGenres(['Historical'])).toEqual([]);
      expect(findUnmatchedGenres(['HISTORICAL'])).toEqual([]);
    });

    it('keeps the two non-child markers tracked by design (AC3)', () => {
      // These gate inputs intentionally remain unmatched provider signals.
      expect(findUnmatchedGenres(['Biographies & Memoirs'])).toEqual(['Biographies & Memoirs']);
      expect(findUnmatchedGenres(['Computers & Technology'])).toEqual(['Computers & Technology']);
      expect(findUnmatchedGenres(['History'])).toEqual([]);
    });

    it('leaves the remap path unchanged — tracking-only defense (AC2)', () => {
      expect(normalizeGenres(['Historical'])).toEqual(['Historical Fiction']);
      expect(normalizeGenres(['Historical', 'Fantasy'])).toContain('Historical Fiction');
    });
  });

  it('reports no unmatched genres across the full harvested AC corpus (#1322)', () => {
    const raw = [
      'Science Fiction & Fantasy', 'Space Opera',
      'Literature & Fiction', 'Mystery, Thriller & Suspense', 'Crime Thrillers',
      'Teen & Young Adult', 'Epic', 'Fantasy',
      'Genre Fiction', 'Thriller & Suspense',
    ];
    // Exact output catches pipeline regressions that tracking emptiness cannot.
    expect(normalizeGenres(raw)).toEqual([
      'Space Opera', 'Crime Thrillers', 'Young Adult', 'Epic Fantasy', 'Fantasy', 'Thriller',
    ]);
    expect(findUnmatchedGenres(normalizeGenres(raw))).toEqual([]);
  });
});

// #2535: Audible's category ladder never carries a litRPG-family string, so the title/subtitle
// marker publishers fall back on is the only signal that exists.
describe('inferGenresFromTitleMarkers', () => {
  describe('positive — one marked field at a time', () => {
    it('reads a marker in the title', () => {
      expect(inferGenresFromTitleMarkers('Mage Tank 2: A LitRPG Adventure', null, null)).toEqual(['LitRPG']);
    });

    it('reads a marker in the subtitle', () => {
      expect(inferGenresFromTitleMarkers('Mage Tank 2', 'A LitRPG Saga (Chaos Seeds, Book 8)', null)).toEqual(['LitRPG']);
    });

    it('reads a marker in the series name', () => {
      expect(inferGenresFromTitleMarkers('Book One', null, 'The Land: Founding: A LitRPG Saga')).toEqual(['LitRPG']);
    });
  });

  describe('positive — one case per marker-table row', () => {
    it('maps litrpg', () => {
      expect(inferGenresFromTitleMarkers('A LitRPG Adventure', null, null)).toEqual(['LitRPG']);
    });

    it('maps gamelit', () => {
      expect(inferGenresFromTitleMarkers('A GameLit Adventure', null, null)).toEqual(['GameLit']);
    });

    it('maps progression fantasy', () => {
      expect(inferGenresFromTitleMarkers('A Progression Fantasy Epic', null, null)).toEqual(['Progression Fantasy']);
    });

    it('maps dungeon core onto LitRPG — the one cross-mapping', () => {
      expect(inferGenresFromTitleMarkers('A Dungeon Core Story', null, null)).toEqual(['LitRPG']);
    });

    it('reads both sides of a slash-joined pair', () => {
      expect(inferGenresFromTitleMarkers('A LitRPG/Gamelit Adventure', null, null)).toEqual(['LitRPG', 'GameLit']);
    });

    it('does not let progression fantasy imply LitRPG', () => {
      expect(inferGenresFromTitleMarkers('A Progression Fantasy Epic', null, null)).not.toContain('LitRPG');
    });
  });

  describe('case and separator variants', () => {
    it.each(['litrpg', 'LITRPG', 'LitRpg', 'Lit RPG', 'Lit-RPG', 'LitRPGs'])(
      'accepts %s as LitRPG',
      (variant) => {
        expect(inferGenresFromTitleMarkers(`A ${variant} Adventure`, null, null)).toEqual(['LitRPG']);
      },
    );

    it.each(['GameLit', 'Game Lit', 'Game-Lit', 'gamelits'])('accepts %s as GameLit', (variant) => {
      expect(inferGenresFromTitleMarkers(`A ${variant} Adventure`, null, null)).toEqual(['GameLit']);
    });
  });

  describe('negatives', () => {
    it.each([
      'Moonlit RPG Nights',
      'Dungeon Crawler Carl',
      'The Dungeon Corridor',
      'Splitrpg',
      'Game Little Things',
    ])('refuses %s', (title) => {
      expect(inferGenresFromTitleMarkers(title, null, null)).toEqual([]);
    });

    // AC6: bare tokens false-positive on ordinary titles, so the table admits none of them.
    it.each(['cultivation', 'system', 'rpg', 'game', 'progression', 'dungeon', 'core'])(
      'refuses the bare token %s',
      (token) => {
        expect(inferGenresFromTitleMarkers(`The ${token} of Things`, null, null)).toEqual([]);
      },
    );
  });

  describe('null and missing fields', () => {
    it('accepts three undefined arguments', () => {
      expect(inferGenresFromTitleMarkers(undefined, undefined, undefined)).toEqual([]);
    });

    it('accepts three null arguments', () => {
      expect(inferGenresFromTitleMarkers(null, null, null)).toEqual([]);
    });

    it('accepts empty and whitespace-only strings', () => {
      expect(inferGenresFromTitleMarkers('', '   ', '')).toEqual([]);
    });

    it('matches the third field when the first two are absent', () => {
      expect(inferGenresFromTitleMarkers(undefined, null, 'A LitRPG Saga')).toEqual(['LitRPG']);
    });
  });

  describe('dedup and ordering', () => {
    it('yields a genre once when title and subtitle both carry the marker', () => {
      expect(inferGenresFromTitleMarkers('A LitRPG Adventure', 'A LitRPG Saga', null)).toEqual(['LitRPG']);
    });

    it('yields a genre once when two patterns map to it', () => {
      expect(inferGenresFromTitleMarkers('A LitRPG Dungeon Core Tale', null, null)).toEqual(['LitRPG']);
    });

    // AC4: marker-table declaration order, not the order the fields matched in.
    it('orders by the marker table, not by input field', () => {
      expect(inferGenresFromTitleMarkers('A Progression Fantasy Epic', 'A LitRPG Saga', null))
        .toEqual(['LitRPG', 'Progression Fantasy']);
    });
  });

  // AC5: a hoisted regex carrying `g` advances lastIndex, so the second call would miss.
  it('returns identical results on a repeated call with identical input', () => {
    const first = inferGenresFromTitleMarkers('A LitRPG/Gamelit Adventure', 'A Progression Fantasy Saga', null);
    const second = inferGenresFromTitleMarkers('A LitRPG/Gamelit Adventure', 'A Progression Fantasy Saga', null);
    expect(second).toEqual(first);
    expect(second).toEqual(['LitRPG', 'GameLit', 'Progression Fantasy']);
  });
});

describe('mergeInferredGenres', () => {
  it('appends to a populated list without disturbing it', () => {
    const existing = ['Humor', 'Fantasy', 'Action & Adventure', 'Epic Fantasy', 'Satire'];
    const merged = mergeInferredGenres(existing, ['LitRPG']);

    expect(merged.changed).toBe(true);
    expect(merged.genres).toEqual(['Humor', 'Fantasy', 'Action & Adventure', 'Epic Fantasy', 'Satire', 'LitRPG']);
  });

  // AC7: the comparison is case-insensitive, but a stored value keeps its own casing.
  it('treats a differently-cased existing entry as present and preserves its casing', () => {
    const merged = mergeInferredGenres(['litrpg'], ['LitRPG']);

    expect(merged.changed).toBe(false);
    expect(merged.genres).toEqual(['litrpg']);
  });

  it('produces the inferred list from an absent or empty existing value', () => {
    expect(mergeInferredGenres(undefined, ['LitRPG'])).toEqual({ genres: ['LitRPG'], changed: true });
    expect(mergeInferredGenres([], ['LitRPG'])).toEqual({ genres: ['LitRPG'], changed: true });
    expect(mergeInferredGenres(null, ['LitRPG'])).toEqual({ genres: ['LitRPG'], changed: true });
  });

  // AC11: books.genres is nullable and an empty array is a clear signal, so absent must stay absent.
  it('reports no change and does not manufacture an empty array when nothing was inferred', () => {
    const merged = mergeInferredGenres(undefined, []);

    expect(merged.changed).toBe(false);
    expect(merged.genres).toBeUndefined();
  });

  it('is idempotent', () => {
    const once = mergeInferredGenres(['Fantasy'], ['LitRPG']);
    const twice = mergeInferredGenres(once.genres, ['LitRPG']);

    expect(twice.changed).toBe(false);
    expect(twice.genres).toEqual(once.genres);
  });

  // AC8: no re-normalization — a parent the taxonomy would collapse survives a marker write.
  it('never removes an existing entry', () => {
    const merged = mergeInferredGenres(['Fiction', 'LitRPG'], ['LitRPG']);

    expect(merged.changed).toBe(false);
    expect(merged.genres).toEqual(['Fiction', 'LitRPG']);
  });

  it('appends only the inferred genres the list is missing', () => {
    const merged = mergeInferredGenres(['LitRPG'], ['LitRPG', 'GameLit']);

    expect(merged.changed).toBe(true);
    expect(merged.genres).toEqual(['LitRPG', 'GameLit']);
  });
});

describe('litRPG-family taxonomy (#2535)', () => {
  it.each([
    [['GameLit'], 'GameLit'],
    [['Game Lit'], 'GameLit'],
    [['Progression Fantasy'], 'Progression Fantasy'],
    [['Dungeon Core'], 'LitRPG'],
  ])('normalizes %j to %s', (raw, canonical) => {
    expect(normalizeGenres(raw as string[])).toEqual([canonical]);
  });

  it.each(['GameLit', 'Progression Fantasy', 'LitRPG'])('does not flag %s as unmatched', (genre) => {
    expect(findUnmatchedGenres(normalizeGenres([genre]))).toEqual([]);
  });

  it.each([
    ['Fiction', 'GameLit'],
    ['Fiction', 'Progression Fantasy'],
    ['Science Fiction & Fantasy', 'LitRPG'],
  ])('drops the generic parent %s beside %s', (parent, child) => {
    const result = normalizeGenres([parent, child]);
    expect(result).toEqual([child]);
  });
});
