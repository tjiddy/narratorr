export function tokenizeNarrators(raw: string): string[] {
  if (!raw) return [];
  return raw.split(/[,;&]/).map((t) => t.trim()).filter((t) => t.length > 0);
}

const ROLE_PREFIX_RE = /^(?:read by|narrated by|narrator|performed by|voiced by|voice)\b\s*:?\s*/i;

// Preserve prefix-only values; placeholder semantics belong to signal comparison.
function stripRolePrefix(s: string): string {
  const stripped = s.replace(ROLE_PREFIX_RE, '');
  return stripped.trim().length > 0 ? stripped : s;
}

function foldDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/gu, '');
}

/**
 * Collapsing single-letter runs makes `R. C.` match `R.C.`, but can conflate same-surname narrators
 * differing only by a middle initial. Tests intentionally pin this trade-off.
 */
function collapseInitials(s: string): string {
  return s.replace(/\b([a-z])\s+(?=[a-z]\b)/g, '$1');
}

/**
 * Order matters: strip parentheses and role prefixes before punctuation, then fold diacritics and
 * collapse initials after periods are gone. Placeholder semantics are deliberately excluded.
 */
export function normalizeNarrator(name: string): string {
  const deparened = name.replace(/\([^)]*\)/g, ' ').trim();
  const deprefixed = stripRolePrefix(deparened);
  const punctStripped = deprefixed
    .toLowerCase()
    .replace(/[.!?'"-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return collapseInitials(foldDiacritics(punctStripped));
}

/** Bigram Dice coefficient in [0, 1]; inputs shorter than two characters score 0. */
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

/** Shared fuzzy-narrator threshold for search ranking and wrong-edition detection. */
export const NARRATOR_MATCH_THRESHOLD = 0.8;

/**
 * Normalized tokens treated as no narrator signal. Keep this comparison-only so author scoring and
 * exact quality-gate membership remain unchanged. Metadata's `PSEUDO_NARRATORS` is intentionally a
 * narrower subset, pinned by a consistency test.
 */
export const NARRATOR_PLACEHOLDERS = new Set([
  'author',
  'multiple readers',
  'various',
  'various narrators',
  'full cast',
  'unknown',
  'uncredited',
  'narrator',
]);

function isSignalToken(normalized: string): boolean {
  return normalized.length > 0 && !NARRATOR_PLACEHOLDERS.has(normalized);
}

function fileNarratorTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return tokenizeNarrators(raw).map(normalizeNarrator).filter(isSignalToken);
}

function editionNarratorTokens(narrators: string[] | undefined): string[] {
  return (narrators ?? []).map(normalizeNarrator).filter(isSignalToken);
}

function sortNameWords(s: string): string {
  return s.split(' ').filter(Boolean).sort().join(' ');
}

/** Uses the better direct or word-sorted Dice score; name-order flips match without alias expansion. */
function nameDice(a: string, b: string): number {
  const direct = diceCoefficient(a, b);
  const sorted = diceCoefficient(sortNameWords(a), sortNameWords(b));
  return direct >= sorted ? direct : sorted;
}

/**
 * Distinguishes absent or junk signal from a real mismatch. Any token pair at the shared threshold
 * is a match; unlike the quality gate, this contract is fuzzy rather than exact set membership.
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

  // Commas mean both `Last, First` and narrator separators; rejoining preserves a whole-name candidate.
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

/** Boolean facade over `compareNarratorSignals`; both no-signal and mismatch become false. */
export function narratorsFuzzyMatch(
  fileNarratorRaw: string | undefined,
  editionNarrators: string[] | undefined,
  threshold = NARRATOR_MATCH_THRESHOLD,
): boolean {
  return compareNarratorSignals(fileNarratorRaw, editionNarrators, threshold) === 'match';
}

/** Scores title and author from 0–1; when either context is not provided, the other gets full weight. */
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

  return totalWeight > 0 ? score / totalWeight : 0;
}
