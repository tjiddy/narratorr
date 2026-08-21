import { describe, expect, it } from 'vitest';
import {
  addBookConflictSchema,
  createBookBodySchema,
  updateBookBodySchema,
  enrichmentStatusSchema,
  BOOK_STATUSES,
  LIBRARY_FILTER_BUCKETS,
  LIBRARY_FILTER_BUCKET_KEYS,
  LIBRARY_FILTER_VALUES,
  libraryStatusFilterSchema,
  bucketForStatus,
  invertLibraryFilterBuckets,
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

describe('bucketForStatus — derived status→bucket inverse (#2541)', () => {
  it('is total over BOOK_STATUSES and round-trips through LIBRARY_FILTER_BUCKETS', () => {
    for (const status of BOOK_STATUSES) {
      const bucket = bucketForStatus(status);
      expect(LIBRARY_FILTER_BUCKETS[bucket]).toContain(status);
    }
  });

  it('produces every bucket key — no bucket is left without a member status', () => {
    const produced = new Set(BOOK_STATUSES.map(bucketForStatus));
    expect([...produced].sort()).toEqual([...LIBRARY_FILTER_BUCKET_KEYS].sort());
  });

  // The two sub-transitions the series badge keys on: both sides of each pair must fold together,
  // or the badge flickers mid-grab and mid-import.
  it('folds searching and downloading onto the same bucket', () => {
    expect(bucketForStatus('searching')).toBe('downloading');
    expect(bucketForStatus('downloading')).toBe('downloading');
  });

  it('folds importing and imported onto the same bucket', () => {
    expect(bucketForStatus('importing')).toBe('imported');
    expect(bucketForStatus('imported')).toBe('imported');
  });

  it('is derived from the partition, not a second literal map', () => {
    const swapped = invertLibraryFilterBuckets({
      ...LIBRARY_FILTER_BUCKETS,
      wanted: ['wanted', 'importing'],
      imported: ['imported'],
    });
    expect(swapped.importing).toBe('wanted');
  });

  it('throws rather than yielding undefined when a status has no bucket', () => {
    expect(() =>
      invertLibraryFilterBuckets({ ...LIBRARY_FILTER_BUCKETS, missing: [] }),
    ).toThrow(/missing/);
  });
});

describe('invertLibraryFilterBuckets — duplicate membership guard (#2546)', () => {
  // Which bucket is "first" follows object-literal iteration order, so each case asserts the
  // presence of the status and both bucket keys rather than pinning one ordered sentence.
  it('throws when a status is claimed by two different buckets, naming both', () => {
    let thrown: unknown;
    try {
      invertLibraryFilterBuckets({ ...LIBRARY_FILTER_BUCKETS, wanted: ['wanted', 'imported'] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('duplicated');
    expect(message).toContain('imported');
    expect(message).toContain('wanted');
  });

  it('throws when a status is listed twice inside a single bucket', () => {
    expect(() =>
      invertLibraryFilterBuckets({ ...LIBRARY_FILTER_BUCKETS, wanted: ['wanted', 'wanted'] }),
    ).toThrow(/duplicated: wanted in both wanted and wanted/);
  });

  it('names every duplicated status, not just the first one found', () => {
    let message = '';
    try {
      invertLibraryFilterBuckets({
        ...LIBRARY_FILTER_BUCKETS,
        wanted: ['wanted', 'imported', 'failed'],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('imported');
    expect(message).toContain('failed');
  });

  it('catches a duplicate in the first array position as well as the last', () => {
    expect(() =>
      invertLibraryFilterBuckets({ ...LIBRARY_FILTER_BUCKETS, missing: ['wanted', 'missing'] }),
    ).toThrow(/duplicated/);
    expect(() =>
      invertLibraryFilterBuckets({ ...LIBRARY_FILTER_BUCKETS, missing: ['missing', 'wanted'] }),
    ).toThrow(/duplicated/);
  });

  it('reports the duplicate, not the orphan, when a partition has both', () => {
    let thrown: unknown;
    try {
      invertLibraryFilterBuckets({
        ...LIBRARY_FILTER_BUCKETS,
        wanted: ['wanted', 'failed'],
        missing: [],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('duplicated');
    expect((thrown as Error).message).not.toContain('unbucketed');
  });

  it('accepts the production partition and returns one entry per canonical status', () => {
    const inverse = invertLibraryFilterBuckets(LIBRARY_FILTER_BUCKETS);
    expect(Object.keys(inverse).sort()).toEqual([...BOOK_STATUSES].sort());
    for (const status of BOOK_STATUSES) {
      expect(LIBRARY_FILTER_BUCKETS[inverse[status]]).toContain(status);
    }
  });

  // An empty bucket is not by itself a defect: this is still a total, non-overlapping cover.
  it('accepts an empty bucket whose status is covered elsewhere', () => {
    const inverse = invertLibraryFilterBuckets({
      ...LIBRARY_FILTER_BUCKETS,
      wanted: ['wanted', 'missing'],
      missing: [],
    });
    expect(inverse.missing).toBe('wanted');
  });
});

describe('createBookBodySchema — series scalars (#1716)', () => {
  it('accepts scalar seriesName/seriesPosition', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, seriesName: 'The Band', seriesPosition: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seriesName).toBe('The Band');
      expect(result.data.seriesPosition).toBe(1);
    }
  });

  it('rejects a body carrying the removed seriesAsin field (strict)', () => {
    const result = createBookBodySchema.safeParse({
      ...validBook,
      seriesName: 'The Band',
      seriesPosition: 1,
      seriesAsin: 'B07DHQY7DX',
    });
    expect(result.success).toBe(false);
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

describe('updateBookBodySchema — nullable metadata fields (#1609)', () => {
  it('accepts null for description, coverUrl, publishedDate, and genres (clear)', () => {
    const result = updateBookBodySchema.safeParse({
      description: null,
      coverUrl: null,
      publishedDate: null,
      genres: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a genres string array and a publishedDate string (set)', () => {
    const result = updateBookBodySchema.safeParse({
      genres: ['Fantasy', 'Epic'],
      publishedDate: '2010-08-31',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.genres).toEqual(['Fantasy', 'Epic']);
      expect(result.data.publishedDate).toBe('2010-08-31');
    }
  });

  it('accepts a string description and coverUrl (set)', () => {
    const result = updateBookBodySchema.safeParse({
      description: 'A great book.',
      coverUrl: 'https://example.com/cover.jpg',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-string publishedDate', () => {
    const result = updateBookBodySchema.safeParse({ publishedDate: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-array genres value', () => {
    const result = updateBookBodySchema.safeParse({ genres: 'Fantasy' });
    expect(result.success).toBe(false);
  });

  it('omitting the fields entirely still validates (unchanged)', () => {
    const result = updateBookBodySchema.safeParse({ title: 'Just a title' });
    expect(result.success).toBe(true);
  });
});

describe('updateBookBodySchema — subtitle/publisher (#1614)', () => {
  it('accepts a string subtitle and publisher (set)', () => {
    const result = updateBookBodySchema.safeParse({ subtitle: 'A Subtitle', publisher: 'Tor Books' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subtitle).toBe('A Subtitle');
      expect(result.data.publisher).toBe('Tor Books');
    }
  });

  it('accepts null for subtitle and publisher (clear)', () => {
    const result = updateBookBodySchema.safeParse({ subtitle: null, publisher: null });
    expect(result.success).toBe(true);
  });

  it('omitting subtitle/publisher still validates (unchanged)', () => {
    const result = updateBookBodySchema.safeParse({ title: 'Just a title' });
    expect(result.success).toBe(true);
  });

  it('rejects a non-string subtitle', () => {
    const result = updateBookBodySchema.safeParse({ subtitle: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string publisher', () => {
    const result = updateBookBodySchema.safeParse({ publisher: 123 });
    expect(result.success).toBe(false);
  });

  it('still rejects an unknown key via .strict()', () => {
    const result = updateBookBodySchema.safeParse({ subtitle: 'A Subtitle', bogus: true });
    expect(result.success).toBe(false);
  });
});

describe('createBookBodySchema — subtitle/publisher (#1614)', () => {
  it('accepts optional subtitle and publisher strings', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, subtitle: 'A Subtitle', publisher: 'Tor Books' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subtitle).toBe('A Subtitle');
      expect(result.data.publisher).toBe('Tor Books');
    }
  });

  it('omitting subtitle/publisher is valid', () => {
    const result = createBookBodySchema.safeParse(validBook);
    expect(result.success).toBe(true);
  });

  it('rejects a non-string subtitle', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, subtitle: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string publisher', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, publisher: 123 });
    expect(result.success).toBe(false);
  });

  it('still rejects an unknown key via .strict()', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, subtitle: 'A Subtitle', bogus: true });
    expect(result.success).toBe(false);
  });
});

describe('addBookConflictSchema — the POST /api/books 409 discriminator (#2199)', () => {
  it('carries exactly the three conflict values', () => {
    expect([...addBookConflictSchema.options].sort()).toEqual(
      ['owned-race', 'review', 'same-recording'],
    );
  });

  // `different-recording` is a canonical recording verdict that never produces a 409, and
  // `owned-race` is not a recording verdict at all; the two unions must not drift together.
  it('rejects a canonical recording verdict that never reaches a 409', () => {
    expect(addBookConflictSchema.safeParse('different-recording').success).toBe(false);
  });

  it('rejects an unknown conflict value', () => {
    expect(addBookConflictSchema.safeParse('maybe-owned').success).toBe(false);
  });
});

describe('createBookBodySchema — provider formatType and the review override (#2199)', () => {
  it('accepts a provider formatType', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, formatType: 'Abridged' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.formatType).toBe('Abridged');
  });

  // Providers report an absent format as null; a 400 there would be a worse answer than `unknown`.
  it('accepts a null formatType', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, formatType: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.formatType).toBeNull();
  });

  it('accepts an absent formatType', () => {
    const result = createBookBodySchema.safeParse(validBook);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.formatType).toBeUndefined();
  });

  it('rejects a non-string formatType', () => {
    expect(createBookBodySchema.safeParse({ ...validBook, formatType: 7 }).success).toBe(false);
  });

  it('accepts the review override', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, overrideRecordingReview: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.overrideRecordingReview).toBe(true);
  });

  it('rejects a non-boolean review override', () => {
    expect(createBookBodySchema.safeParse({ ...validBook, overrideRecordingReview: 'yes' }).success).toBe(false);
  });

  it('still rejects an unknown top-level field alongside the new ones', () => {
    const result = createBookBodySchema.safeParse({
      ...validBook, formatType: 'Unabridged', overrideRecordingReview: true, bogus: true,
    });
    expect(result.success).toBe(false);
  });
});
