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
import type { SearchResult } from '../../core/indexers/types.js';
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

  it('rejects unknown protocol value', () => {
    const result = searchResultSchema.safeParse({ title: 'Book', indexer: 'ABB', protocol: 'http' });
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

/**
 * AC1 — compile-time compatibility assertions between the Zod-inferred types
 * and the existing TS interfaces that describe the same shapes today. If the
 * Zod schemas drift from the canonical interfaces, these assertions fail at
 * `pnpm typecheck` so silent skew can't ship.
 *
 * Zod's `.optional()` infers `?: T | undefined`, but the canonical DTOs use
 * `?: T` (strict optional, no explicit-undefined) — under `exactOptionalPropertyTypes`
 * those are different types. `TightenOptional<T>` strips the `| undefined`
 * representation artifact so the assertion catches real key/value drift,
 * not the Zod inference shape.
 */
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
