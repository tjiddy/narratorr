/** Canonical synonyms: key (lowercase) → normalized form */
const SYNONYM_MAP = new Map<string, string>([
  ['sci-fi', 'Science Fiction'],
  ['scifi', 'Science Fiction'],
  ['sf', 'Science Fiction'],
  ['nonfiction', 'Non-Fiction'],
  ['non fiction', 'Non-Fiction'],
  ['lit rpg', 'LitRPG'],
  ['litrpg', 'LitRPG'],
  // Provider-side twins of the #2535 title markers, so a string that ever does arrive from a
  // provider normalizes to the value the inference already produces.
  ['gamelit', 'GameLit'],
  ['game lit', 'GameLit'],
  ['progression fantasy', 'Progression Fantasy'],
  ['dungeon core', 'LitRPG'],
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
  'young adult', 'litrpg', 'gamelit', 'progression fantasy',
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

/**
 * Genre markers that reach us only inside a title, subtitle or series name, because Audible's
 * category ladder never emits a litRPG-family string at all (#2535). Each pattern maps to exactly
 * one canonical genre, and declaration order is the output order.
 *
 * Precision over recall by construction: no bare `system`/`cultivation`/`rpg` token is admissible —
 * those false-positive on ordinary titles, while nobody titles a non-litRPG book "A LitRPG
 * Adventure". Every pattern carries `i` and never `g`: a hoisted global regex advances `lastIndex`
 * between calls, so the same input would stop matching on the second call.
 */
const TITLE_GENRE_MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\blit[\s-]?rpgs?\b/i, 'LitRPG'],
  [/\bgame[\s-]?lits?\b/i, 'GameLit'],
  [/\bprogression fantasy\b/i, 'Progression Fantasy'],
  // The one cross-mapping: dungeon core is a LitRPG subgenre with no independent shelf value.
  [/\bdungeon core\b/i, 'LitRPG'],
];

/** Canonical genres a book's own text advertises; empty when nothing matched. Pure. */
export function inferGenresFromTitleMarkers(
  title?: string | null,
  subtitle?: string | null,
  seriesName?: string | null,
): string[] {
  const fields = [title, subtitle, seriesName].filter((value): value is string => !!value);
  if (fields.length === 0) return [];

  const matched: string[] = [];
  for (const [pattern, genre] of TITLE_GENRE_MARKERS) {
    if (matched.includes(genre)) continue;
    if (fields.some((field) => pattern.test(field))) matched.push(genre);
  }
  return matched;
}

export interface InferredGenreMerge {
  /** `undefined` is preserved rather than widened to `[]`, which the tombstone recompute reads as a clear. */
  genres: string[] | undefined;
  changed: boolean;
}

/**
 * Append-only merge of marker-inferred genres onto whatever is already stored: missing entries land
 * at the end, and nothing existing is removed, reordered or re-cased. Deliberately does NOT re-run
 * `normalizeGenres` — a stored value may be an operator edit, and a marker write must not rewrite it.
 */
export function mergeInferredGenres(
  existing: readonly string[] | null | undefined,
  inferred: readonly string[],
): InferredGenreMerge {
  const unchanged = { genres: existing ? [...existing] : undefined, changed: false };
  if (inferred.length === 0) return unchanged;

  const seen = new Set((existing ?? []).map((genre) => genre.toLowerCase()));
  const additions = inferred.filter((genre) => {
    const lower = genre.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
  if (additions.length === 0) return unchanged;

  return { genres: [...(existing ?? []), ...additions], changed: true };
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
