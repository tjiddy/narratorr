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
