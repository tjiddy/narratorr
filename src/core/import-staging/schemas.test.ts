import { describe, it, expect } from 'vitest';
import {
  stagedImportItemSchema,
  stagedBookMetadataSchema,
  createSubmissionBodySchema,
  putItemsBodySchema,
  submissionQuerySchema,
  submissionResponseSchema,
  stagedItemResultDtoSchema,
  clientSubmissionIdSchema,
  payloadDigestSchema,
  serializeSubmissionForDigest,
  aggregateDispositions,
  CANONICAL_METADATA_KEYS,
  MAX_SUBMISSION_BYTES,
  EXPECTED_COUNT_MAX,
} from './schemas.js';
import { BookMetadataSchema } from '../metadata/schemas.js';

const validMetadata = {
  title: 'A Book',
  authors: [{ name: 'An Author' }],
};

const validStagedItem = {
  path: '/library/a-book',
  title: 'A Book',
  metadata: validMetadata,
};

const VALID_UUID = '3f0f1a52-3b6e-4c1a-9d2b-2a4e6c8f0a11';
const VALID_DIGEST = 'a'.repeat(64);

describe('stagedImportItemSchema', () => {
  it('accepts a minimal staged item and is strict', () => {
    expect(stagedImportItemSchema.parse(validStagedItem)).toMatchObject({ path: '/library/a-book', title: 'A Book' });
    expect(stagedImportItemSchema.safeParse({ ...validStagedItem, bogus: 1 }).success).toBe(false);
  });

  it('rejects nested unknown metadata keys', () => {
    expect(
      stagedImportItemSchema.safeParse({ ...validStagedItem, metadata: { ...validMetadata, bogus: true } }).success,
    ).toBe(false);
  });
});

