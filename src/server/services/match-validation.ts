import { diceCoefficient } from '../../core/utils/similarity.js';
import type { BookMetadata } from '../../core/metadata/types.js';

/** Title fuzzy threshold for the search-candidate path (Dice coefficient). */
export const TITLE_MATCH_THRESHOLD = 0.7;

/**
 * Stricter title threshold for the **no-author** path. A title-only match has no
 * author corroboration, and the resolver writes the matched ASIN back onto the
 * row (scheduled enrichment, manual/background enrichment, import-list creation),
 * so a fuzzy title alone must not be enough to lock an ASIN. A common/ambiguous
 * title (different edition, same-title different-author, an anthology) that clears
 * only the loose 0.7 gate would otherwise write a wrong ASIN + wrong metadata.
 * Requiring a near-exact title keeps that decision inside the shared gate, so all
 * three writeback surfaces are protected automatically. See #1629.
 */
export const NO_AUTHOR_TITLE_MATCH_THRESHOLD = 0.85;

/** Minimal identity an item needs for {@link matchPassesValidation}. */
export interface MatchValidationItem {
  title: string;
  author?: string | undefined;
}

/**
 * AND-gate for adopting a fuzzy search candidate (the search-fallback path,
 * shared by the import-list add flow and the background enrichment job so the
 * two apply the **same** validation policy).
 *
 * **No-author path:** dice(item.title, candidate.title) ≥
 * {@link NO_AUTHOR_TITLE_MATCH_THRESHOLD} (near-exact title required, since
 * nothing else gates the ASIN writeback — see #1629).
 *
 * **Author-present path:** author overlap is confirmed **first** (the hard
 * requirement — a genuinely different book stays out), then the title passes via
 * `dice ≥ {@link TITLE_MATCH_THRESHOLD}` **OR** significant-token containment.
 * Containment accepts a verbose/subtitle form of the same title when the author
 * corroborates — e.g. "The Hobbit, or There and Back Again" / Tolkien against a
 * "The Hobbit" / Tolkien candidate (dice ≈ 0.42 < 0.7, but `{hobbit} ⊆ {hobbit,
 * there, back}`). This may occasionally accept a same-work *different-edition*
 * (anniversary/dramatized), which is acceptable and recoverable via Fix Match;
 * the still-required author overlap keeps the *wrong book* out. See #1636.
 *
 * If either required check fails → reject. Prevents "Golden Son by Pierce Brown"
 * cover/series getting attached to an entry that's actually "Golden Son by Some
 * Romance Author".
 */
export function matchPassesValidation(item: MatchValidationItem, candidate: BookMetadata): boolean {
  const titleDice = diceCoefficient(item.title, candidate.title);
  if (!item.author) return titleDice >= NO_AUTHOR_TITLE_MATCH_THRESHOLD;
  // Author-present path: author is the hard guard, confirmed before the title.
  const candidateAuthors = candidate.authors?.map((a) => a.name).filter(Boolean) ?? [];
  if (candidateAuthors.length === 0) return false;
  if (!candidateAuthors.some((name) => authorOverlap(item.author!, name))) return false;
  return titleDice >= TITLE_MATCH_THRESHOLD || titleContainment(item.title, candidate.title);
}

export function authorOverlap(a: string, b: string): boolean {
  const aLower = a.trim().toLowerCase();
  const bLower = b.trim().toLowerCase();
  if (!aLower || !bLower) return false;
  if (aLower === bLower) return true;
  // Last-name overlap (last whitespace-delimited token)
  const aLast = aLower.split(/\s+/).pop()!;
  const bLast = bLower.split(/\s+/).pop()!;
  return aLast.length > 1 && aLast === bLast;
}

/**
 * Stopwords dropped before significant-token containment. Articles, conjunctions,
 * prepositions, and "book"/"again"-class fillers carry no work identity, so a
 * verbose "…, or There and Back Again" suffix reduces to its distinctive tokens
 * (`{hobbit, there, back}`). Mirrors the title-relevant subset of
 * `CROSS_SEGMENT_STOPWORDS` in folder-parsing (the series-name words are dropped
 * — they are not title fillers — and a few common prepositions are added).
 */
const TITLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at',
  'for', 'with', 'as', 'by', 'from', 'book', 'again',
]);

/**
 * Significant tokens of a title: lowercased, punctuation stripped to spaces,
 * whitespace collapsed, then stopwords and single-character tokens dropped (the
 * same lone-token guard {@link authorOverlap} applies — a stray "a"/"i" must not
 * drive a match).
 */
function significantTitleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !TITLE_STOPWORDS.has(t)),
  );
}

/**
 * Bidirectional significant-token containment: the smaller **non-empty**
 * significant-token set is fully contained in the larger. Handles both
 * "verbose item / short candidate" and the reverse. An empty significant-token
 * set (title is all stopwords/punctuation) is never a subset of everything →
 * returns false, so the caller falls back to dice alone.
 */
function titleContainment(a: string, b: string): boolean {
  const ta = significantTitleTokens(a);
  const tb = significantTitleTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const token of small) {
    if (!large.has(token)) return false;
  }
  return true;
}
