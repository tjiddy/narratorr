import { describe, expect, it } from 'vitest';
import type { SearchResult } from '../indexers/types.js';
import { filterByLanguage, filterMultiPartUsenet, matchesLanguageFilter } from './filters.js';

// --- helpers ---

function makeUsenetResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Some Audiobook',
    protocol: 'usenet',
    indexer: 'test-indexer',
    ...overrides,
  };
}

function makeTorrentResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Some Audiobook',
    protocol: 'torrent',
    indexer: 'test-indexer',
    ...overrides,
  };
}

// --- matchesLanguageFilter ---

describe('matchesLanguageFilter', () => {
  it('returns true when language is undefined (unknown → pass through)', () => {
    expect(matchesLanguageFilter(undefined, ['english'])).toBe(true);
  });

  it('returns true when language is empty string (falsy → treated as unknown)', () => {
    expect(matchesLanguageFilter('', ['english'])).toBe(true);
  });

  it('returns true when language matches an allowed language', () => {
    expect(matchesLanguageFilter('english', ['english', 'french'])).toBe(true);
  });

  it('returns true when language matches case-insensitively (English matches english)', () => {
    expect(matchesLanguageFilter('English', ['english'])).toBe(true);
  });

  it('returns false when language does not match any allowed language', () => {
    expect(matchesLanguageFilter('german', ['english', 'french'])).toBe(false);
  });
});

// --- filterByLanguage ---

describe('filterByLanguage', () => {
  it('returns all items when allowedLanguages is empty', () => {
    const items = [{ language: 'english' }, { language: 'french' }, { language: undefined }];
    expect(filterByLanguage(items, [])).toEqual(items);
  });

  it('passes through items with undefined language', () => {
    const items = [{ language: undefined }, { language: 'english' }];
    const result = filterByLanguage(items, ['english']);
    expect(result).toHaveLength(2);
  });

  it('passes through items with matching language', () => {
    const items = [{ language: 'english' }];
    expect(filterByLanguage(items, ['english'])).toEqual(items);
  });

  it('filters out items with non-matching language', () => {
    const items = [{ language: 'german' }];
    expect(filterByLanguage(items, ['english'])).toEqual([]);
  });

  it('handles mixed items — keeps matching and undefined, removes non-matching', () => {
    const items = [
      { language: 'english', id: 1 },
      { language: 'german', id: 2 },
      { language: undefined, id: 3 },
      { language: 'french', id: 4 },
    ];
    const result = filterByLanguage(items, ['english', 'french']);
    expect(result).toEqual([
      { language: 'english', id: 1 },
      { language: undefined, id: 3 },
      { language: 'french', id: 4 },
    ]);
  });
});

// --- filterMultiPartUsenet ---

describe('filterMultiPartUsenet', () => {
  describe('positive filtering', () => {
    it('filters out usenet result with multi-part title (8/30)', () => {
      const results = [makeUsenetResult({ title: 'Harry Potter Chapter 8 (8/30)' })];
      const { filtered } = filterMultiPartUsenet(results);
      expect(filtered).toEqual([]);
    });

    it('filters out usenet result with multi-part marker in nzbName (preferred field)', () => {
      const results = [makeUsenetResult({
        title: 'Harry Potter',
        nzbName: 'hp02.Harry Potter "28" of "30" yEnc',
      })];
      const { filtered } = filterMultiPartUsenet(results);
      expect(filtered).toEqual([]);
    });

    it('filters out usenet result with multi-part marker in rawTitle when nzbName absent', () => {
      const results = [makeUsenetResult({
        title: 'Harry Potter',
        rawTitle: 'hp02.Harry Potter "28" of "30" yEnc',
      })];
      const { filtered } = filterMultiPartUsenet(results);
      expect(filtered).toEqual([]);
    });

    it('filters out usenet result with multi-part marker in title (last fallback)', () => {
      const results = [makeUsenetResult({
        title: 'hp02.Harry Potter "28" of "30" yEnc',
      })];
      const { filtered } = filterMultiPartUsenet(results);
      expect(filtered).toEqual([]);
    });
  });

  describe('passthrough cases', () => {
    it('passes through torrent results unchanged (protocol gate)', () => {
      const results = [makeTorrentResult({ title: 'Harry Potter (8/30)' })];
      const { filtered } = filterMultiPartUsenet(results);
      expect(filtered).toEqual(results);
    });

    it('passes through usenet result with single-part marker [1/1]', () => {
      const results = [makeUsenetResult({ title: 'My Audiobook (1/1)' })];
      const { filtered } = filterMultiPartUsenet(results);
      expect(filtered).toEqual(results);
    });

    it('passes through usenet result with no multi-part marker', () => {
      const results = [makeUsenetResult({ title: 'Brandon Sanderson - The Way of Kings' })];
      const { filtered } = filterMultiPartUsenet(results);
      expect(filtered).toEqual(results);
    });
  });

  describe('field precedence (|| not ??)', () => {
    it('empty string nzbName falls through to rawTitle', () => {
      const results = [makeUsenetResult({
        title: 'Clean Title',
        nzbName: '',
        rawTitle: 'Book "3" of "10"',
      })];
      const { filtered } = filterMultiPartUsenet(results);
      expect(filtered).toEqual([]);
    });

    it('nzbName takes priority over rawTitle when both populated', () => {
      const results = [makeUsenetResult({
        title: 'Clean Title',
        nzbName: 'Clean NZB Name',
        rawTitle: 'Book "3" of "10"',
      })];
      const { filtered } = filterMultiPartUsenet(results);
      // nzbName has no multi-part marker → passes through even though rawTitle does
      expect(filtered).toEqual(results);
    });
  });

  describe('rejected titles tracking', () => {
    it('collects rejected source titles in the returned array', () => {
      const results = [
        makeUsenetResult({ title: 'Clean Title' }),
        makeUsenetResult({ nzbName: 'hp02.Harry Potter "28" of "30" yEnc', title: 'HP' }),
        makeUsenetResult({ rawTitle: 'Book 08 of 30', title: 'Book' }),
      ];
      const { rejectedTitles } = filterMultiPartUsenet(results);
      expect(rejectedTitles).toEqual([
        'hp02.Harry Potter "28" of "30" yEnc',
        'Book 08 of 30',
      ]);
    });

    it('returns empty rejected array when nothing is filtered', () => {
      const results = [
        makeUsenetResult({ title: 'Clean Title' }),
        makeTorrentResult({ title: 'Book (3/10)' }),
      ];
      const { rejectedTitles } = filterMultiPartUsenet(results);
      expect(rejectedTitles).toEqual([]);
    });
  });
});
