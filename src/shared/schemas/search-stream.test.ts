import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  searchStartEventSchema,
  indexerCompleteEventSchema,
  indexerErrorEventSchema,
  indexerCancelledEventSchema,
  searchResultSchema,
  searchResponseSchema,
  type SearchResultPayload,
  type SearchResponsePayload,
} from './search-stream.js';
import type { SearchResult } from '@core/indexers/types.js';
import type { SearchResponse } from '../../client/lib/api/search.js';

describe('search-stream event schemas', () => {
  it('searchStartEventSchema accepts the canonical search-start payload', () => {
    const result = searchStartEventSchema.safeParse({
      sessionId: 'abc',
      indexers: [{ id: 1, name: 'ABB' }, { id: 2, name: 'MAM' }],
    });
    expect(result.success).toBe(true);
  });

  it('searchStartEventSchema rejects missing indexers', () => {
    const result = searchStartEventSchema.safeParse({ sessionId: 'abc' });
    expect(result.success).toBe(false);
  });

  it('indexerCompleteEventSchema rejects non-numeric indexerId', () => {
    const result = indexerCompleteEventSchema.safeParse({
      indexerId: 'one', name: 'ABB', resultCount: 5, elapsedMs: 100,
    });
    expect(result.success).toBe(false);
  });

  it('indexerErrorEventSchema requires error string', () => {
    const result = indexerErrorEventSchema.safeParse({
      indexerId: 1, name: 'ABB', elapsedMs: 100,
    });
    expect(result.success).toBe(false);
  });

  it('indexerCancelledEventSchema accepts well-formed payload', () => {
    const result = indexerCancelledEventSchema.safeParse({ indexerId: 1, name: 'ABB' });
    expect(result.success).toBe(true);
  });
});

