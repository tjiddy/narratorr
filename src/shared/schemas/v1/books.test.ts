import { describe, it, expect } from 'vitest';
import {
  bookV1Schema,
  bookV1ListQuerySchema,
  toBookV1,
} from './books.js';
import type { CompanionEbookV1 } from './companion-ebook.js';

const COMPANION: CompanionEbookV1 = { format: 'epub', sizeBytes: 42 };

function makeLeakyRow() {
  return {
    id: 42,
    publicId: 'bk_abc123',
    title: 'Wool',
    status: 'imported' as const,
    seriesName: 'Silo',
    seriesPosition: 1,
    lastGrabGuid: 'guid-leak',
    lastGrabInfoHash: 'hash-leak',
    importListId: 7,
    enrichmentStatus: 'enriched',
    asin: 'B00LEAK',
    slug: 'wool',
    createdAt: new Date('2020-01-01'),
    updatedAt: new Date('2020-01-02'),
    authors: [
      { id: 1, publicId: 'au_one', name: 'Hugh Howey', slug: 'hugh-howey', asin: 'AULEAK', createdAt: new Date(), updatedAt: new Date() },
    ],
    narrators: [
      { id: 9, publicId: 'nr_one', name: 'Minnie Goode', slug: 'minnie-goode', createdAt: new Date(), updatedAt: new Date() },
    ],
  };
}

describe('toBookV1 projection (zero-leak)', () => {
  it('emits exactly { id, title, authors, narrators, series, status, companionEbook } — no internal fields', () => {
    const dto = toBookV1(makeLeakyRow(), null);
    expect(Object.keys(dto).sort()).toEqual(['authors', 'companionEbook', 'id', 'narrators', 'series', 'status', 'title']);
  });

  it('maps id to the opaque publicId (string), not the numeric rowid', () => {
    const dto = toBookV1(makeLeakyRow(), null);
    expect(dto.id).toBe('bk_abc123');
  });

  it('maps each author/narrator id to the entity publicId and exposes only { id, name }', () => {
    const dto = toBookV1(makeLeakyRow(), null);
    expect(dto.authors).toEqual([{ id: 'au_one', name: 'Hugh Howey' }]);
    expect(Object.keys(dto.authors[0]!).sort()).toEqual(['id', 'name']);
    expect(dto.narrators).toEqual([{ id: 'nr_one', name: 'Minnie Goode' }]);
    expect(Object.keys(dto.narrators[0]!).sort()).toEqual(['id', 'name']);
  });

  it('copies status through from the row (canonical BOOK_STATUSES literal)', () => {
    expect(toBookV1(makeLeakyRow(), null).status).toBe('imported');
    expect(toBookV1({ ...makeLeakyRow(), status: 'wanted' }, null).status).toBe('wanted');
  });

  describe('series shape', () => {
    it('projects { name, position } from seriesName/seriesPosition', () => {
      const dto = toBookV1({ ...makeLeakyRow(), seriesName: 'Wool', seriesPosition: 2 }, null);
      expect(dto.series).toEqual({ name: 'Wool', position: 2 });
    });

    it('keeps a null position when seriesPosition is null', () => {
      const dto = toBookV1({ ...makeLeakyRow(), seriesName: 'Wool', seriesPosition: null }, null);
      expect(dto.series).toEqual({ name: 'Wool', position: null });
    });

    it('is null when seriesName is null', () => {
      expect(toBookV1({ ...makeLeakyRow(), seriesName: null, seriesPosition: null }, null).series).toBeNull();
    });

    it('is null when seriesName is empty', () => {
      expect(toBookV1({ ...makeLeakyRow(), seriesName: '', seriesPosition: 3 }, null).series).toBeNull();
    });
  });

  describe('edges', () => {
    it('yields empty arrays for a book with no authors/narrators (no throw)', () => {
      const dto = toBookV1({ ...makeLeakyRow(), authors: [], narrators: [] }, null);
      expect(dto.authors).toEqual([]);
      expect(dto.narrators).toEqual([]);
    });

    it('preserves the given author/narrator order (DTO does not re-shuffle)', () => {
      const dto = toBookV1({
        ...makeLeakyRow(),
        authors: [
          { publicId: 'au_b', name: 'Beta' },
          { publicId: 'au_a', name: 'Alpha' },
        ],
        narrators: [
          { publicId: 'nr_z', name: 'Zed' },
          { publicId: 'nr_y', name: 'Yan' },
        ],
      }, null);
      expect(dto.authors.map((a) => a.id)).toEqual(['au_b', 'au_a']);
      expect(dto.narrators.map((n) => n.id)).toEqual(['nr_z', 'nr_y']);
    });
  });

  describe('companionEbook second argument (#1961)', () => {
    it('copies the supplied companion object through unchanged', () => {
      const dto = toBookV1(makeLeakyRow(), COMPANION);
      expect(dto.companionEbook).toEqual({ format: 'epub', sizeBytes: 42 });
    });

    it('emits companionEbook: null with the KEY PRESENT when null is supplied', () => {
      const dto = toBookV1(makeLeakyRow(), null);
      expect(dto.companionEbook).toBeNull();
      expect(Object.keys(dto)).toContain('companionEbook');
    });

    it('does not derive the value from the row — a leaky row with its own companion fields is ignored', () => {
      const dto = toBookV1(
        { ...makeLeakyRow(), companionEbook: { format: 'pdf', sizeBytes: 9 } } as never,
        COMPANION,
      );
      expect(dto.companionEbook).toEqual(COMPANION);
    });

    it('cannot inject extra keys — the DTO key set is unchanged by a companion argument', () => {
      const dto = toBookV1(makeLeakyRow(), { ...COMPANION, path: '/leak.epub' } as never);
      expect(Object.keys(dto).sort()).toEqual(['authors', 'companionEbook', 'id', 'narrators', 'series', 'status', 'title']);
      expect(bookV1Schema.safeParse(dto).success).toBe(false);
    });

    it('index-argument regression guard: [row].map(toBookV1) produces a numeric companionEbook that the schema rejects', () => {
      const dtos = [makeLeakyRow()].map(toBookV1 as never) as { companionEbook: unknown }[];
      expect(typeof dtos[0]!.companionEbook).toBe('number');
      expect(bookV1Schema.safeParse(dtos[0]).success).toBe(false);
    });
  });
});

