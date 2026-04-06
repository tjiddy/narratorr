import { describe, it, expect } from 'vitest';
import { sortBooks, collapseSeries, matchesStatusFilter, getStatusCount, extractNarrators, computeMbPerHour, filterTabs } from './helpers';
import type { BookWithAuthor } from '@/lib/api';

function makeBook(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return {
    id: 1,
    title: 'Test Book',
    status: 'wanted',
    enrichmentStatus: 'pending',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    authors: [],
    narrators: [],
    description: null,
    coverUrl: null,
    asin: null,
    isbn: null,
    seriesName: null,
    seriesPosition: null,
    duration: null,
    publishedDate: null,
    genres: null,
    path: null,
    size: null,
    audioCodec: null,
    audioBitrate: null,
    audioSampleRate: null,
    audioChannels: null,
    audioBitrateMode: null,
    audioFileFormat: null,
    audioFileCount: null,
    audioTotalSize: null,
    audioDuration: null,
    monitorForUpgrades: false,
    ...overrides,
  };
}

describe('sortBooks', () => {
  it('sorts by title using toSortTitle — "The Way of Kings" sorts after "Warbreaker"', () => {
    const books = [
      makeBook({ id: 1, title: 'The Way of Kings' }),
      makeBook({ id: 2, title: 'Warbreaker' }),
      makeBook({ id: 3, title: 'A Game of Thrones' }),
    ];

    const sorted = sortBooks(books, 'title', 'asc');
    const titles = sorted.map((b) => b.title);
    // "A Game of Thrones" → "Game of Thrones" (G), "The Way of Kings" → "Way of Kings" (W), "Warbreaker" (W)
    expect(titles).toEqual(['A Game of Thrones', 'Warbreaker', 'The Way of Kings']);
  });

  it('sorts by author alphabetically', () => {
    const books = [
      makeBook({ id: 1, authors: [{ id: 1, name: 'Sanderson', slug: 's' }] }),
      makeBook({ id: 2, authors: [{ id: 2, name: 'Abercrombie', slug: 'a' }] }),
    ];

    const sorted = sortBooks(books, 'author', 'asc');
    expect(sorted[0].authors[0]?.name).toBe('Abercrombie');
    expect(sorted[1].authors[0]?.name).toBe('Sanderson');
  });

  it('sorts by createdAt', () => {
    const books = [
      makeBook({ id: 1, createdAt: '2024-01-03T00:00:00Z' }),
      makeBook({ id: 2, createdAt: '2024-01-01T00:00:00Z' }),
      makeBook({ id: 3, createdAt: '2024-01-02T00:00:00Z' }),
    ];

    const sortedAsc = sortBooks(books, 'createdAt', 'asc');
    expect(sortedAsc.map((b) => b.id)).toEqual([2, 3, 1]);

    const sortedDesc = sortBooks(books, 'createdAt', 'desc');
    expect(sortedDesc.map((b) => b.id)).toEqual([1, 3, 2]);
  });
});

