import { diceCoefficient } from '../../core/utils/similarity.js';
import type { BookMetadata } from '../../core/metadata/types.js';

/** Title fuzzy threshold for the search-candidate path (Dice coefficient). */
export const TITLE_MATCH_THRESHOLD = 0.7;

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
 * Title check: dice(item.title, candidate.title) ≥ threshold (always required).
 * Author check: case-insensitive overlap (full or last-name token), only
 * required when `item.author` is present.
 *
 * If either required check fails → reject. Prevents "Golden Son by Pierce Brown"
 * cover/series getting attached to an entry that's actually "Golden Son by Some
 * Romance Author".
 */
export function matchPassesValidation(item: MatchValidationItem, candidate: BookMetadata): boolean {
  if (diceCoefficient(item.title, candidate.title) < TITLE_MATCH_THRESHOLD) return false;
  if (!item.author) return true;
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
