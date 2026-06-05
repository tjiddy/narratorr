import { describe, it, expect, vi } from 'vitest';
import {
  computeAuthorOverlap,
  normalizeSeriesNameForResolver,
  pickBestSearchCandidate,
  resolveSeriesViaHardcover,
} from './hardcover-series-resolver.js';
import type { HardcoverClient, HardcoverSearchCandidate, HardcoverSeriesData } from '../../core/metadata/hardcover.js';

function makeClient(overrides: Partial<HardcoverClient>): HardcoverClient {
  return {
    getSeriesMembers: vi.fn(),
    getSeriesMembersById: vi.fn(),
    searchSeries: vi.fn(),
    ...overrides,
  } as unknown as HardcoverClient;
}

const stubSeries = (id: number): HardcoverSeriesData => ({
  id,
  name: 'Series',
  slug: 'series',
  authorName: 'A',
  members: [],
});

describe('normalizeSeriesNameForResolver', () => {
  it('strips leading "The "', () => {
    expect(normalizeSeriesNameForResolver('The Stormlight Archive')).toBe('stormlight archive');
  });
  it('strips trailing series/trilogy/saga/novella markers', () => {
    expect(normalizeSeriesNameForResolver('Mistborn Trilogy')).toBe('mistborn');
    expect(normalizeSeriesNameForResolver('Foo Saga')).toBe('foo');
    expect(normalizeSeriesNameForResolver('Bar Series')).toBe('bar');
    expect(normalizeSeriesNameForResolver('Baz Novella')).toBe('baz');
  });
  it('normalizes curly apostrophes to straight', () => {
    expect(normalizeSeriesNameForResolver("Hitchhiker’s Guide")).toBe("hitchhiker's guide");
  });
});

describe('computeAuthorOverlap', () => {
  it('returns 1 for identical tokens', () => {
    expect(computeAuthorOverlap('Brandon Sanderson', 'Brandon Sanderson')).toBe(1);
  });
  it('returns 0 for fully disjoint tokens', () => {
    expect(computeAuthorOverlap('Brandon Sanderson', 'John Doe')).toBe(0);
  });
  it('returns 0 when either side is empty', () => {
    expect(computeAuthorOverlap('', 'Foo Bar')).toBe(0);
    expect(computeAuthorOverlap('Foo Bar', '')).toBe(0);
  });
  it('normalizes punctuation before comparing', () => {
    expect(computeAuthorOverlap('B. Sanderson', 'B Sanderson')).toBe(1);
  });
});

describe('pickBestSearchCandidate', () => {
  const candidate = (overrides: Partial<HardcoverSearchCandidate>): HardcoverSearchCandidate => ({
    id: 1, name: 'Stormlight Archive', slug: 's', authorName: 'Brandon Sanderson', booksCount: 5, imageUrl: null,
    ...overrides,
  });

  it('selects the top-scoring candidate that crosses both gates', () => {
    const best = pickBestSearchCandidate('Stormlight Archive', 'Brandon Sanderson', [
      candidate({ id: 1, name: 'Stormlight Archive', authorName: 'Brandon Sanderson' }),
      candidate({ id: 2, name: 'Completely Different', authorName: 'Someone Else' }),
    ]);
    expect(best?.id).toBe(1);
  });

  it('returns null when no candidate crosses thresholds', () => {
    const best = pickBestSearchCandidate('Stormlight Archive', 'Brandon Sanderson', [
      candidate({ id: 1, name: 'Some Other Series', authorName: 'Unknown Author' }),
    ]);
    expect(best).toBeNull();
  });

  it('rejects high name-sim when author overlap is below the author gate', () => {
    // Same exact name, but author has zero overlap → blocked by the double gate.
    const best = pickBestSearchCandidate('Stormlight Archive', 'Brandon Sanderson', [
      candidate({ id: 1, name: 'Stormlight Archive', authorName: 'Different Person' }),
    ]);
    expect(best).toBeNull();
  });

  it('breaks ties on books_count (higher wins)', () => {
    const best = pickBestSearchCandidate('Stormlight Archive', 'Brandon Sanderson', [
      candidate({ id: 1, name: 'Stormlight Archive', authorName: 'Brandon Sanderson', booksCount: 3 }),
      candidate({ id: 2, name: 'Stormlight Archive', authorName: 'Brandon Sanderson', booksCount: 5 }),
    ]);
    expect(best?.id).toBe(2);
  });

  it('breaks ties on id ascending after books_count tie', () => {
    const best = pickBestSearchCandidate('Stormlight Archive', 'Brandon Sanderson', [
      candidate({ id: 10, name: 'Stormlight Archive', authorName: 'Brandon Sanderson', booksCount: 5 }),
      candidate({ id: 7, name: 'Stormlight Archive', authorName: 'Brandon Sanderson', booksCount: 5 }),
    ]);
    expect(best?.id).toBe(7);
  });

  it('drops candidates with booksCount: 0', () => {
    const best = pickBestSearchCandidate('Stormlight Archive', 'Brandon Sanderson', [
      candidate({ id: 1, name: 'Stormlight Archive', authorName: 'Brandon Sanderson', booksCount: 0 }),
    ]);
    expect(best).toBeNull();
  });

  it('drops candidates with no author', () => {
    const best = pickBestSearchCandidate('Stormlight Archive', 'Brandon Sanderson', [
      candidate({ id: 1, name: 'Stormlight Archive', authorName: null, booksCount: 5 }),
    ]);
    expect(best).toBeNull();
  });
});