describe('bookV1Schema (fail-closed, .strict())', () => {
  const valid = {
    id: 'bk_1',
    title: 'Wool',
    authors: [{ id: 'au_1', name: 'Hugh' }],
    narrators: [],
    series: null,
    status: 'imported',
    companionEbook: null,
  };

  it('round-trips a projected DTO', () => {
    expect(bookV1Schema.safeParse(valid).success).toBe(true);
  });

  it('rejects (does NOT strip) a top-level internal leak like lastGrabInfoHash', () => {
    const result = bookV1Schema.safeParse({ ...valid, lastGrabInfoHash: 'hash-leak' });
    expect(result.success).toBe(false);
  });

  it('rejects a nested author leak (slug/asin/timestamps)', () => {
    const result = bookV1Schema.safeParse({
      ...valid,
      authors: [{ id: 'au_1', name: 'Hugh', slug: 'hugh' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-canonical status', () => {
    expect(bookV1Schema.safeParse({ ...valid, status: 'downloading-ish' }).success).toBe(false);
  });

  describe('companionEbook member (#1961)', () => {
    it('accepts an exposed companion object', () => {
      expect(bookV1Schema.safeParse({ ...valid, companionEbook: { format: 'epub', sizeBytes: 0 } }).success).toBe(true);
    });

    it('rejects a DTO with companionEbook MISSING (required, not optional)', () => {
      const { companionEbook: _omitted, ...withoutCompanion } = valid;
      expect(bookV1Schema.safeParse(withoutCompanion).success).toBe(false);
    });

    it('rejects a non-epub format and an unknown nested key (strict + literal)', () => {
      expect(bookV1Schema.safeParse({ ...valid, companionEbook: { format: 'pdf', sizeBytes: 1 } }).success).toBe(false);
      expect(
        bookV1Schema.safeParse({ ...valid, companionEbook: { format: 'epub', sizeBytes: 1, path: '/x' } }).success,
      ).toBe(false);
    });
  });
});

describe('bookV1ListQuerySchema (composed, strict)', () => {
  it('accepts the documented params', () => {
    const result = bookV1ListQuerySchema.safeParse({
      limit: '50',
      offset: '0',
      status: 'downloading',
      author: 'Hugh',
      series: 'Silo',
      narrator: 'Minnie',
      sortField: 'title',
      sortDirection: 'asc',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
    }
  });

  it('rejects unknown query params (misspelled cursor / snake_case sort_by)', () => {
    expect(bookV1ListQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false);
    expect(bookV1ListQuerySchema.safeParse({ sort_by: 'title' }).success).toBe(false);
  });

  it('rejects a non-canonical status (library bucket-only / unknown value)', () => {
    expect(bookV1ListQuerySchema.safeParse({ status: 'all' }).success).toBe(false);
    expect(bookV1ListQuerySchema.safeParse({ status: 'bogus' }).success).toBe(false);
  });

  it('enforces pagination bounds', () => {
    expect(bookV1ListQuerySchema.safeParse({ limit: '500' }).success).toBe(true);
    expect(bookV1ListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(bookV1ListQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
    expect(bookV1ListQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });
});