describe('collapseSeries', () => {
  it('groups books by seriesName and picks lowest seriesPosition as representative', () => {
    const books = [
      makeBook({ id: 1, title: 'Book 1', seriesName: 'Stormlight', seriesPosition: 1 }),
      makeBook({ id: 2, title: 'Book 2', seriesName: 'Stormlight', seriesPosition: 2 }),
      makeBook({ id: 3, title: 'Book 3', seriesName: 'Stormlight', seriesPosition: 3 }),
    ];

    const collapsed = collapseSeries(books, 'createdAt', 'desc');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].id).toBe(1);
    expect(collapsed[0].collapsedCount).toBe(2);
  });

  it('passes standalone books (no seriesName) through unchanged', () => {
    const books = [
      makeBook({ id: 1, title: 'Standalone', seriesName: null }),
      makeBook({ id: 2, title: 'Book 1', seriesName: 'Series A', seriesPosition: 1 }),
      makeBook({ id: 3, title: 'Book 2', seriesName: 'Series A', seriesPosition: 2 }),
    ];

    const collapsed = collapseSeries(books, 'createdAt', 'desc');
    expect(collapsed).toHaveLength(2);
    const standalone = collapsed.find((b) => b.id === 1);
    expect(standalone).toBeTruthy();
    expect(standalone?.collapsedCount).toBeUndefined();
  });

  it('badge count equals visible books in series minus 1', () => {
    const books = [
      makeBook({ id: 1, seriesName: 'WoT', seriesPosition: 1 }),
      makeBook({ id: 2, seriesName: 'WoT', seriesPosition: 2 }),
      makeBook({ id: 3, seriesName: 'WoT', seriesPosition: 3 }),
      makeBook({ id: 4, seriesName: 'WoT', seriesPosition: 4 }),
      makeBook({ id: 5, seriesName: 'WoT', seriesPosition: 5 }),
    ];

    const collapsed = collapseSeries(books, 'createdAt', 'desc');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].collapsedCount).toBe(4);
  });

  it('falls back to first by current sort order when no book has seriesPosition', () => {
    const books = [
      makeBook({ id: 1, title: 'Zulu', seriesName: 'NoPos', seriesPosition: null }),
      makeBook({ id: 2, title: 'Alpha', seriesName: 'NoPos', seriesPosition: null }),
    ];

    // Sort by title asc — Alpha comes first
    const collapsed = collapseSeries(books, 'title', 'asc');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].title).toBe('Alpha');
    expect(collapsed[0].collapsedCount).toBe(1);
  });

  it('only operates on input set — does not include books outside the input', () => {
    // Simulate pre-filtered input: only 2 of 5 WoT books passed in
    const filteredBooks = [
      makeBook({ id: 2, seriesName: 'WoT', seriesPosition: 2 }),
      makeBook({ id: 4, seriesName: 'WoT', seriesPosition: 4 }),
    ];

    const collapsed = collapseSeries(filteredBooks, 'createdAt', 'desc');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].id).toBe(2); // lowest position in filtered set
    expect(collapsed[0].collapsedCount).toBe(1); // only 1 other book in filtered set
  });

  it('handles multiple series correctly', () => {
    const books = [
      makeBook({ id: 1, seriesName: 'Series A', seriesPosition: 1 }),
      makeBook({ id: 2, seriesName: 'Series A', seriesPosition: 2 }),
      makeBook({ id: 3, seriesName: 'Series B', seriesPosition: 1 }),
      makeBook({ id: 4, seriesName: 'Series B', seriesPosition: 2 }),
      makeBook({ id: 5, seriesName: 'Series B', seriesPosition: 3 }),
      makeBook({ id: 6, seriesName: null }), // standalone
    ];

    const collapsed = collapseSeries(books, 'createdAt', 'desc');
    expect(collapsed).toHaveLength(3); // 1 per series + 1 standalone
    const seriesA = collapsed.find((b) => b.seriesName === 'Series A');
    const seriesB = collapsed.find((b) => b.seriesName === 'Series B');
    expect(seriesA?.collapsedCount).toBe(1);
    expect(seriesB?.collapsedCount).toBe(2);
  });
});

describe('matchesStatusFilter', () => {
  it('all matches everything', () => {
    expect(matchesStatusFilter('wanted', 'all')).toBe(true);
    expect(matchesStatusFilter('imported', 'all')).toBe(true);
  });

  it('downloading matches both searching and downloading', () => {
    expect(matchesStatusFilter('searching', 'downloading')).toBe(true);
    expect(matchesStatusFilter('downloading', 'downloading')).toBe(true);
  });

  it('imported matches both imported and importing', () => {
    expect(matchesStatusFilter('imported', 'imported')).toBe(true);
    expect(matchesStatusFilter('importing', 'imported')).toBe(true);
  });

  // #351 — failed and missing status filters
  it('failed filter matches only failed status', () => {
    expect(matchesStatusFilter('failed', 'failed')).toBe(true);
  });

  it('failed status does not match other non-all filters', () => {
    expect(matchesStatusFilter('failed', 'wanted')).toBe(false);
    expect(matchesStatusFilter('failed', 'downloading')).toBe(false);
    expect(matchesStatusFilter('failed', 'imported')).toBe(false);
    expect(matchesStatusFilter('failed', 'missing')).toBe(false);
  });

  it('missing filter matches only missing status', () => {
    expect(matchesStatusFilter('missing', 'missing')).toBe(true);
  });

  it('missing status does not match other non-all filters', () => {
    expect(matchesStatusFilter('missing', 'wanted')).toBe(false);
    expect(matchesStatusFilter('missing', 'downloading')).toBe(false);
    expect(matchesStatusFilter('missing', 'imported')).toBe(false);
    expect(matchesStatusFilter('missing', 'failed')).toBe(false);
  });

  it('all filter matches failed and missing statuses', () => {
    expect(matchesStatusFilter('failed', 'all')).toBe(true);
    expect(matchesStatusFilter('missing', 'all')).toBe(true);
  });
});