describe('stagedBookMetadataSchema bounds (F34)', () => {
  it('accepts array elements at the boundary and rejects just over', () => {
    const at = {
      ...validMetadata,
      alternateAsins: ['x'.repeat(64)],
      narrators: ['n'.repeat(512)],
      genres: ['g'.repeat(128)],
    };
    expect(stagedBookMetadataSchema.safeParse(at).success).toBe(true);

    expect(stagedBookMetadataSchema.safeParse({ ...validMetadata, alternateAsins: ['x'.repeat(65)] }).success).toBe(false);
    expect(stagedBookMetadataSchema.safeParse({ ...validMetadata, narrators: ['n'.repeat(513)] }).success).toBe(false);
    expect(stagedBookMetadataSchema.safeParse({ ...validMetadata, genres: ['g'.repeat(129)] }).success).toBe(false);
  });

  it('bounds array counts', () => {
    expect(
      stagedBookMetadataSchema.safeParse({ ...validMetadata, genres: Array.from({ length: 65 }, () => 'g') }).success,
    ).toBe(false);
  });

  it('bounds scalar strings and requires a url cover', () => {
    expect(stagedBookMetadataSchema.safeParse({ ...validMetadata, asin: 'a'.repeat(65) }).success).toBe(false);
    expect(stagedBookMetadataSchema.safeParse({ ...validMetadata, description: 'd'.repeat(8001) }).success).toBe(false);
    expect(stagedBookMetadataSchema.safeParse({ ...validMetadata, coverUrl: 'not-a-url' }).success).toBe(false);
  });

  // F34: exhaustive at/over matrix for EVERY independent bound so removing/reversing
  // any single bound fails a test.
  const parse = (over: Record<string, unknown>) => stagedBookMetadataSchema.safeParse({ ...validMetadata, ...over }).success;

  it('bounds every scalar string field at exactly its maximum', () => {
    const idMax = 64, shortMax = 512, descMax = 8_000;
    const scalars: Array<[string, number]> = [
      ['asin', idMax], ['isbn', idMax], ['goodreadsId', idMax], ['providerId', idMax],
      ['subtitle', shortMax], ['publisher', shortMax], ['publishedDate', shortMax], ['language', shortMax],
      ['formatType', shortMax], ['contentDeliveryType', shortMax], ['description', descMax],
    ];
    for (const [field, max] of scalars) {
      expect(parse({ [field]: 'x'.repeat(max) })).toBe(true);   // at boundary
      expect(parse({ [field]: 'x'.repeat(max + 1) })).toBe(false); // just over
    }
    // title has both a min(1) and a 512 max.
    expect(parse({ title: 'x'.repeat(512) })).toBe(true);
    expect(parse({ title: 'x'.repeat(513) })).toBe(false);
  });

  it('bounds coverUrl length and enforces url()', () => {
    expect(parse({ coverUrl: 'https://e.com/' + 'a'.repeat(2034) })).toBe(true); // exactly 2048
    expect(parse({ coverUrl: 'https://e.com/' + 'a'.repeat(2040) })).toBe(false); // over 2048
    expect(parse({ coverUrl: 'a'.repeat(100) })).toBe(false); // not a URL
  });

  it('bounds nested AuthorRef/SeriesRef fields and enforces their strictness', () => {
    expect(parse({ authors: [{ name: 'x'.repeat(512) }] })).toBe(true);
    expect(parse({ authors: [{ name: 'x'.repeat(513) }] })).toBe(false);
    expect(parse({ authors: [{ name: 'A', asin: 'x'.repeat(64) }] })).toBe(true);
    expect(parse({ authors: [{ name: 'A', asin: 'x'.repeat(65) }] })).toBe(false);
    expect(parse({ authors: [{ name: 'A', bogus: 1 }] })).toBe(false); // AuthorRef strict
    expect(parse({ series: [{ name: 'x'.repeat(512) }] })).toBe(true);
    expect(parse({ series: [{ name: 'x'.repeat(513) }] })).toBe(false);
    expect(parse({ series: [{ name: 'S', asin: 'x'.repeat(65) }] })).toBe(false);
    expect(parse({ series: [{ name: 'S', bogus: 1 }] })).toBe(false); // SeriesRef strict
    expect(parse({ seriesPrimary: { name: 'S', bogus: 1 } })).toBe(false); // nested strict
  });

  it('rejects non-finite numbers on position/duration/relevance', () => {
    expect(parse({ duration: Infinity })).toBe(false);
    expect(parse({ duration: Number.NaN })).toBe(false);
    expect(parse({ relevance: Infinity })).toBe(false);
    expect(parse({ series: [{ name: 'S', position: Infinity }] })).toBe(false);
    // finite values are accepted
    expect(parse({ duration: 3600, relevance: 0.9, series: [{ name: 'S', position: 1 }] })).toBe(true);
  });

  it('bounds every array COUNT at exactly its maximum', () => {
    const counts: Array<[string, number, () => unknown]> = [
      ['alternateAsins', 32, () => 'a'],
      ['authors', 64, () => ({ name: 'A' })],
      ['narrators', 64, () => 'n'],
      ['series', 32, () => ({ name: 'S' })],
      ['genres', 64, () => 'g'],
    ];
    for (const [field, max, make] of counts) {
      expect(parse({ [field]: Array.from({ length: max }, make) })).toBe(true);   // at
      expect(parse({ [field]: Array.from({ length: max + 1 }, make) })).toBe(false); // over
    }
  });
});

