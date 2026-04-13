import type { SearchResult } from '../indexers/types.js';
import { isMultiPartUsenetPost } from './parse.js';

/**
 * Returns true if the language passes the filter (matches or is unknown).
 * Works with any object that has an optional language field.
 */
export function matchesLanguageFilter(language: string | undefined, allowedLanguages: readonly string[]): boolean {
  if (!language) return true;
  return allowedLanguages.includes(language.toLowerCase());
}

/**
 * Filters items by language. Items with no language pass through.
 * Returns all items when allowedLanguages is empty.
 */
export function filterByLanguage<T extends { language?: string }>(items: T[], allowedLanguages: readonly string[]): T[] {
  if (allowedLanguages.length === 0) return items;
  return items.filter((item) => matchesLanguageFilter(item.language, allowedLanguages));
}

/**
 * Filters multi-part Usenet posts from search results.
 * Uses nzbName || rawTitle || title fallback (|| not ?? — empty strings fall through).
 * Returns both the filtered results and the titles that were rejected (for logging).
 */
export function filterMultiPartUsenet(results: SearchResult[]): { filtered: SearchResult[]; rejectedTitles: string[] } {
  const rejectedTitles: string[] = [];
  const filtered = results.filter((r) => {
    if (r.protocol !== 'usenet') return true;
    const sourceTitle = r.nzbName || r.rawTitle || r.title;
    const multiPart = isMultiPartUsenetPost(sourceTitle);
    if (multiPart.match && multiPart.total! > 1) {
      rejectedTitles.push(sourceTitle);
      return false;
    }
    return true;
  });
  return { filtered, rejectedTitles };
}
