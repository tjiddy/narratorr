import type { SearchOptions } from '@core/index.js';

/** Everything after the apostrophe decision, shared so the two folds below cannot drift apart. */
function collapseQueryPunctuation(s: string): string {
  return s
    .replace(/[()[\]{}.:;,?!"“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Drop apostrophes without splitting words; replace other query punctuation with spaces.
 * This is transport cleanup, distinct from folder-name parsing that removes content.
 */
export function cleanIndexerQuery(s: string): string {
  return collapseQueryPunctuation(s.replace(/['‘’]/g, ''));
}

/**
 * The apostrophe-preserving twin, for the one indexer whose tokenizer cannot match a
 * de-apostrophized word (#2422). Curly forms fold to U+0027 so consumers key on one character.
 */
export function cleanIndexerQueryKeepingApostrophes(s: string): string {
  return collapseQueryPunctuation(s.replace(/[‘’]/g, "'"));
}

export function buildSearchQuery(book: { title: string; authors?: Array<{ name: string }> | null }): string {
  const raw = [book.title, book.authors?.[0]?.name].filter(Boolean).join(' ');
  return cleanIndexerQuery(raw);
}

/** Clean title and author only for adapter transport; ranking must retain raw punctuation. */
export function cleanIndexerSearchOptions(options?: SearchOptions): SearchOptions | undefined {
  if (!options) return options;
  return {
    ...options,
    ...(options.title !== undefined && { title: cleanIndexerQuery(options.title) }),
    ...(options.author !== undefined && { author: cleanIndexerQuery(options.author) }),
  };
}
