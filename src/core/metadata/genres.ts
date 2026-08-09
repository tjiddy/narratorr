/** Canonical synonyms: key (lowercase) → normalized form */
const SYNONYM_MAP = new Map<string, string>([
  ['sci-fi', 'Science Fiction'],
  ['scifi', 'Science Fiction'],
  ['sf', 'Science Fiction'],
  ['nonfiction', 'Non-Fiction'],
  ['non fiction', 'Non-Fiction'],
  ['lit rpg', 'LitRPG'],
  ['litrpg', 'LitRPG'],
  ['ya', 'Young Adult'],
  ['young adult fiction', 'Young Adult'],
  ['hi-fi', 'High Fantasy'],
  ['high fantasy fiction', 'High Fantasy'],
  ['urban fantasy fiction', 'Urban Fantasy'],
  ['epic fantasy fiction', 'Epic Fantasy'],
  ['action & adventure', 'Action & Adventure'],
  ['action and adventure', 'Action & Adventure'],
  ['self help', 'Self-Help'],
  ['self-improvement', 'Self-Help'],
  ['true crime', 'True Crime'],
  ['teen & young adult', 'Young Adult'],
  ['epic', 'Epic Fantasy'],
  ['comedy & humor', 'Humor'],
  ['humorous', 'Humor'],
  ['paranormal & urban', 'Urban Fantasy'],
  ['thriller & suspense', 'Thriller'],
  ['fantasy & magic', 'Fantasy'],
  ["children's audiobooks", "Children's"],
  // Bare historical is context-dependent; do not add it as a static synonym.
]);

/**
 * Raw markers that prevent bare `Historical` from becoming `Historical Fiction`.
 * Keep them out of SYNONYM_MAP: matching occurs after synonym replacement, and two
 * markers intentionally remain unmatched because they carry useful provider signal.
 */
const NONFICTION_HISTORICAL_MARKERS = new Set([
  'biographies & memoirs',
  'history',
  'computers & technology',
]);

/** Always-removed noise, unlike generic parents that survive without a child. */
const DROP_GENRES = new Set([
  'genre fiction',
  'movie, tv & video game tie-ins',
  'united states',
  'difficult situations',
]);

/** Shared by BISAC leaf extraction and redundant-parent removal. */
const GENERIC_PARENTS = new Set([
  'fiction',
  'non-fiction',
  'nonfiction',
  'juvenile fiction',
  'juvenile nonfiction',
  'science fiction & fantasy',
  'literature & fiction',
  'mystery, thriller & suspense',
]);

/** Known child genres that make their parent redundant */
const GENRE_CHILDREN = new Set([
  // Fiction children
  'fantasy', 'science fiction', 'mystery', 'thriller', 'romance',
  'horror', 'historical fiction', 'literary fiction', 'adventure',
  'crime', 'suspense', 'drama', 'humor', 'satire', 'western',
  'dystopian', 'urban fantasy', 'epic fantasy', 'high fantasy',
  'dark fantasy', 'paranormal', 'contemporary', 'action & adventure',
  'young adult', 'litrpg',
  'space opera', 'hard science fiction', 'sword & sorcery', 'military',
  'classics', "women's fiction", 'family life', 'psychological',
  'domestic thrillers', 'crime thrillers', 'espionage', 'fairy tales',
  'superhero', 'dragons & mythical creatures', 'sagas', 'world literature',
  "children's",
  // Non-fiction children
  'true crime', 'biography', 'autobiography', 'memoir', 'history',
  'science', 'philosophy', 'psychology', 'self-help', 'travel',
  'politics', 'business', 'economics', 'technology',
]);

/**
 * Collapses BISAC paths: discard a `General` leaf, drop generic parents, and retain
 * non-generic parent context such as `Fantasy / Epic` → `Epic Fantasy`.
 */
function splitBisacPath(genre: string): string {
  const parts = genre.split(/\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return genre.trim();

  const leaf = parts[parts.length - 1]!;
  const parent = parts[parts.length - 2]!;

  if (leaf.toLowerCase() === 'general') {
    return parts.length > 2 ? parts[parts.length - 2]! : parts[0]!;
  }

  if (GENERIC_PARENTS.has(parent.toLowerCase())) {
    return leaf;
  }

  // Preserve non-generic parent context unless the leaf already repeats it.
  if (leaf.toLowerCase() !== parent.toLowerCase()) {
    return `${leaf} ${parent}`;
  }

  return leaf;
}

/** Remove-only filter: drops compounds only when every component already exists. */
function removeCompounds(genres: string[]): string[] {
  const lowerSet = new Set(genres.map((g) => g.toLowerCase()));

  return genres.filter((genre) => {
    const parts = genre.split(/\s+&\s+|\s+and\s+/i);
    if (parts.length < 2) return true;

    const allPartsExist = parts.every((part) =>
      lowerSet.has(part.trim().toLowerCase()),
    );
    return !allPartsExist;
  });
}

/** Removes generic parents only when a known child is present. */
function removeGenericParents(genres: string[]): string[] {
  const lowerSet = new Set(genres.map((g) => g.toLowerCase()));
  const hasChild = [...lowerSet].some((g) => GENRE_CHILDREN.has(g));

  if (!hasChild) return genres;

  return genres.filter((genre) => !GENERIC_PARENTS.has(genre.toLowerCase()));
}

export function normalizeGenres(genres: string[] | undefined | null): string[] | undefined {
  if (!genres || genres.length === 0) return undefined;

  let result = genres.map(splitBisacPath);

  result = result.map((genre) => {
    const normalized = SYNONYM_MAP.get(genre.toLowerCase());
    return normalized ?? genre;
  });

  // Bare Historical is fiction only when no raw non-fiction marker survives mapping.
  const hasNonfictionMarker = result.some((g) =>
    NONFICTION_HISTORICAL_MARKERS.has(g.toLowerCase()),
  );
  if (!hasNonfictionMarker) {
    result = result.map((genre) =>
      genre.toLowerCase() === 'historical' ? 'Historical Fiction' : genre,
    );
  }

  // Drop noise after mapping but before it can occupy a deduplication slot.
  result = result.filter((genre) => !DROP_GENRES.has(genre.toLowerCase()));

  const seen = new Set<string>();
  result = result.filter((genre) => {
    const lower = genre.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });

  result = removeCompounds(result);

  result = removeGenericParents(result);

  return result.length > 0 ? result : undefined;
}

/** Returns normalized genres no rule handled, for synonym-map telemetry. */
export function findUnmatchedGenres(
  normalized: string[] | undefined | null,
): string[] {
  if (!normalized) return [];

  return normalized.filter((genre) => {
    const lower = genre.toLowerCase();
    for (const [, value] of SYNONYM_MAP) {
      if (value.toLowerCase() === lower) return false;
    }
    if (GENRE_CHILDREN.has(lower)) return false;
    if (GENERIC_PARENTS.has(lower)) return false;
    if (DROP_GENRES.has(lower)) return false;
    // A deliberately gated Historical value is handled, even when left unchanged.
    if (lower === 'historical') return false;
    return true;
  });
}