describe('stagedBookMetadataSchema composes the canonical schema (F6)', () => {
  it('key-set matches BookMetadataSchema exactly (no drift on a future canonical field)', () => {
    const stagedKeys = Object.keys(stagedBookMetadataSchema.shape).sort();
    const canonicalKeys = Object.keys(BookMetadataSchema.shape).sort();
    expect(stagedKeys).toEqual(canonicalKeys);
    expect(CANONICAL_METADATA_KEYS).toEqual(canonicalKeys);
  });

  it('round-trips every canonical field without dropping any (full-field parse)', () => {
    const full = {
      asin: 'B000000001',
      alternateAsins: ['B000000002'],
      isbn: '9781234567897',
      goodreadsId: 'gr-1',
      providerId: 'prov-1',
      title: 'A Full Book',
      subtitle: 'The Subtitle',
      authors: [{ name: 'An Author', asin: 'AUTH00001' }],
      narrators: ['A Narrator'],
      series: [{ name: 'A Series', position: 1, asin: 'SER000001' }],
      seriesPrimary: { name: 'A Series', position: 1, asin: 'SER000001' },
      description: 'A description.',
      publisher: 'A Publisher',
      publishedDate: '2020-01-01',
      language: 'en',
      coverUrl: 'https://example.com/cover.jpg',
      duration: 36000,
      genres: ['Fantasy'],
      relevance: 0.95,
      formatType: 'unabridged',
      contentDeliveryType: 'download',
    };
    expect(stagedBookMetadataSchema.parse(full)).toEqual(full);
  });
});

describe('aggregateDispositions (single mapping, F13)', () => {
  it('counts every terminal disposition and ignores pending', () => {
    expect(aggregateDispositions(['accepted', 'accepted', 'held', 'skipped', 'failed', 'pending'])).toEqual({
      accepted: 2, held: 1, skipped: 1, failed: 0 + 1,
    });
    expect(aggregateDispositions([])).toEqual({ accepted: 0, held: 0, skipped: 0, failed: 0 });
    expect(aggregateDispositions(['pending', 'pending'])).toEqual({ accepted: 0, held: 0, skipped: 0, failed: 0 });
  });
});

describe('identifier validators (F56/F57)', () => {
  it('clientSubmissionId requires a real UUID — full rejection matrix (F32)', () => {
    expect(clientSubmissionIdSchema.safeParse(VALID_UUID).success).toBe(true);
    expect(clientSubmissionIdSchema.safeParse('3f0f1a52-3b6e-4c1a-9d2b-2a4e6c8f0a1').success).toBe(false); // too short
    expect(clientSubmissionIdSchema.safeParse(VALID_UUID + '0').success).toBe(false); // over-length
    expect(clientSubmissionIdSchema.safeParse('0'.repeat(36)).success).toBe(false); // 36 chars, no hyphens
    expect(clientSubmissionIdSchema.safeParse('-'.repeat(36)).success).toBe(false); // all hyphens
    expect(clientSubmissionIdSchema.safeParse('3f0f1a523-b6e-4c1a-9d2b-2a4e6c8f0a11').success).toBe(false); // misplaced hyphens
    expect(clientSubmissionIdSchema.safeParse('3f0f1a52-3b6e-0c1a-9d2b-2a4e6c8f0a11').success).toBe(false); // invalid version (0)
    expect(clientSubmissionIdSchema.safeParse('3f0f1a52-3b6e-4c1a-cd2b-2a4e6c8f0a11').success).toBe(false); // invalid variant (c)
    expect(clientSubmissionIdSchema.safeParse('3f0f1a52-3b6e-4c1a-9d2b-2a4e6c8f0a1z').success).toBe(false); // non-hex char
  });

  it('payloadDigest requires 64 lowercase hex chars', () => {
    expect(payloadDigestSchema.safeParse(VALID_DIGEST).success).toBe(true);
    expect(payloadDigestSchema.safeParse('a'.repeat(63)).success).toBe(false);
    expect(payloadDigestSchema.safeParse('a'.repeat(65)).success).toBe(false);
    expect(payloadDigestSchema.safeParse('A'.repeat(64)).success).toBe(false);
    expect(payloadDigestSchema.safeParse('g'.repeat(64)).success).toBe(false);
  });
});