describe('searchResultSchema', () => {
  it('accepts a minimal result with required fields', () => {
    const result = searchResultSchema.safeParse({
      title: 'Book',
      indexer: 'ABB',
      protocol: 'torrent',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing protocol', () => {
    const result = searchResultSchema.safeParse({ title: 'Book', indexer: 'ABB' });
    expect(result.success).toBe(false);
  });

  it('carries format through instead of stripping it', () => {
    const result = searchResultSchema.safeParse({
      title: 'Book', indexer: 'MAM', protocol: 'torrent', format: 'm4b',
    });
    expect(result.success && result.data.format).toBe('m4b');
  });

  it('carries an ABB-shaped result through with its author, narrator and format intact (#2365)', () => {
    const result = searchResultSchema.safeParse({
      title: 'Murder in the New Forest',
      indexer: 'AudioBookBay',
      protocol: 'torrent',
      author: 'Carol Cole',
      narrator: 'James MacNaughton',
      format: 'm4b',
      infoHash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      downloadUrl: 'magnet:?xt=urn:btih:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    });
    expect(result.success && result.data).toMatchObject({
      author: 'Carol Cole',
      narrator: 'James MacNaughton',
      format: 'm4b',
    });
  });

  it('rejects a non-string format', () => {
    const result = searchResultSchema.safeParse({
      title: 'Book', indexer: 'AudioBookBay', protocol: 'torrent', format: 4,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown protocol value', () => {
    const result = searchResultSchema.safeParse({ title: 'Book', indexer: 'ABB', protocol: 'http' });
    expect(result.success).toBe(false);
  });

  it('accepts a result with seeders/leechers absent', () => {
    const result = searchResultSchema.safeParse({
      title: 'Book',
      indexer: 'ABB',
      protocol: 'torrent',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a NaN seeders (negative anchor for the adapter NaN guard)', () => {
    const result = searchResultSchema.safeParse({
      title: 'Book',
      indexer: 'ABB',
      protocol: 'torrent',
      seeders: NaN,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a NaN leechers (negative anchor for the adapter NaN guard)', () => {
    const result = searchResultSchema.safeParse({
      title: 'Book',
      indexer: 'ABB',
      protocol: 'torrent',
      leechers: NaN,
    });
    expect(result.success).toBe(false);
  });
});

describe('searchResponseSchema', () => {
  it('accepts a well-formed search-complete payload', () => {
    const result = searchResponseSchema.safeParse({
      results: [{ title: 'Book', indexer: 'ABB', protocol: 'torrent' }],
      durationUnknown: false,
      unsupportedResults: { count: 0, titles: [] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing unsupportedResults', () => {
    const result = searchResponseSchema.safeParse({
      results: [],
      durationUnknown: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('searchResponseSchema — filteredOut (#2325)', () => {
  const base = { results: [], durationUnknown: false, unsupportedResults: { count: 0, titles: [] } };

  it('accepts and round-trips a well-formed filteredOut summary', () => {
    const filteredOut = {
      total: 4,
      reasons: [
        { reason: 'below-min-size', count: 3, threshold: '50 MB' },
        { reason: 'reject-word-match', count: 1 },
      ],
    };

    const result = searchResponseSchema.safeParse({ ...base, filteredOut });

    expect(result.success).toBe(true);
    expect(result.data?.filteredOut).toEqual(filteredOut);
  });

  it('accepts a payload without the key and leaves it off the parsed output', () => {
    const result = searchResponseSchema.safeParse(base);

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('filteredOut');
  });

  it('rejects a reason outside the closed vocabulary', () => {
    const result = searchResponseSchema.safeParse({
      ...base,
      filteredOut: { total: 1, reasons: [{ reason: 'multi-part-detected', count: 1 }] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-numeric count and a missing total', () => {
    expect(searchResponseSchema.safeParse({
      ...base,
      filteredOut: { total: 1, reasons: [{ reason: 'below-min-size', count: '1' }] },
    }).success).toBe(false);
    expect(searchResponseSchema.safeParse({
      ...base,
      filteredOut: { reasons: [{ reason: 'below-min-size', count: 1 }] },
    }).success).toBe(false);
  });

  it('rejects a null filteredOut — the contract is .optional(), not .nullish()', () => {
    expect(searchResponseSchema.safeParse({ ...base, filteredOut: null }).success).toBe(false);
  });
});

describe('searchResponseSchema — timedOut (#2568)', () => {
  const base = { results: [], durationUnknown: true, unsupportedResults: { count: 0, titles: [] } };

  it('accepts and round-trips timedOut: true', () => {
    const result = searchResponseSchema.safeParse({ ...base, timedOut: true });

    expect(result.success).toBe(true);
    expect(result.data?.timedOut).toBe(true);
  });

  it('accepts a payload without the key and leaves it off the parsed output', () => {
    const result = searchResponseSchema.safeParse(base);

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('timedOut');
  });

  it('rejects a null timedOut — the contract is .optional(), not .nullish()', () => {
    expect(searchResponseSchema.safeParse({ ...base, timedOut: null }).success).toBe(false);
  });

  it.each([['true'], [1]])('rejects a non-boolean timedOut (%s)', (value) => {
    expect(searchResponseSchema.safeParse({ ...base, timedOut: value }).success).toBe(false);
  });
});

describe('searchResultSchema — rawSize (#2316)', () => {
  const base = { title: 'Play of Shadows', protocol: 'torrent', indexer: 'MAM' };

  it('accepts and round-trips a rawSize string', () => {
    const result = searchResultSchema.safeParse({ ...base, size: 1057803469, rawSize: '1,008.8 MiB' });
    expect(result.success).toBe(true);
    expect(result.data?.rawSize).toBe('1,008.8 MiB');
  });

  it('accepts a result without rawSize', () => {
    const result = searchResultSchema.safeParse(base);
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('rawSize');
  });

  it('rejects a non-string rawSize', () => {
    const result = searchResultSchema.safeParse({ ...base, rawSize: 1057803469 });
    expect(result.success).toBe(false);
  });
});

describe('searchResultSchema — bitrateKbps (#2504)', () => {
  const base = { title: 'Jurassic Park', protocol: 'torrent', indexer: 'AudioBookBay' };

  it('accepts and round-trips a kbps integer', () => {
    const result = searchResultSchema.safeParse({ ...base, bitrateKbps: 64 });
    expect(result.success).toBe(true);
    expect(result.data?.bitrateKbps).toBe(64);
  });

  it('accepts a result without the key and leaves it off the parsed output', () => {
    const result = searchResultSchema.safeParse(base);
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('bitrateKbps');
  });

  // Deliberately unbounded above: a lossless listing reports 1411, which `bitrateField`'s 32-512
  // encoder range would reject. This is the case that reds if someone "tidies" the two together.
  it('accepts a lossless-scale value with no upper bound', () => {
    const result = searchResultSchema.safeParse({ ...base, bitrateKbps: 1411 });
    expect(result.success).toBe(true);
    expect(result.data?.bitrateKbps).toBe(1411);
  });

  it.each<[string | number, string]>([
    ['64 Kbps', 'a display string — what a formatting shortcut would send'],
    [64.5, 'a fraction'],
    [-64, 'a negative'],
    [0, 'zero, the absence decision enforced at the wire'],
    [NaN, 'NaN'],
  ])('rejects %s — %s', (value) => {
    expect(searchResultSchema.safeParse({ ...base, bitrateKbps: value }).success).toBe(false);
  });
});

describe('searchResultSchema — unsatisfied (#2322)', () => {
  const base = { title: 'Play of Shadows', protocol: 'torrent', indexer: 'MAM' };

  it('accepts and round-trips the observed pair', () => {
    const result = searchResultSchema.safeParse({ ...base, unsatisfied: { count: 150, limit: 150 } });
    expect(result.success).toBe(true);
    expect(result.data?.unsatisfied).toEqual({ count: 150, limit: 150 });
  });

  it('accepts a result carrying nothing — absence is the fail-open default', () => {
    const result = searchResultSchema.safeParse(base);
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('unsatisfied');
  });

  it('rejects a partial pair, so no consumer sees a half-observed object', () => {
    expect(searchResultSchema.safeParse({ ...base, unsatisfied: { count: 150 } }).success).toBe(false);
    expect(searchResultSchema.safeParse({ ...base, unsatisfied: { limit: 150 } }).success).toBe(false);
  });
});

// Normalize Zod's ?: T | undefined before comparing exact-optional DTOs.
type TightenOptional<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

describe('schema/interface compatibility', () => {
  it('searchResultSchema is structurally compatible with SearchResult', () => {
    expectTypeOf<TightenOptional<SearchResultPayload>>().branded.toEqualTypeOf<SearchResult>();
  });

  it('searchResponseSchema is structurally compatible with SearchResponse', () => {
    type TightSearchResponse = Omit<SearchResponsePayload, 'results'> & { results: TightenOptional<SearchResultPayload>[] };
    expectTypeOf<TightSearchResponse>().branded.toEqualTypeOf<SearchResponse>();
  });
});
