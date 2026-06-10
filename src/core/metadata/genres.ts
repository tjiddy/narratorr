/**
 * Genre normalization — cleans noisy metadata provider genres into
 * consistent, meaningful tags.
 */

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
  // Audible category-taxonomy strings harvested from unmatched_genres (#1322)
  ['teen & young adult', 'Young Adult'],
  ['epic', 'Epic Fantasy'],
  ['comedy & humor', 'Humor'],
  ['humorous', 'Humor'],
  ['paranormal & urban', 'Urban Fantasy'],
  ['thriller & suspense', 'Thriller'],
  ['fantasy & magic', 'Fantasy'],
  ["children's audiobooks", "Children's"],
  // NOTE: bare 'historical' is NOT a static synonym — it is context-gated in
  // normalizeGenres (step 2b) so it maps to 'Historical Fiction' only when no
  // non-fiction marker co-occurs. See NONFICTION_HISTORICAL_MARKERS (#1383).
]);

/**
 * Non-fiction context markers (lowercase). Audible files non-fiction
 * "Historical" categories under these parents (Biographies & Memoirs, History,
 * Computers & Technology). When any co-occurs in the same genre array, a bare
 * 'historical' entry is a non-fiction descriptor and must NOT be remapped to
 * the fiction-side 'Historical Fiction' — doing so fabricates a wrong fiction
 * label on narrative non-fiction (#1383, live-verified on Endurance B002V9ZA6C).
 */
const NONFICTION_HISTORICAL_MARKERS = new Set([
  'biographies & memoirs',
  'history',
  'computers & technology',
]);

/**
 * Non-genres to delete outright during normalization — pure noise that
 * carries no meaning even when it's the only signal. Unlike GENERIC_PARENTS
 * (removed only when a known child is present), DROP_GENRES is always removed.
 * Keys are lowercase. Harvested from unmatched_genres (#1322).
 */
const DROP_GENRES = new Set([
  'genre fiction',
  'movie, tv & video game tie-ins',
  'united states',
  'difficult situations',
]);

/**
 * Generic parent genres that should be removed when children exist.
 * Dual consumer: `splitBisacPath` (BISAC leaf extraction — a generic parent
 * collapses a path to its leaf) AND `removeGenericParents` (step-6 parent
 * removal). Editing this set changes both behaviors; pin both when adding keys.
 */
