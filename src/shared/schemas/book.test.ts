import { describe, expect, it } from 'vitest';
import {
  createBookBodySchema,
  updateBookBodySchema,
  enrichmentStatusSchema,
  BOOK_STATUSES,
  LIBRARY_FILTER_BUCKETS,
  LIBRARY_FILTER_BUCKET_KEYS,
  LIBRARY_FILTER_VALUES,
  libraryStatusFilterSchema,
} from './book.js';

describe('enrichmentStatusSchema', () => {
  it.each(['pending', 'enriched', 'failed', 'skipped', 'file-enriched'] as const)(
    'accepts valid value: %s',
    (value) => {
      expect(enrichmentStatusSchema.parse(value)).toBe(value);
    },
  );

  it('rejects invalid value', () => {
    expect(() => enrichmentStatusSchema.parse('invalid')).toThrow();
  });
});

const validBook = {
  title: 'My Book',
  authors: [{ name: 'Author Name' }],
};

describe('LIBRARY_FILTER_BUCKETS — canonical lifecycle partition (#1444)', () => {
  const bucketStates = Object.values(LIBRARY_FILTER_BUCKETS).flat();

  it('only references canonical BookLifecycle states', () => {
    const canonical = new Set<string>(BOOK_STATUSES);
    for (const state of bucketStates) {
      expect(canonical.has(state)).toBe(true);
    }
  });

  it('covers every canonical state (union equals the full state set)', () => {
    expect([...bucketStates].sort()).toEqual([...BOOK_STATUSES].sort());
  });

  it('partitions the state set — buckets are pairwise disjoint (no state in two buckets)', () => {
    // A correct partition has exactly one bucket per state, so the flattened
    // membership list has no duplicates and its length equals the state count.
    expect(new Set(bucketStates).size).toBe(bucketStates.length);
    expect(bucketStates.length).toBe(BOOK_STATUSES.length);
  });

  it('groups the transient states as designed (Downloading / Imported)', () => {
    expect([...LIBRARY_FILTER_BUCKETS.downloading]).toEqual(['searching', 'downloading']);
    expect([...LIBRARY_FILTER_BUCKETS.imported]).toEqual(['importing', 'imported']);
  });

  it('exposes `all` plus one value per bucket as the dropdown values', () => {
    expect([...LIBRARY_FILTER_VALUES]).toEqual(['all', ...Object.keys(LIBRARY_FILTER_BUCKETS)]);
  });
});

describe('libraryStatusFilterSchema — bucket-only wire contract (#1447)', () => {
  it('accepts each of the five concrete bucket keys', () => {
    for (const key of LIBRARY_FILTER_BUCKET_KEYS) {
      expect(libraryStatusFilterSchema.parse(key)).toBe(key);
    }
  });

  it('rejects the client-only `all` sentinel (never sent over the wire)', () => {
    expect(libraryStatusFilterSchema.safeParse('all').success).toBe(false);
  });

  it('rejects non-bucket canonical statuses (searching / importing)', () => {
    expect(libraryStatusFilterSchema.safeParse('searching').success).toBe(false);
    expect(libraryStatusFilterSchema.safeParse('importing').success).toBe(false);
  });

  it('bucket keys are a subset of the canonical BookStatus set', () => {
    const canonical = new Set<string>(BOOK_STATUSES);
    for (const key of LIBRARY_FILTER_BUCKET_KEYS) {
      expect(canonical.has(key)).toBe(true);
    }
  });

  it('bucket keys == LIBRARY_FILTER_VALUES minus `all`', () => {
    expect([...LIBRARY_FILTER_BUCKET_KEYS]).toEqual(LIBRARY_FILTER_VALUES.filter((v) => v !== 'all'));
  });
});

describe('createBookBodySchema — series ASIN (#1071)', () => {
  it('accepts seriesAsin alongside scalar seriesName/seriesPosition', () => {
    const result = createBookBodySchema.safeParse({
      ...validBook,
      seriesName: 'The Band',
      seriesPosition: 1,
      seriesAsin: 'B07DHQY7DX',
      seriesProvider: 'audible',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seriesAsin).toBe('B07DHQY7DX');
      expect(result.data.seriesProvider).toBe('audible');
    }
  });

  it('treats seriesAsin/seriesProvider as optional (back-compat)', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, seriesName: 'The Band', seriesPosition: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seriesAsin).toBeUndefined();
    }
  });
});

describe('createBookBodySchema — authors default (#246)', () => {
  it('accepts payload with title only, no authors field — defaults to []', () => {
    const result = createBookBodySchema.safeParse({ title: 'Shogun' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.authors).toEqual([]);
    }
  });

  it('accepts payload with title + explicit authors array', () => {
    const result = createBookBodySchema.safeParse({ title: 'Shogun', authors: [{ name: 'James Clavell' }] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.authors).toEqual([{ name: 'James Clavell' }]);
    }
  });

  it('accepts payload with title + empty authors array', () => {
    const result = createBookBodySchema.safeParse({ title: 'Shogun', authors: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.authors).toEqual([]);
    }
  });
});

describe('createBookBodySchema — trim behavior', () => {
  it('rejects whitespace-only title', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, title: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from title', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, title: '  My Book  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.title).toBe('My Book');
  });

  it('accepts valid title', () => {
    const result = createBookBodySchema.safeParse(validBook);
    expect(result.success).toBe(true);
  });
});

describe('createBookBodySchema / updateBookBodySchema — removed monitorForUpgrades (#1103)', () => {
  it('createBookBodySchema rejects requests containing monitorForUpgrades', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, monitorForUpgrades: true });
    expect(result.success).toBe(false);
  });

  it('updateBookBodySchema rejects requests containing monitorForUpgrades', () => {
    const result = updateBookBodySchema.safeParse({ monitorForUpgrades: false });
    expect(result.success).toBe(false);
  });
});