describe('resolveSeriesViaHardcover — 3-step chain', () => {
  it('step 1 hit: returns the exact match; does not call steps 2 or 3', async () => {
    const exact = stubSeries(1);
    const getSeriesMembers = vi.fn().mockResolvedValueOnce(exact);
    const searchSeries = vi.fn();
    const client = makeClient({ getSeriesMembers, searchSeries });

    const result = await resolveSeriesViaHardcover(client, { seriesName: 'The Band', author: 'Eames' });

    expect(result).toBe(exact);
    expect(getSeriesMembers).toHaveBeenCalledTimes(1);
    expect(searchSeries).not.toHaveBeenCalled();
  });

  it('step 2 hit: normalized name matches after step 1 misses', async () => {
    const normalized = stubSeries(2);
    const getSeriesMembers = vi.fn()
      .mockResolvedValueOnce(null) // step 1 — exact miss
      .mockResolvedValueOnce(normalized); // step 2 — normalized hit
    const searchSeries = vi.fn();
    const client = makeClient({ getSeriesMembers, searchSeries });

    const result = await resolveSeriesViaHardcover(client, { seriesName: 'The Stormlight Archive', author: 'Sanderson' });

    expect(result).toBe(normalized);
    expect(getSeriesMembers).toHaveBeenCalledTimes(2);
    expect(searchSeries).not.toHaveBeenCalled();
  });

  it('step 3 hit: search-fallback picks the best candidate and fetches by id', async () => {
    const final = stubSeries(99);
    const getSeriesMembers = vi.fn().mockResolvedValue(null); // 1+2 miss
    const searchSeries = vi.fn().mockResolvedValueOnce([
      { id: 99, name: 'Stormlight Archive', slug: 's', authorName: 'Brandon Sanderson', booksCount: 5 },
    ]);
    const getSeriesMembersById = vi.fn().mockResolvedValueOnce(final);
    const client = makeClient({ getSeriesMembers, searchSeries, getSeriesMembersById });

    const result = await resolveSeriesViaHardcover(client, { seriesName: 'Stormlight Archive', author: 'Brandon Sanderson' });

    expect(result).toBe(final);
    expect(searchSeries).toHaveBeenCalledTimes(1);
    expect(getSeriesMembersById).toHaveBeenCalledWith(99);
  });

  it('all 3 steps miss: returns null', async () => {
    const client = makeClient({
      getSeriesMembers: vi.fn().mockResolvedValue(null),
      searchSeries: vi.fn().mockResolvedValueOnce([]),
    });
    const result = await resolveSeriesViaHardcover(client, { seriesName: 'Unknown', author: 'Unknown' });
    expect(result).toBeNull();
  });
});