const GENERIC_PARENTS = new Set([
  'fiction',
  'non-fiction',
  'nonfiction',
  'juvenile fiction',
  'juvenile nonfiction',
  // Audible category parents harvested from unmatched_genres (#1322) —
  // removed only when a recognized GENRE_CHILDREN member is present.
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
  // Audible fiction subcategories harvested from unmatched_genres (#1322)
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
 * Split a BISAC-style path ("Fiction / Fantasy / Epic") into a meaningful genre.
 *
 * Rules:
 * - "Fiction / Fantasy / Epic" → "Epic Fantasy" (leaf + parent context)
 * - "Fiction / Fantasy / General" → "Fantasy" (drop "General" leaf)
 * - "Fiction / Fantasy" → "Fantasy" (drop generic parent)
 * - "Fiction" → "Fiction" (kept, will be removed later by parent filter if children exist)
 */
function splitBisacPath(genre: string): string {
  const parts = genre.split(/\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return genre.trim();

  const leaf = parts[parts.length - 1]!;
  const parent = parts[parts.length - 2]!;

  // Drop "General" leaf
  if (leaf.toLowerCase() === 'general') {
    // If only "Fiction / Fantasy / General", return "Fantasy"
    // If just "Fiction / General", return "Fiction"
    return parts.length > 2 ? parts[parts.length - 2]! : parts[0]!;
  }

  // If parent is a generic category, combine leaf with context
  if (GENERIC_PARENTS.has(parent.toLowerCase())) {
    return leaf;
  }

  // Combine leaf with parent for context: "Epic" + "Fantasy" → "Epic Fantasy"
  // But only if the leaf isn't already descriptive enough
  if (leaf.toLowerCase() !== parent.toLowerCase()) {
    return `${leaf} ${parent}`;
  }

  return leaf;
}

/**
 * Remove compound genres when their components exist separately.
 * e.g., "Science Fiction & Fantasy" is redundant if both
 * "Science Fiction" and "Fantasy" are present.
 *
 * INVARIANT — remove-only: this function never rewrites, splits, or emits a
 * genre, it only drops compounds whose every component already exists. Several
 * compound-shaped GENERIC_PARENTS (e.g. "Science Fiction & Fantasy",
 * "Mystery, Thriller & Suspense") rely on this: a splitter rewrite here would
 * fragment those parents and break the parent-removal lists. Keep it a filter.
 */
function removeCompounds(genres: string[]): string[] {
  const lowerSet = new Set(genres.map((g) => g.toLowerCase()));

  return genres.filter((genre) => {
    // Check for "X & Y" or "X and Y" patterns
    const parts = genre.split(/\s+&\s+|\s+and\s+/i);
    if (parts.length < 2) return true;

    // If all component parts exist separately, remove the compound
    const allPartsExist = parts.every((part) =>
      lowerSet.has(part.trim().toLowerCase()),
    );
    return !allPartsExist;
  });
}

/**
 * Remove generic parent genres when more specific children exist.
 * e.g., "Fiction" is redundant when "Fantasy" is present.
 */
function removeGenericParents(genres: string[]): string[] {
  const lowerSet = new Set(genres.map((g) => g.toLowerCase()));
  const hasChild = [...lowerSet].some((g) => GENRE_CHILDREN.has(g));

  if (!hasChild) return genres;

  return genres.filter((genre) => !GENERIC_PARENTS.has(genre.toLowerCase()));
}

/**
 * Normalize an array of raw genre strings from a metadata provider.
 *
 * Rules applied in order:
 * 1. Split BISAC paths
 * 2. Apply synonym map
 * 2b. Context-gate bare 'historical' → 'Historical Fiction'
 * 3. Drop pure-noise non-genres
 * 4. Deduplicate (case-insensitive, preserves first occurrence)
 * 5. Remove compound genres when components exist separately
 * 6. Remove generic parent genres when children exist
 */
export function normalizeGenres(genres: string[] | undefined | null): string[] | undefined {
  if (!genres || genres.length === 0) return undefined;

  // Step 1: Split BISAC paths
  let result = genres.map(splitBisacPath);

  // Step 2: Apply synonym map
  result = result.map((genre) => {
    const normalized = SYNONYM_MAP.get(genre.toLowerCase());
    return normalized ?? genre;
  });

  // Step 2b: Context-gate bare 'historical'. Both a raw 'Historical' entry and
  // a BISAC 'Fiction / Historical' path (collapsed to 'Historical' in step 1)
  // become the fiction-side 'Historical Fiction' — but only when no non-fiction
  // marker co-occurs in the same array. Audible files non-fiction "Historical"
  // under Biographies & Memoirs / History / Computers & Technology, where the
  // remap would fabricate a wrong fiction label (#1383).
  const hasNonfictionMarker = result.some((g) =>
    NONFICTION_HISTORICAL_MARKERS.has(g.toLowerCase()),
  );
  if (!hasNonfictionMarker) {
    result = result.map((genre) =>
      genre.toLowerCase() === 'historical' ? 'Historical Fiction' : genre,
    );
  }

  // Step 3: Drop pure-noise non-genres (after synonym mapping so a synonym
  // can never map into a dropped key, and before dedup so dropped entries
  // don't occupy dedup slots).
  result = result.filter((genre) => !DROP_GENRES.has(genre.toLowerCase()));

  // Step 4: Deduplicate (case-insensitive, keep first occurrence)
  const seen = new Set<string>();
  result = result.filter((genre) => {
    const lower = genre.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });

  // Step 5: Remove compounds
  result = removeCompounds(result);

  // Step 6: Remove generic parents
  result = removeGenericParents(result);

  return result.length > 0 ? result : undefined;
}

/**
 * Identify genres that passed through normalization without being
 * transformed by any rule. These are candidates for adding to the
 * synonym map.
 */
export function findUnmatchedGenres(
  normalized: string[] | undefined | null,
): string[] {
  if (!normalized) return [];

  // Genres that survived normalization unchanged (not in synonym map,
  // not a BISAC path, not a known parent/compound)
  return normalized.filter((genre) => {
    const lower = genre.toLowerCase();
    // If it's in the synonym map target values, it was mapped
    for (const [, value] of SYNONYM_MAP) {
      if (value.toLowerCase() === lower) return false;
    }
    // If it's a known fiction child, it's "known"
    if (GENRE_CHILDREN.has(lower)) return false;
    // If it's a generic parent, it's "known"
    if (GENERIC_PARENTS.has(lower)) return false;
    // If it's a dropped non-genre, it's "known" (removed by normalizeGenres
    // before it ever reaches tracking; checked here for defense in depth).
    if (DROP_GENRES.has(lower)) return false;
    // Otherwise it passed through unmatched
    return true;
  });
}
