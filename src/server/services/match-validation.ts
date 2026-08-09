import { diceCoefficient } from '@core/utils/similarity.js';
import type { BookMetadata } from '@core/metadata/types.js';

/** Title fuzzy threshold for the search-candidate path (Dice coefficient). */
export const TITLE_MATCH_THRESHOLD = 0.7;

/**
 * Without author corroboration, require a near-exact title before writing a candidate ASIN and
 * metadata.
 */
export const NO_AUTHOR_TITLE_MATCH_THRESHOLD = 0.85;

export interface MatchValidationItem {
  title: string;
  author?: string | undefined;
}

/**
 * Without an author, require the stricter title threshold. With an author, require overlap first,
 * then accept either title similarity or significant-token containment for verbose title variants.
 */
export function matchPassesValidation(item: MatchValidationItem, candidate: BookMetadata): boolean {
  const titleDice = diceCoefficient(item.title, candidate.title);
  if (!item.author) return titleDice >= NO_AUTHOR_TITLE_MATCH_THRESHOLD;
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
  const aLast = aLower.split(/\s+/).pop()!;
  const bLast = bLower.split(/\s+/).pop()!;
  return aLast.length > 1 && aLast === bLast;
}

// Drop only title fillers; series-name words remain significant.
const TITLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at',
  'for', 'with', 'as', 'by', 'from', 'book', 'again',
]);

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
 * Accept either direction when the smaller nonempty significant-token set is fully contained in
 * the larger.
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