describe('filterTabs (#351)', () => {
  it('includes failed and missing tab entries', () => {
    const keys = filterTabs.map((t) => t.key);
    expect(keys).toContain('failed');
    expect(keys).toContain('missing');
  });

  it('has 6 entries total', () => {
    expect(filterTabs).toHaveLength(6);
  });
});

describe('getStatusCount', () => {
  it('counts books matching the filter', () => {
    const books = [
      makeBook({ status: 'wanted' }),
      makeBook({ status: 'downloading' }),
      makeBook({ status: 'imported' }),
    ];
    expect(getStatusCount(books, 'wanted')).toBe(1);
    expect(getStatusCount(books, 'downloading')).toBe(1);
  });
});

// #282 — Table view sorting with extended sort fields
describe('sortBooks — extended sort fields (#282)', () => {
  it('sorts by narrator alphabetically, nulls last', () => {
    const books = [
      makeBook({ id: 1, narrators: [{ id: 1, name: 'Zelda', slug: 'zelda' }] }),
      makeBook({ id: 2, narrators: [] }),
      makeBook({ id: 3, narrators: [{ id: 2, name: 'Alice', slug: 'alice' }] }),
    ];

    const sorted = sortBooks(books, 'narrator', 'asc');
    expect(sorted.map((b) => b.id)).toEqual([3, 1, 2]);
  });

  it('sorts by series name alphabetically, nulls last', () => {
    const books = [
      makeBook({ id: 1, seriesName: 'Stormlight' }),
      makeBook({ id: 2, seriesName: null }),
      makeBook({ id: 3, seriesName: 'Cosmere' }),
    ];

    const sorted = sortBooks(books, 'series', 'asc');
    expect(sorted.map((b) => b.id)).toEqual([3, 1, 2]);
  });

  it('sorts by quality (MB/hr) numerically, nulls last', () => {
    // Book 1: 100MB in 1hr = 100 MB/hr, Book 3: 200MB in 1hr = 200 MB/hr
    const books = [
      makeBook({ id: 1, audioTotalSize: 100 * 1024 * 1024, audioDuration: 3600 }),
      makeBook({ id: 2, audioTotalSize: null, audioDuration: null }),
      makeBook({ id: 3, audioTotalSize: 200 * 1024 * 1024, audioDuration: 3600 }),
    ];

    const sorted = sortBooks(books, 'quality', 'asc');
    expect(sorted.map((b) => b.id)).toEqual([1, 3, 2]);
  });

  it('sorts by size (audioTotalSize with fallback to size) numerically, nulls last', () => {
    const books = [
      makeBook({ id: 1, audioTotalSize: 500, size: null }),
      makeBook({ id: 2, audioTotalSize: null, size: null }),
      makeBook({ id: 3, audioTotalSize: null, size: 300 }),
      makeBook({ id: 4, audioTotalSize: 100, size: 999 }),
    ];

    const sorted = sortBooks(books, 'size', 'asc');
    expect(sorted.map((b) => b.id)).toEqual([4, 3, 1, 2]);
  });

  it('sorts by audioFileFormat alphabetically, nulls last', () => {
    const books = [
      makeBook({ id: 1, audioFileFormat: 'mp3' }),
      makeBook({ id: 2, audioFileFormat: null }),
      makeBook({ id: 3, audioFileFormat: 'flac' }),
    ];

    const sorted = sortBooks(books, 'format', 'asc');
    expect(sorted.map((b) => b.id)).toEqual([3, 1, 2]);
  });

  it('reverses sort direction for all extended fields', () => {
    const narratorBooks = [
      makeBook({ id: 1, narrators: [{ id: 1, name: 'Alice', slug: 'alice' }] }),
      makeBook({ id: 2, narrators: [{ id: 2, name: 'Zelda', slug: 'zelda' }] }),
    ];
    const sortedNarrator = sortBooks(narratorBooks, 'narrator', 'desc');
    expect(sortedNarrator.map((b) => b.id)).toEqual([2, 1]);

    const sizeBooks = [
      makeBook({ id: 1, audioTotalSize: 100 }),
      makeBook({ id: 2, audioTotalSize: 500 }),
    ];
    const sortedSize = sortBooks(sizeBooks, 'size', 'desc');
    expect(sortedSize.map((b) => b.id)).toEqual([2, 1]);

    const formatBooks = [
      makeBook({ id: 1, audioFileFormat: 'flac' }),
      makeBook({ id: 2, audioFileFormat: 'mp3' }),
    ];
    const sortedFormat = sortBooks(formatBooks, 'format', 'desc');
    expect(sortedFormat.map((b) => b.id)).toEqual([2, 1]);
  });
});

