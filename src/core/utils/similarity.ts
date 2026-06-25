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

/** Normalized, non-empty file-narrator tokens: split on delimiters → normalize → drop empties. */
function fileNarratorTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return tokenizeNarrators(raw).map(normalizeNarrator).filter(Boolean);
}

/** Normalized, non-empty edition-narrator tokens: normalize each entry → drop empties. */
function editionNarratorTokens(narrators: string[] | undefined): string[] {
  return (narrators ?? []).map(normalizeNarrator).filter(Boolean);
}

/** Sort a name's whitespace-separated words so word order can't sink the dice score. */
function sortNameWords(s: string): string {
  return s.split(' ').filter(Boolean).sort().join(' ');
}

/**
 * Order-insensitive dice (#1652): the max of the as-is compare and the
 * word-sorted compare. Lets `Stevenson, Juliet` match `Juliet Stevenson`
 * (a `Last, First` flip) without a phonetic/alias layer — `Mike`/`Michael`
 * still scores below threshold and stays a mismatch.
 */
function nameDice(a: string, b: string): number {
  const direct = diceCoefficient(a, b);
  const sorted = diceCoefficient(sortNameWords(a), sortNameWords(b));
  return direct >= sorted ? direct : sorted;
}

/**
 * Three-state narrator comparison (#1650, #1652). The single source of truth
 * for BOTH "is there a usable narrator signal?" and "do the signals match?",
 * so the search-ranking narrator tier (`narratorsFuzzyMatch`), the match-job
 * edition cap (`narratorMismatchReason`), and any future consumer agree on one
 * definition. This lives in core because core production code cannot import
 * `src/server/**` (layer guard) — server helpers import this.
 *
 * - `'no-signal'` — either side normalizes to no usable tokens (absent file
 *   tag, empty edition list, or punctuation-only entries like `'-'`/`'.'` that
 *   `normalizeNarrator` strips to empty). This is the fix for #1652: signal
 *   presence is judged AFTER normalization on both sides, so the helper and the
 *   primitive can no longer disagree about emptiness.
 * - `'match'` — set-overlap: a single pairwise hit at or above `threshold` is
 *   enough (multi-narrator / full-cast editions match when ANY file token lines
 *   up with ANY edition narrator).
 * - `'mismatch'` — both sides carry signal but nothing clears `threshold`.
 *
 * NOT modeled on `quality-gate.helpers.ts`, which is exact normalized set
 * membership — a different contract.
 */
export type NarratorComparison = 'match' | 'mismatch' | 'no-signal';

export function compareNarratorSignals(
  fileNarratorRaw: string | undefined,
  editionNarrators: string[] | undefined,
  threshold = NARRATOR_MATCH_THRESHOLD,
): NarratorComparison {
  const fileTokens = fileNarratorTokens(fileNarratorRaw);
  const editionTokens = editionNarratorTokens(editionNarrators);
  if (fileTokens.length === 0 || editionTokens.length === 0) return 'no-signal';

  // A combined whole-name candidate recovers `Last, First` names that the
  // delimiter split fragments into single words (the comma is also a multi-
  // narrator delimiter, so we can't stop splitting it — we re-join instead).
  const fileCombined = sortNameWords(fileTokens.join(' '));
  let best = 0;
  for (const et of editionTokens) {
    best = Math.max(best, nameDice(fileCombined, et));
    for (const ft of fileTokens) {
      best = Math.max(best, nameDice(ft, et));
    }
  }
  return best >= threshold ? 'match' : 'mismatch';
}

/**
 * Fuzzy narrator comparison: does the file's narrator tag name any of the
 * matched edition's narrators? Boolean façade over `compareNarratorSignals`
 * (`'match'` only) — both "no signal" and "mismatch" return `false`; callers
 * that must distinguish the two consult `compareNarratorSignals` directly.
 */
export function narratorsFuzzyMatch(
  fileNarratorRaw: string | undefined,
  editionNarrators: string[] | undefined,
  threshold = NARRATOR_MATCH_THRESHOLD,
): boolean {
  return compareNarratorSignals(fileNarratorRaw, editionNarrators, threshold) === 'match';
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
