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
]);

/** Generic parent genres that should be removed when children exist */
const GENERIC_PARENTS = new Set([
  'fiction',
  'non-fiction',
  'nonfiction',
  'juvenile fiction',
  'juvenile nonfiction',
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
 * 3. Deduplicate (case-insensitive, preserves first occurrence)
 * 4. Remove compound genres when components exist separately
 * 5. Remove generic parent genres when children exist
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

  // Step 3: Deduplicate (case-insensitive, keep first occurrence)
  const seen = new Set<string>();
  result = result.filter((genre) => {
    const lower = genre.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });

  // Step 4: Remove compounds
  result = removeCompounds(result);

  // Step 5: Remove generic parents
  result = removeGenericParents(result);

  return result.length > 0 ? result : undefined;
}

/**
 * Identify genres that passed through normalization without being
 * transformed by any rule. These are candidates for adding to the
 * synonym map.
 */
export function findUnmatchedGenres(
  _raw: string[] | undefined | null,
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
    // Otherwise it passed through unmatched
    return true;
  });
}
