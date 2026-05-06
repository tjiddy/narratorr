import type { SearchOptions } from '../../core/index.js';

/**
 * Strip punctuation that fragments indexer Torznab queries while preserving
 * inner words and letters. Replaces parens/brackets/braces/dots/colons/
 * semicolons/commas with spaces, then collapses whitespace. Indexers tokenize
 * the same characters on their side, so dropping them client-side does not
 * lose matches and prevents zero-result queries from titles like
 * `Blood Ties (World of Warcraft: Midnight)` or authors like `M. O. Walsh`.
 *
 * Distinct from `cleanName` in `folder-parsing.ts` — that strips trailing
 * parens *and their content* for narrator annotations during library import.
 * This cleaner is for indexer-query construction only.
 */
export function cleanIndexerQuery(s: string): string {
  return s
    .replace(/[()[\]{}.:;,]/g, ' ')
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
