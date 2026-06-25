import { describe, it, expect } from 'vitest';
import {
  metadataSearchResultV1Schema,
  metadataSearchV1QuerySchema,
  toMetadataSearchResultV1,
} from './metadata.js';

// A fully-populated, leaky `BookMetadata`-shaped source: every internal field
// the provider can carry (subtitle, isbn, goodreadsId, providerId, description,
// publisher, language, duration, genres, relevance, formatType,
// contentDeliveryType, alternateAsins, seriesPrimary's asin). Typed wide (no
// annotation) so the extra internal fields model the real source —
// `toMetadataSearchResultV1` must not copy them into the DTO.
function makeLeakySource() {
  return {
    asin: 'B00ASIN',
    alternateAsins: ['B00ALT'],
    isbn: '9780000000000',
    goodreadsId: 'gr-123',
    providerId: 'prov-123',
    title: 'Wool',
    subtitle: 'Silo Book 1',
    authors: [{ name: 'Hugh Howey', asin: 'AUASIN', extra: 'leak' }],
    narrators: ['Minnie Goode', 'Full Cast'],
    series: [{ name: 'Silo', position: 1, asin: 'SRASIN' }],
    seriesPrimary: { name: 'Silo', position: 1, asin: 'SRASIN' },
    description: 'A description that must not leak.',
    publisher: 'Some Publisher',
    publishedDate: '2011-07-30',
    language: 'english',
    coverUrl: 'https://example.com/cover.jpg',
    duration: 12345,
    genres: ['sci-fi'],
    relevance: 0.9,
    formatType: 'unabridged',
    contentDeliveryType: 'SinglePartBook',
  };
}

describe('toMetadataSearchResultV1 projection (zero-leak)', () => {
  it('emits exactly the public field set — no internal BookMetadata fields', () => {
    const dto = toMetadataSearchResultV1(makeLeakySource());
    expect(Object.keys(dto).sort()).toEqual(
      ['asin', 'authors', 'cover', 'narrators', 'publishedDate', 'series', 'title'].sort(),
    );
  });

  it('projects authors field-by-field to { name, asin? } only', () => {
    const dto = toMetadataSearchResultV1(makeLeakySource());
    expect(dto.authors).toEqual([{ name: 'Hugh Howey', asin: 'AUASIN' }]);
    expect(Object.keys(dto.authors[0]!).sort()).toEqual(['asin', 'name']);
  });

  it('omits author asin when the source author lacks one', () => {
    const dto = toMetadataSearchResultV1({ title: 'T', authors: [{ name: 'No Asin' }] });
    expect(dto.authors).toEqual([{ name: 'No Asin' }]);
    expect(dto.authors[0]).not.toHaveProperty('asin');
  });

  describe('narrators', () => {
    it('projects narrator strings to [{ name }] with no asin key', () => {
      const dto = toMetadataSearchResultV1(makeLeakySource());
      expect(dto.narrators).toEqual([{ name: 'Minnie Goode' }, { name: 'Full Cast' }]);
      expect(dto.narrators[0]).not.toHaveProperty('asin');
    });

    it('defaults to [] (required array, never undefined) when the source omits narrators', () => {
      const dto = toMetadataSearchResultV1({ title: 'T', authors: [{ name: 'A' }] });
      expect(dto.narrators).toEqual([]);
    });
  });

  describe('cover', () => {
    it('projects coverUrl to the public cover field', () => {
      expect(toMetadataSearchResultV1(makeLeakySource()).cover).toBe('https://example.com/cover.jpg');
    });

    it('omits cover when the source has no coverUrl', () => {
      const dto = toMetadataSearchResultV1({ title: 'T', authors: [{ name: 'A' }] });
      expect(dto).not.toHaveProperty('cover');
    });
  });

  describe('asin', () => {
    it('omits asin (returns the book anyway) when the source book lacks an asin', () => {
      const dto = toMetadataSearchResultV1({ title: 'T', authors: [{ name: 'A' }] });
      expect(dto).not.toHaveProperty('asin');
      expect(dto.title).toBe('T');
    });
  });

  describe('series (seriesPrimary ?? series[0])', () => {
    it('projects from seriesPrimary when present', () => {
      const dto = toMetadataSearchResultV1({
        title: 'T',
        authors: [{ name: 'A' }],
        seriesPrimary: { name: 'Primary', position: 2 },
        series: [{ name: 'Plural', position: 9 }],
      });
      expect(dto.series).toEqual({ name: 'Primary', position: 2 });
    });

    it('falls back to series[0] when seriesPrimary is absent', () => {
      const dto = toMetadataSearchResultV1({
        title: 'T',
        authors: [{ name: 'A' }],
        series: [{ name: 'Plural', position: 9 }],
      });
      expect(dto.series).toEqual({ name: 'Plural', position: 9 });
    });

    it('omits series when neither seriesPrimary nor series[] is present', () => {
      const dto = toMetadataSearchResultV1({ title: 'T', authors: [{ name: 'A' }] });
      expect(dto).not.toHaveProperty('series');
    });

    it('omits position when the source series has no position', () => {
      const dto = toMetadataSearchResultV1({
        title: 'T',
        authors: [{ name: 'A' }],
        seriesPrimary: { name: 'NoPos' },
      });
      expect(dto.series).toEqual({ name: 'NoPos' });
      expect(dto.series).not.toHaveProperty('position');
    });
  });
});