// #266 — Series sort position tiebreaker
describe('sortBooks — series position tiebreaker (#266)', () => {
  it('sorts books by seriesPosition when seriesName is equal (asc)', () => {
    const books = [
      makeBook({ id: 10, seriesName: 'Stormlight', seriesPosition: 3 }),
      makeBook({ id: 20, seriesName: 'Stormlight', seriesPosition: 1 }),
      makeBook({ id: 30, seriesName: 'Stormlight', seriesPosition: 2 }),
    ];

    const sorted = sortBooks(books, 'series', 'asc');
    expect(sorted.map((b) => b.seriesPosition)).toEqual([1, 2, 3]);
  });

  it('desc reverses series name order but keeps position ascending within group', () => {
    const books = [
      makeBook({ id: 1, seriesName: 'Alpha', seriesPosition: 2 }),
      makeBook({ id: 2, seriesName: 'Alpha', seriesPosition: 1 }),
      makeBook({ id: 3, seriesName: 'Zulu', seriesPosition: 2 }),
      makeBook({ id: 4, seriesName: 'Zulu', seriesPosition: 1 }),
    ];

    const sorted = sortBooks(books, 'series', 'desc');
    // Zulu first (desc), then Alpha — but positions ascending within each group
    expect(sorted.map((b) => b.id)).toEqual([4, 3, 2, 1]);
  });

  it('books across different series sorted by name first, then position', () => {
    const books = [
      makeBook({ id: 1, seriesName: 'Zulu', seriesPosition: 1 }),
      makeBook({ id: 2, seriesName: 'Alpha', seriesPosition: 2 }),
      makeBook({ id: 3, seriesName: 'Alpha', seriesPosition: 1 }),
    ];

    const sorted = sortBooks(books, 'series', 'asc');
    expect(sorted.map((b) => b.id)).toEqual([3, 2, 1]);
  });

  it('null seriesPosition within a named series sorts after positioned books', () => {
    const books = [
      makeBook({ id: 1, seriesName: 'WoT', seriesPosition: null }),
      makeBook({ id: 2, seriesName: 'WoT', seriesPosition: 1 }),
      makeBook({ id: 3, seriesName: 'WoT', seriesPosition: 2 }),
    ];

    const sorted = sortBooks(books, 'series', 'asc');
    expect(sorted.map((b) => b.id)).toEqual([2, 3, 1]);
  });

  it('null seriesName books sort to end in ascending mode (regression guard)', () => {
    const books = [
      makeBook({ id: 1, seriesName: null }),
      makeBook({ id: 2, seriesName: 'Alpha', seriesPosition: 1 }),
    ];

    const sorted = sortBooks(books, 'series', 'asc');
    expect(sorted.map((b) => b.id)).toEqual([2, 1]);
  });

  it('non-series sort fields unaffected by changes (regression guard)', () => {
    const books = [
      makeBook({ id: 1, title: 'Zulu', seriesName: 'Same', seriesPosition: 1 }),
      makeBook({ id: 2, title: 'Alpha', seriesName: 'Same', seriesPosition: 2 }),
    ];

    // Title sort should not use seriesPosition tiebreaker
    const sorted = sortBooks(books, 'title', 'asc');
    expect(sorted.map((b) => b.id)).toEqual([2, 1]);
  });

  it('no-series books with stray seriesPosition skip position tiebreaker (F2)', () => {
    // seriesName=null but seriesPosition retained from metadata edits
    const books = [
      makeBook({ id: 1, seriesName: null, seriesPosition: 5 }),
      makeBook({ id: 2, seriesName: null, seriesPosition: 1 }),
      makeBook({ id: 3, seriesName: null, seriesPosition: null }),
    ];

    // Should fall back to direction-matched id, NOT reorder by position
    const sorted = sortBooks(books, 'series', 'asc');
    expect(sorted.map((b) => b.id)).toEqual([1, 2, 3]);
  });

  it('equal positions within same series fall back to direction-matched id asc (F4)', () => {
    const books = [
      makeBook({ id: 2, seriesName: 'Stormlight', seriesPosition: 1 }),
      makeBook({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
    ];

    const sorted = sortBooks(books, 'series', 'asc');
    expect(sorted.map((b) => b.id)).toEqual([1, 2]);
  });

  it('equal positions within same series fall back to direction-matched id desc (F4)', () => {
    const books = [
      makeBook({ id: 1, seriesName: 'Stormlight', seriesPosition: 1 }),
      makeBook({ id: 2, seriesName: 'Stormlight', seriesPosition: 1 }),
    ];

    const sorted = sortBooks(books, 'series', 'desc');
    expect(sorted.map((b) => b.id)).toEqual([2, 1]);
  });

  it('all-null positions within same series fall back to direction-matched id (F4)', () => {
    const books = [
      makeBook({ id: 3, seriesName: 'WoT', seriesPosition: null }),
      makeBook({ id: 1, seriesName: 'WoT', seriesPosition: null }),
      makeBook({ id: 2, seriesName: 'WoT', seriesPosition: null }),
    ];

    const sorted = sortBooks(books, 'series', 'asc');
    expect(sorted.map((b) => b.id)).toEqual([1, 2, 3]);
  });
});

// #282 — Narrator split helper
describe('extractNarrators (#282)', () => {
  it('splits narrator string on comma delimiter', () => {
    expect(extractNarrators('Alice, Bob, Charlie')).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('splits narrator string on semicolon delimiter', () => {
    expect(extractNarrators('Alice; Bob; Charlie')).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('splits narrator string on ampersand delimiter', () => {
    expect(extractNarrators('Alice & Bob & Charlie')).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('trims whitespace from split narrator names', () => {
    expect(extractNarrators('  Alice ,  Bob  ; Charlie  ')).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('returns empty array for null narrator', () => {
    expect(extractNarrators(null)).toEqual([]);
  });

  it('returns empty array for empty string narrator', () => {
    expect(extractNarrators('')).toEqual([]);
    expect(extractNarrators('   ')).toEqual([]);
  });

  it('returns single-element array for single narrator', () => {
    expect(extractNarrators('Steven Pacey')).toEqual(['Steven Pacey']);
  });

  it('deduplicates narrators case-insensitively', () => {
    expect(extractNarrators('Alice, alice, ALICE')).toEqual(['Alice']);
    expect(extractNarrators('Alice, Bob, alice')).toEqual(['Alice', 'Bob']);
  });
});

// #282 — computeMbPerHour helper
describe('computeMbPerHour (#282)', () => {
  it('computes MB/hr from audioTotalSize and audioDuration', () => {
    // 100 MB in 1 hour = 100 MB/hr
    const book = makeBook({ audioTotalSize: 100 * 1024 * 1024, audioDuration: 3600 });
    expect(computeMbPerHour(book)).toBeCloseTo(100, 1);
  });

  it('falls back to size when audioTotalSize is null', () => {
    // 50 MB in 1 hour = 50 MB/hr
    const book = makeBook({ audioTotalSize: null, size: 50 * 1024 * 1024, audioDuration: 3600 });
    expect(computeMbPerHour(book)).toBeCloseTo(50, 1);
  });

  it('returns null when audioDuration is null', () => {
    const book = makeBook({ audioTotalSize: 100 * 1024 * 1024, audioDuration: null });
    expect(computeMbPerHour(book)).toBeNull();
  });

  it('returns null when audioDuration is 0', () => {
    const book = makeBook({ audioTotalSize: 100 * 1024 * 1024, audioDuration: 0 });
    expect(computeMbPerHour(book)).toBeNull();
  });
});

// #287 — compareNullable descending null-last fix
describe('sortBooks — descending nulls-last (#287)', () => {
  it('sorts nullable field (narrator) descending with nulls last', () => {
    const books = [
      makeBook({ id: 1, narrators: [{ id: 1, name: 'Zelda', slug: 'zelda' }] }),
      makeBook({ id: 2, narrators: [] }),
      makeBook({ id: 3, narrators: [{ id: 2, name: 'Alice', slug: 'alice' }] }),
    ];

    const sorted = sortBooks(books, 'narrator', 'desc');
    // Descending: Zelda, Alice, then null last
    expect(sorted.map((b) => b.id)).toEqual([1, 3, 2]);
  });

  it('sorts nullable field (series) descending with nulls last', () => {
    const books = [
      makeBook({ id: 1, seriesName: 'Stormlight' }),
      makeBook({ id: 2, seriesName: null }),
      makeBook({ id: 3, seriesName: 'Cosmere' }),
    ];

    const sorted = sortBooks(books, 'series', 'desc');
    // Descending: Stormlight, Cosmere, then null last
    expect(sorted.map((b) => b.id)).toEqual([1, 3, 2]);
  });

  it('handles all-null values in descending sort without crash', () => {
    const books = [
      makeBook({ id: 1, narrators: [] }),
      makeBook({ id: 2, narrators: [] }),
      makeBook({ id: 3, narrators: [] }),
    ];

    const sorted = sortBooks(books, 'narrator', 'desc');
    // All null — all compare equal, stable sort preserves input order
    expect(sorted).toHaveLength(3);
    expect(sorted.map((b) => b.id)).toEqual([1, 2, 3]);
  });

  it('mixed null/non-null descending: non-null values in descending order, nulls at end', () => {
    const books = [
      makeBook({ id: 1, narrators: [] }),
      makeBook({ id: 2, narrators: [{ id: 1, name: 'Charlie', slug: 'charlie' }] }),
      makeBook({ id: 3, narrators: [] }),
      makeBook({ id: 4, narrators: [{ id: 2, name: 'Alice', slug: 'alice' }] }),
    ];

    const sorted = sortBooks(books, 'narrator', 'desc');
    // Descending values first (Charlie, Alice), then nulls at end
    expect(sorted.map((b) => b.id)).toEqual([2, 4, 1, 3]);
  });

  it('sorts nullable numeric field (size) descending with nulls last', () => {
    const books = [
      makeBook({ id: 1, audioTotalSize: 500, size: null }),
      makeBook({ id: 2, audioTotalSize: null, size: null }),
      makeBook({ id: 3, audioTotalSize: 100, size: null }),
    ];

    const sorted = sortBooks(books, 'size', 'desc');
    // Descending numeric: 500, 100, then null last
    expect(sorted.map((b) => b.id)).toEqual([1, 3, 2]);
  });

  it('series position tiebreaker keeps null positions last regardless of direction', () => {
    const books = [
      makeBook({ id: 1, seriesName: 'WoT', seriesPosition: null }),
      makeBook({ id: 2, seriesName: 'WoT', seriesPosition: 1 }),
      makeBook({ id: 3, seriesName: 'WoT', seriesPosition: 2 }),
    ];

    const sorted = sortBooks(books, 'series', 'desc');
    // Same series descending — positions ascending within, null last
    expect(sorted.map((b) => b.id)).toEqual([2, 3, 1]);
  });
});

// #365 — collapseSeries sorts collapsed result by active sort field
describe('collapseSeries — title-sort uses seriesName key (#365)', () => {
  it('with title asc: collapsed series groups sort by toSortTitle(seriesName) interleaved with standalones', () => {
    // "The Expanse" → sort key "Expanse" (article stripped), representative "Leviathan Wakes"
    // Standalone "Dune" → sort key "Dune"
    // Standalone "Foundation" → sort key "Foundation"
    // Expected order: Dune, The Expanse (E), Foundation
    const books = [
      makeBook({ id: 1, title: 'Leviathan Wakes', seriesName: 'The Expanse', seriesPosition: 1 }),
      makeBook({ id: 2, title: 'Caliban\'s War', seriesName: 'The Expanse', seriesPosition: 2 }),
      makeBook({ id: 3, title: 'Dune', seriesName: null }),
      makeBook({ id: 4, title: 'Foundation', seriesName: null }),
    ];

    const collapsed = collapseSeries(books, 'title', 'asc');
    expect(collapsed.map((b) => b.title)).toEqual(['Dune', 'Leviathan Wakes', 'Foundation']);
  });

  it('with title desc: collapsed series groups sort in reverse order by toSortTitle(seriesName)', () => {
    const books = [
      makeBook({ id: 1, title: 'Leviathan Wakes', seriesName: 'The Expanse', seriesPosition: 1 }),
      makeBook({ id: 2, title: 'Caliban\'s War', seriesName: 'The Expanse', seriesPosition: 2 }),
      makeBook({ id: 3, title: 'Dune', seriesName: null }),
      makeBook({ id: 4, title: 'Foundation', seriesName: null }),
    ];

    // Reverse order: Foundation, The Expanse (E), Dune
    const collapsed = collapseSeries(books, 'title', 'desc');
    expect(collapsed.map((b) => b.title)).toEqual(['Foundation', 'Leviathan Wakes', 'Dune']);
  });

  it('with author asc: collapsed series groups sort by representative author interleaved with standalones', () => {
    const books = [
      makeBook({ id: 1, title: 'Book A', seriesName: 'SeriesX', seriesPosition: 1, authors: [{ id: 1, name: 'Zelazny', slug: 'zelazny' }] }),
      makeBook({ id: 2, title: 'Book B', seriesName: 'SeriesX', seriesPosition: 2, authors: [{ id: 1, name: 'Zelazny', slug: 'zelazny' }] }),
      makeBook({ id: 3, title: 'Book C', seriesName: null, authors: [{ id: 2, name: 'Asimov', slug: 'asimov' }] }),
      makeBook({ id: 4, title: 'Book D', seriesName: null, authors: [{ id: 3, name: 'Martin', slug: 'martin' }] }),
    ];

    // Author order asc: Asimov (Book C), Martin (Book D), Zelazny (SeriesX rep: Book A)
    const collapsed = collapseSeries(books, 'author', 'asc');
    expect(collapsed.map((b) => b.title)).toEqual(['Book C', 'Book D', 'Book A']);
  });

  it('with createdAt desc: collapsed series groups sort by representative date interleaved with standalones', () => {
    const books = [
      makeBook({ id: 1, title: 'Old Series Book', seriesName: 'OldSeries', seriesPosition: 1, createdAt: '2020-01-01T00:00:00Z' }),
      makeBook({ id: 2, title: 'Old Series Book 2', seriesName: 'OldSeries', seriesPosition: 2, createdAt: '2020-02-01T00:00:00Z' }),
      makeBook({ id: 3, title: 'Recent Standalone', seriesName: null, createdAt: '2024-06-01T00:00:00Z' }),
      makeBook({ id: 4, title: 'Ancient Standalone', seriesName: null, createdAt: '2019-01-01T00:00:00Z' }),
    ];

    // createdAt desc: Recent Standalone (2024), Old Series (rep=2020-01), Ancient Standalone (2019)
    const collapsed = collapseSeries(books, 'createdAt', 'desc');
    expect(collapsed.map((b) => b.title)).toEqual(['Recent Standalone', 'Old Series Book', 'Ancient Standalone']);
  });

  it('single-book series appears with collapsedCount 0 and sorts normally', () => {
    const books = [
      makeBook({ id: 1, title: 'Leviathan Wakes', seriesName: 'The Expanse', seriesPosition: 1 }),
      makeBook({ id: 2, title: 'Dune', seriesName: null }),
    ];

    const collapsed = collapseSeries(books, 'title', 'asc');
    const expanse = collapsed.find((b) => b.seriesName === 'The Expanse');
    expect(expanse?.collapsedCount).toBe(0);
    // Dune before Expanse alphabetically
    expect(collapsed.map((b) => b.title)).toEqual(['Dune', 'Leviathan Wakes']);
  });
});

// #287 — collapseSeries fallback with descending nullable sort
describe('collapseSeries — descending nullable fallback (#287)', () => {
  it('fallback representative with descending nullable sort does not pick null-field book', () => {
    const books = [
      makeBook({ id: 1, seriesName: 'WoT', seriesPosition: null, narrators: [] }),
      makeBook({ id: 2, seriesName: 'WoT', seriesPosition: null, narrators: [{ id: 1, name: 'Alice', slug: 'alice' }] }),
    ];

    // No positions → fallback to sortBooks(group, 'narrator', 'desc')
    // Should pick id=2 (Alice) as representative, not id=1 (null narrator)
    const collapsed = collapseSeries(books, 'narrator', 'desc');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].id).toBe(2);
  });
});
