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
 * Title check: dice(item.title, candidate.title) ≥ threshold. When `item.author`
 * is present the loose {@link TITLE_MATCH_THRESHOLD} applies (the author check
 * corroborates); when it is absent the stricter
 * {@link NO_AUTHOR_TITLE_MATCH_THRESHOLD} applies (near-exact title required,
 * since nothing else gates the ASIN writeback — see #1629).
 * Author check: case-insensitive overlap (full or last-name token), only
 * required when `item.author` is present.
 *
 * If either required check fails → reject. Prevents "Golden Son by Pierce Brown"
 * cover/series getting attached to an entry that's actually "Golden Son by Some
 * Romance Author".
 */
export function matchPassesValidation(item: MatchValidationItem, candidate: BookMetadata): boolean {
  const titleDice = diceCoefficient(item.title, candidate.title);
  if (!item.author) return titleDice >= NO_AUTHOR_TITLE_MATCH_THRESHOLD;
  if (titleDice < TITLE_MATCH_THRESHOLD) return false;
  const candidateAuthors = candidate.authors?.map((a) => a.name).filter(Boolean) ?? [];
  if (candidateAuthors.length === 0) return false;
  return candidateAuthors.some((name) => authorOverlap(item.author!, name));
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
