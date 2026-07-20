import type { SearchOptions } from '../../core/index.js';

/**
 * Strip punctuation that fragments indexer Torznab queries while preserving
 * inner words and letters. Two tiers:
 *
 * 1. **Apostrophes are dropped (no space):** straight `'` (U+0027) and curly
 *    single quotes `‘`/`’` (U+2018/U+2019). This keeps contractions and names
 *    as single tokens — `O'Malley → OMalley`, `don't → dont` — instead of
 *    splitting them (`O Malley`), matching *arr-standard behavior.
 * 2. **Word-fragmenting punctuation is replaced with a space:** parens/brackets/
 *    braces/dots/colons/semicolons/commas, plus query-hostile `?`/`!` and
 *    double quotes `"`/`“`/`”` (U+201C/U+201D). Then whitespace collapses.
 *
 * Indexers tokenize these characters on their side, so dropping them
 * client-side does not lose matches and prevents zero-result queries from
 * titles like `Blood Ties (World of Warcraft: Midnight)`, authors like
 * `M. O. Walsh`, or `?`-terminated titles that MAM's text engine cannot match
 * (`Is She Really Going Out with Him?` — see #1904).
 *
 * Distinct from `cleanName` in `folder-parsing.ts` — that strips trailing
 * parens *and their content* for narrator annotations during library import.
 * This cleaner is for indexer-query construction only.
 */
export function cleanIndexerQuery(s: string): string {
  return s
    .replace(/['‘’]/g, '')
    .replace(/[()[\]{}.:;,?!"“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns a new options object with `title` and `author` cleaned for indexer
 * transport. All other fields (`limit`, `languages`, `signal`, …) pass through
 * untouched. Returns `undefined` when input is `undefined`.
 *
 * Use ONLY for transport (adapter call) — NOT for ranking context. Cleaning
 * the ranking-context side asymmetrically against raw indexer-result titles
 * drops dice scores 0.4-0.7 on punctuated cases (e.g. `11.22.63`,
 * `M. O. Walsh`). See #1015 for the transport/ranking split rationale.
 */
export function cleanIndexerSearchOptions(options?: SearchOptions): SearchOptions | undefined {
  if (!options) return options;
  return {
    ...options,
    ...(options.title !== undefined && { title: cleanIndexerQuery(options.title) }),
    ...(options.author !== undefined && { author: cleanIndexerQuery(options.author) }),
  };
}
