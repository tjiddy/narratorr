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
 *
 * Returns a partition of inputs into:
 *   - kept: items that matched an allowed language OR had no detected language
 *   - dropped: items with an explicit language that did not match
 *   - passedUndetermined: items with no detected language (subset of kept)
 *
 * Callers that need just the surviving array should read `.kept`.
 * Returns all items in `kept` (and `passedUndetermined` empty) when `allowedLanguages`
 * is empty — preserves the historical "no filter" passthrough.
 */
export function filterByLanguage<T extends { language?: string | undefined }>(
  items: T[],
  allowedLanguages: readonly string[],
): { kept: T[]; dropped: T[]; passedUndetermined: T[] } {
  if (allowedLanguages.length === 0) {
    return { kept: items, dropped: [], passedUndetermined: [] };
  }
  const kept: T[] = [];
  const dropped: T[] = [];
  const passedUndetermined: T[] = [];
  for (const item of items) {
    if (!item.language) {
      kept.push(item);
      passedUndetermined.push(item);
      continue;
    }
    if (matchesLanguageFilter(item.language, allowedLanguages)) {
      kept.push(item);
    } else {
      dropped.push(item);
    }
  }
  return { kept, dropped, passedUndetermined };
}

/**
 * Filters multi-part Usenet posts from search results.
 * Uses nzbName || rawTitle || title fallback (|| not ?? — empty strings fall through).
 * Returns both the filtered results and the per-title rejections (title + matched
 * pattern source) so callers can emit a diagnostic debug log per drop.
 */
export function filterMultiPartUsenet(results: SearchResult[]): { filtered: SearchResult[]; rejectedTitles: Array<{ title: string; matchedPattern: string }> } {
  const rejectedTitles: Array<{ title: string; matchedPattern: string }> = [];
  const filtered = results.filter((r) => {
    if (r.protocol !== 'usenet') return true;
    const sourceTitle = r.nzbName || r.rawTitle || r.title;
    const multiPart = isMultiPartUsenetPost(sourceTitle);
    if (multiPart.match && multiPart.total! > 1) {
      rejectedTitles.push({ title: sourceTitle, matchedPattern: multiPart.pattern ?? 'unknown' });
      return false;
    }
    return true;
  });
  return { filtered, rejectedTitles };
}