describe('createSubmissionBodySchema (source/mode union)', () => {
  it('library requires no mode; manual requires mode', () => {
    expect(
      createSubmissionBodySchema.safeParse({ source: 'library', clientSubmissionId: VALID_UUID, payloadDigest: VALID_DIGEST, expectedCount: 3 }).success,
    ).toBe(true);
    expect(
      createSubmissionBodySchema.safeParse({ source: 'manual', clientSubmissionId: VALID_UUID, payloadDigest: VALID_DIGEST, expectedCount: 3 }).success,
    ).toBe(false); // manual without mode
    expect(
      createSubmissionBodySchema.safeParse({ source: 'library', mode: 'copy', clientSubmissionId: VALID_UUID, payloadDigest: VALID_DIGEST, expectedCount: 3 }).success,
    ).toBe(false); // library with mode
  });

  it('bounds expectedCount 1..EXPECTED_COUNT_MAX inclusive (F33)', () => {
    const base = { source: 'library' as const, clientSubmissionId: VALID_UUID, payloadDigest: VALID_DIGEST };
    expect(createSubmissionBodySchema.safeParse({ ...base, expectedCount: 0 }).success).toBe(false); // below min
    expect(createSubmissionBodySchema.safeParse({ ...base, expectedCount: 1 }).success).toBe(true); // at min
    expect(createSubmissionBodySchema.safeParse({ ...base, expectedCount: EXPECTED_COUNT_MAX }).success).toBe(true); // EXACTLY at max
    expect(createSubmissionBodySchema.safeParse({ ...base, expectedCount: EXPECTED_COUNT_MAX + 1 }).success).toBe(false); // over max
    expect(createSubmissionBodySchema.safeParse({ ...base, expectedCount: 1.5 }).success).toBe(false); // non-integer
  });
});