describe('metadataSearchResultV1Schema (fail-closed, .strict())', () => {
  const valid = {
    asin: 'B00ASIN',
    title: 'Wool',
    authors: [{ name: 'Hugh Howey', asin: 'AUASIN' }],
    narrators: [{ name: 'Minnie Goode' }],
    series: { name: 'Silo', position: 1 },
    cover: 'https://example.com/cover.jpg',
    publishedDate: '2011-07-30',
  };

  it('round-trips a projected DTO', () => {
    expect(metadataSearchResultV1Schema.safeParse(valid).success).toBe(true);
  });

  it('accepts a minimal result (title + authors + empty narrators)', () => {
    const result = metadataSearchResultV1Schema.safeParse({
      title: 'T',
      authors: [{ name: 'A' }],
      narrators: [],
    });
    expect(result.success).toBe(true);
  });

  it.each(['providerId', 'isbn', 'description', 'goodreadsId', 'subtitle'])(
    'REJECTS (does NOT strip) an internal leak field: %s',
    (field) => {
      const result = metadataSearchResultV1Schema.safeParse({ ...valid, [field]: 'leak' });
      expect(result.success).toBe(false);
    },
  );

  it('rejects a nested author leak (asin is allowed, but an unknown key is not)', () => {
    const result = metadataSearchResultV1Schema.safeParse({
      ...valid,
      authors: [{ name: 'Hugh', asin: 'A', goodreadsId: 'leak' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a narrator carrying an asin (narrators are { name } only)', () => {
    const result = metadataSearchResultV1Schema.safeParse({
      ...valid,
      narrators: [{ name: 'Minnie', asin: 'leak' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a nested series leak (asin is not part of the public series shape)', () => {
    const result = metadataSearchResultV1Schema.safeParse({
      ...valid,
      series: { name: 'Silo', position: 1, asin: 'leak' },
    });
    expect(result.success).toBe(false);
  });

  describe('library cross-reference (#1537)', () => {
    it('accepts a result carrying a valid library { bookId, status }', () => {
      const result = metadataSearchResultV1Schema.safeParse({
        ...valid,
        library: { bookId: 'bk_abc123', status: 'imported' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts library absent but rejects library: null (present-or-absent contract)', () => {
      expect(metadataSearchResultV1Schema.safeParse(valid).success).toBe(true);
      expect(metadataSearchResultV1Schema.safeParse({ ...valid, library: null }).success).toBe(false);
    });

    it('rejects an out-of-enum library.status (must be a BOOK_STATUSES value)', () => {
      const result = metadataSearchResultV1Schema.safeParse({
        ...valid,
        library: { bookId: 'bk_abc123', status: 'archived' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects an unknown key inside library (strict)', () => {
      const result = metadataSearchResultV1Schema.safeParse({
        ...valid,
        library: { bookId: 'bk_abc123', status: 'imported', leak: 'x' },
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('metadataSearchV1QuerySchema (strict, min(1)/max(500))', () => {
  it('accepts and trims a valid query', () => {
    const result = metadataSearchV1QuerySchema.safeParse({ q: '  wool  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.q).toBe('wool');
  });

  it('rejects a missing q', () => {
    expect(metadataSearchV1QuerySchema.safeParse({}).success).toBe(false);
  });

  it('rejects a blank/whitespace-only q (trim().min(1))', () => {
    expect(metadataSearchV1QuerySchema.safeParse({ q: '   ' }).success).toBe(false);
  });

  it('accepts a 500-char q and rejects a 501-char q (max(500))', () => {
    expect(metadataSearchV1QuerySchema.safeParse({ q: 'a'.repeat(500) }).success).toBe(true);
    expect(metadataSearchV1QuerySchema.safeParse({ q: 'a'.repeat(501) }).success).toBe(false);
  });

  it('rejects unknown query params (strict)', () => {
    expect(metadataSearchV1QuerySchema.safeParse({ q: 'wool', limit: '10' }).success).toBe(false);
  });
});
