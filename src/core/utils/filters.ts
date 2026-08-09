import type { SearchResult } from '../indexers/types.js';
import { isMultiPartUsenetPost } from './parse.js';

/** Unknown languages pass the filter. */
export function matchesLanguageFilter(language: string | undefined, allowedLanguages: readonly string[]): boolean {
  if (!language) return true;
  return allowedLanguages.includes(language.toLowerCase());
}

/**
 * Unknown languages stay in `kept` and are also returned in `passedUndetermined`. An empty allowlist
 * disables filtering.
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
 * Filters multipart Usenet posts using the first non-empty nzbName, rawTitle, or title. Rejections
 * retain the matched pattern for diagnostics.
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
