/**
 * Split a multi-value narrator string on `[,;&]` delimiters.
 * Trims each token and drops empties.
 */
export function tokenizeNarrators(raw: string): string[] {
  if (!raw) return [];
  return raw.split(/[,;&]/).map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * Normalize a single narrator name token for comparison.
 * 1. Trim and lowercase
 * 2. Strip punctuation (periods, quotes, hyphens, etc.) — NOT commas/semicolons/ampersands (delimiters)
 * 3. Collapse whitespace
 */
export function normalizeNarrator(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[.!?'"-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bigram-based Dice coefficient for fuzzy string matching.
 * Returns 0-1 where 1 = identical, 0 = no bigrams in common.
 */
export function diceCoefficient(a: string, b: string): number {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();

  if (s1.length < 2 || s2.length < 2) return 0;
  if (s1 === s2) return 1;

  const bigrams1 = new Map<string, number>();
  for (let i = 0; i < s1.length - 1; i++) {
    const bigram = s1.slice(i, i + 2);
    bigrams1.set(bigram, (bigrams1.get(bigram) || 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bigram = s2.slice(i, i + 2);
    const count = bigrams1.get(bigram);
    if (count && count > 0) {
      intersection++;
      bigrams1.set(bigram, count - 1);
    }
  }

  return (2 * intersection) / (s1.length - 1 + s2.length - 1);
}

/**
 * Default dice threshold at or above which two narrator names are considered
 * the same person. Single source of truth — both the search-ranking narrator
 * tier and the library-import wrong-edition cap consume this (#1650).
 */
export const NARRATOR_MATCH_THRESHOLD = 0.8;

/**
 * Fuzzy narrator comparison: does the file's narrator tag name any of the
 * matched edition's narrators? Shared primitive (#1650) — the fuzzy cross
 * product (tokenize the file side → `normalizeNarrator` each token →
 * `normalizeNarrator` each edition entry → max pairwise `diceCoefficient`)
 * lives here so the search-ranking narrator tier and the match-job edition cap
 * agree on one definition of "same narrator".
 *
 * Set-overlap semantics: a single pairwise hit at or above `threshold` is
 * enough (multi-narrator / full-cast editions match when ANY file token lines
 * up with ANY edition narrator). Returns `false` when either side carries no
 * usable signal — callers that must distinguish "no signal" from "genuine
 * mismatch" check signal presence themselves before consulting this.
 *
 * NOT modeled on `quality-gate.helpers.ts`, which is exact normalized set
 * membership — a different contract.
 */
export function narratorsFuzzyMatch(
  fileNarratorRaw: string | undefined,
  editionNarrators: string[] | undefined,
  threshold = NARRATOR_MATCH_THRESHOLD,
): boolean {
  if (!fileNarratorRaw) return false;
  const fileTokens = tokenizeNarrators(fileNarratorRaw).map(normalizeNarrator).filter(Boolean);
  if (fileTokens.length === 0) return false;
  const editionTokens = (editionNarrators ?? []).map(normalizeNarrator).filter(Boolean);
  if (editionTokens.length === 0) return false;
  let best = 0;
  for (const ft of fileTokens) {
    for (const et of editionTokens) {
      best = Math.max(best, diceCoefficient(ft, et));
    }
  }
  return best >= threshold;
}

/**
 * Scores a search result against a search context (book title + author).
 * Returns 0-1 where 1 = perfect match.
 *
 * Weighting: title = 0.6, author = 0.4.
 * When author context is not provided, title gets full weight.
 */
export function scoreResult(
  result: { title?: string; author?: string },
  context: { title?: string; author?: string },
): number {
  const TITLE_WEIGHT = 0.6;
  const AUTHOR_WEIGHT = 0.4;

  let score = 0;
  let totalWeight = 0;

  if (context.title && result.title) {
    score += diceCoefficient(result.title, context.title) * TITLE_WEIGHT;
    totalWeight += TITLE_WEIGHT;
  }

  if (context.author && result.author) {
    score += diceCoefficient(result.author, context.author) * AUTHOR_WEIGHT;
    totalWeight += AUTHOR_WEIGHT;
  }

  // When only title context is provided, normalize to full weight
  return totalWeight > 0 ? score / totalWeight : 0;
}