describe('putItemsBodySchema', () => {
  it('accepts {ordinal,item} rows and is strict', () => {
    expect(putItemsBodySchema.safeParse({ items: [{ ordinal: 0, item: validStagedItem }] }).success).toBe(true);
    expect(putItemsBodySchema.safeParse({ items: [{ ordinal: 0, item: validStagedItem, path: 'x' }] }).success).toBe(false);
    expect(putItemsBodySchema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('submissionQuerySchema (F71)', () => {
  it('omitted → false, "false" → false, "true" → true, invalid/unknown rejected', () => {
    expect(submissionQuerySchema.parse({})).toEqual({ includeItems: false });
    expect(submissionQuerySchema.parse({ includeItems: 'false' })).toEqual({ includeItems: false });
    expect(submissionQuerySchema.parse({ includeItems: 'true' })).toEqual({ includeItems: true });
    expect(submissionQuerySchema.safeParse({ includeItems: 'yes' }).success).toBe(false);
    expect(submissionQuerySchema.safeParse({ other: '1' }).success).toBe(false);
  });
});

describe('stagedItemResultDtoSchema (disposition union, F42)', () => {
  const base = { ordinal: 0, path: '/p', title: 'T' };
  it('accepts each disposition shape', () => {
    expect(stagedItemResultDtoSchema.safeParse({ disposition: 'pending', ...base }).success).toBe(true);
    expect(stagedItemResultDtoSchema.safeParse({ disposition: 'accepted', ...base, bookId: 7 }).success).toBe(true);
    expect(stagedItemResultDtoSchema.safeParse({ disposition: 'accepted', ...base, bookId: null }).success).toBe(true);
    expect(stagedItemResultDtoSchema.safeParse({ disposition: 'held', ...base, reason: 'recording-review-required' }).success).toBe(true);
    expect(stagedItemResultDtoSchema.safeParse({ disposition: 'skipped', ...base, reason: 'already-in-library' }).success).toBe(true);
    expect(stagedItemResultDtoSchema.safeParse({ disposition: 'failed', ...base, message: 'boom' }).success).toBe(true);
  });

  it('rejects cross-disposition fields', () => {
    expect(stagedItemResultDtoSchema.safeParse({ disposition: 'held', ...base, reason: 'recording-review-required', message: 'x' }).success).toBe(false);
    expect(stagedItemResultDtoSchema.safeParse({ disposition: 'accepted', ...base, bookId: 1, existingTitle: 'x' }).success).toBe(false);
    expect(stagedItemResultDtoSchema.safeParse({ disposition: 'pending', ...base, reason: 'already-in-library' }).success).toBe(false);
    expect(stagedItemResultDtoSchema.safeParse({ disposition: 'skipped', ...base, reason: 'bogus' }).success).toBe(false);
  });
});

describe('submissionResponseSchema arms (F64)', () => {
  const header = {
    id: 1,
    clientSubmissionId: VALID_UUID,
    source: 'library' as const,
    status: 'processing' as const,
    expectedCount: 2,
    receivedCount: 2,
    processedCount: 0,
    aggregates: { accepted: 0, held: 0, skipped: 0, failed: 0 },
    detailsPruned: false,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  };

  it('summary/processing: itemsIncluded false, no items', () => {
    expect(submissionResponseSchema.safeParse({ ...header, itemsIncluded: false }).success).toBe(true);
    expect(submissionResponseSchema.safeParse({ ...header, itemsIncluded: false, items: [] }).success).toBe(false);
  });

  it('detail/retained: itemsIncluded true with items', () => {
    expect(
      submissionResponseSchema.safeParse({
        ...header,
        itemsIncluded: true,
        items: [{ disposition: 'pending', ordinal: 0, path: '/p', title: 'T' }],
      }).success,
    ).toBe(true);
  });

  it('detail/pruned: itemsIncluded false, detailsPruned true, no items', () => {
    expect(submissionResponseSchema.safeParse({ ...header, status: 'complete', detailsPruned: true, itemsIncluded: false }).success).toBe(true);
  });

  it('rejects impossible source/mode arms (F4)', () => {
    // manual without a mode
    expect(submissionResponseSchema.safeParse({ ...header, source: 'manual', itemsIncluded: false }).success).toBe(false);
    // library carrying a mode
    expect(submissionResponseSchema.safeParse({ ...header, mode: 'copy', itemsIncluded: false }).success).toBe(false);
    // manual WITH a mode is legal
    expect(submissionResponseSchema.safeParse({ ...header, source: 'manual', mode: 'copy', itemsIncluded: false }).success).toBe(true);
  });

  it('rejects the detail arm claiming pruned details (F4)', () => {
    expect(
      submissionResponseSchema.safeParse({ ...header, status: 'complete', detailsPruned: true, itemsIncluded: true, items: [] }).success,
    ).toBe(false);
  });
});

describe('serializeSubmissionForDigest', () => {
  it('omits mode for library, includes it for manual', () => {
    const lib = serializeSubmissionForDigest({ source: 'library', items: [stagedImportItemSchema.parse(validStagedItem)] });
    expect(lib.includes('"mode"')).toBe(false);
    const man = serializeSubmissionForDigest({ source: 'manual', mode: 'copy', items: [stagedImportItemSchema.parse(validStagedItem)] });
    expect(man.includes('"mode":"copy"')).toBe(true);
  });

  it('is stable regardless of input key order', () => {
    const a = serializeSubmissionForDigest({ source: 'library', items: [stagedImportItemSchema.parse({ title: 'A Book', path: '/p', metadata: validMetadata })] });
    const b = serializeSubmissionForDigest({ source: 'library', items: [stagedImportItemSchema.parse({ metadata: validMetadata, path: '/p', title: 'A Book' })] });
    expect(a).toBe(b);
  });

  it('is order-significant across items', () => {
    const i1 = stagedImportItemSchema.parse({ path: '/1', title: 'One', metadata: { title: 'One', authors: [{ name: 'X' }] } });
    const i2 = stagedImportItemSchema.parse({ path: '/2', title: 'Two', metadata: { title: 'Two', authors: [{ name: 'X' }] } });
    expect(serializeSubmissionForDigest({ source: 'library', items: [i1, i2] })).not.toBe(
      serializeSubmissionForDigest({ source: 'library', items: [i2, i1] }),
    );
  });
});

describe('constants', () => {
  it('MAX_SUBMISSION_BYTES is 64 MiB', () => {
    expect(MAX_SUBMISSION_BYTES).toBe(64 * 1024 * 1024);
  });
});
