/**
 * ABB-specific query mapping. Its search is AND-over-stemmed-tokens, but the tokenizer treats the
 * apostrophe as a word character, so an indexed `Rider's` is unreachable by `rider`, `riders`, or
 * any other de-apostrophized spelling. Under AND semantics omitting the unmatchable token is free,
 * while guessing its indexed form (straight vs curly, s vs no-s) is a losing bet (#2422).
 *
 * The pair with `cleanIndexerQuery` is deliberate: that fold DELETES apostrophes for token-based
 * indexers, which is correct there, so ABB is fed the apostrophe-bearing text through its own
 * channel and folds it here.
 */

/**
 * Counting-only, for the degenerate guard. These are never removed from the emitted query — the
 * prod receipt that worked kept them ("A Dragon Guide to Retirement Julia Huni").
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'for', 'from', 'by', 'with',
]);

/** Below this many meaningful survivors the fold has eaten the query; ask today's question instead. */
const MIN_MEANINGFUL_TOKENS = 2;

import { CURLY_APOSTROPHE_CHARS } from '@shared/apostrophes.js';

const CURLY_APOSTROPHES = new RegExp(`[${CURLY_APOSTROPHE_CHARS}]`, 'g');

function tokenize(query: string): string[] {
  return query.split(/\s+/).filter((token) => token.length > 0);
}

/** Drop apostrophe-bearing words from an ABB query, falling back to today's stripped form when that empties it. */
export function buildAbbQuery(query: string): string {
  const normalized = query.replace(CURLY_APOSTROPHES, "'");
  const survivors = tokenize(normalized).filter((token) => !token.includes("'"));

  const meaningful = survivors.filter((token) => !STOPWORDS.has(token.toLowerCase()));
  if (meaningful.length < MIN_MEANINGFUL_TOKENS) return tokenize(normalized.replace(/'/g, '')).join(' ');

  return survivors.join(' ');
}
