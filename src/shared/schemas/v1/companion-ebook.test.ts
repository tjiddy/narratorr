import { describe, it, expect } from 'vitest';
import { companionEbookV1Schema, toCompanionEbookV1 } from './companion-ebook.js';
import { COMPANION_EBOOK_STATUSES } from '../companion-ebook.js';
import { BOOK_STATUSES } from '../book.js';

// The single home for the exposure→DTO boundary (#1961 AC 10a). Both producers
// (the metadata-search `library` annotation and the top-level book DTO) call
// `toCompanionEbookV1` and nothing else, so proving the boundary HERE means each
// producer only has to be proven to CALL it.

const SIZE = 123456;

describe('toCompanionEbookV1 — exposure terms (AC 10a)', () => {
  // All five stored statuses × both feature states × four book statuses. The
  // only non-null cell is `enabled && imported && available`.
  const bookStatuses = ['imported', 'missing', 'wanted', 'downloading'] as const;
  const cases = COMPANION_EBOOK_STATUSES.flatMap((status) =>
    [true, false].flatMap((enabled) =>
      bookStatuses.map((bookStatus) => ({ status, enabled, bookStatus })),
    ),
  );

  it.each(cases)(
    'status=$status enabled=$enabled bookStatus=$bookStatus',
    ({ status, enabled, bookStatus }) => {
      const result = toCompanionEbookV1({
        enabled,
        bookStatus,
        observation: { status, sizeBytes: SIZE },
      });

      const shouldExpose = enabled && bookStatus === 'imported' && status === 'available';
      expect(result).toEqual(shouldExpose ? { format: 'epub', sizeBytes: SIZE } : null);
    },
  );

  it('binds all three terms — exactly one of the 40 combinations is non-null', () => {
    const nonNull = cases.filter(
      ({ status, enabled, bookStatus }) =>
        toCompanionEbookV1({ enabled, bookStatus, observation: { status, sizeBytes: SIZE } }) !== null,
    );
    expect(nonNull).toEqual([{ status: 'available', enabled: true, bookStatus: 'imported' }]);
  });

  // AC 22: `library-scan.service.ts` flips imported → missing without clearing
  // `books.path` or touching the companion row, so the `imported` term is the
  // only thing stopping a deleted book from advertising an ebook forever.
  it.each(BOOK_STATUSES.filter((s) => s !== 'imported'))(
    'yields null for a stale available observation on a %s book',
    (bookStatus) => {
      expect(
        toCompanionEbookV1({ enabled: true, bookStatus, observation: { status: 'available', sizeBytes: SIZE } }),
      ).toBeNull();
    },
  );
});

describe('toCompanionEbookV1 — absent observation (AC 29)', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('returns null (never a throw) for a %s observation', (_label, observation) => {
    expect(() =>
      toCompanionEbookV1({ enabled: true, bookStatus: 'imported', observation }),
    ).not.toThrow();
    expect(toCompanionEbookV1({ enabled: true, bookStatus: 'imported', observation })).toBeNull();
  });
});

describe('toCompanionEbookV1 — sizeBytes guard (AC 27/28)', () => {
  it('round-trips sizeBytes: 0 as 0 — the check is `!= null`, not truthiness (AC 28)', () => {
    expect(
      toCompanionEbookV1({ enabled: true, bookStatus: 'imported', observation: { status: 'available', sizeBytes: 0 } }),
    ).toEqual({ format: 'epub', sizeBytes: 0 });
  });

  it('returns null (no throw, never ?? 0) for an available observation with a null sizeBytes (AC 27)', () => {
    // Unreachable through `ck_companion_ebooks_file_present`, but expressible in
    // the `$inferSelect` type — the mapper is the single place that guards it.
    expect(() =>
      toCompanionEbookV1({
        enabled: true,
        bookStatus: 'imported',
        observation: { status: 'available', sizeBytes: null },
      }),
    ).not.toThrow();
    expect(
      toCompanionEbookV1({
        enabled: true,
        bookStatus: 'imported',
        observation: { status: 'available', sizeBytes: null },
      }),
    ).toBeNull();
  });
});

describe('companionEbookV1Schema (strict, nullable)', () => {
  it('parses the mapper output for an exposed observation', () => {
    const dto = toCompanionEbookV1({
      enabled: true,
      bookStatus: 'imported',
      observation: { status: 'available', sizeBytes: SIZE },
    });
    const parsed = companionEbookV1Schema.safeParse(dto);
    expect(parsed.success).toBe(true);
    expect(dto).toEqual({ format: 'epub', sizeBytes: SIZE });
  });

  it('parses null (the not-exposed value)', () => {
    expect(companionEbookV1Schema.safeParse(null).success).toBe(true);
  });

  it('rejects a format other than the literal epub', () => {
    expect(companionEbookV1Schema.safeParse({ format: 'pdf', sizeBytes: SIZE }).success).toBe(false);
  });

  it('rejects an unknown key (strict)', () => {
    expect(
      companionEbookV1Schema.safeParse({ format: 'epub', sizeBytes: SIZE, path: '/leak.epub' }).success,
    ).toBe(false);
  });

  it('rejects a missing sizeBytes and a non-numeric sizeBytes', () => {
    expect(companionEbookV1Schema.safeParse({ format: 'epub' }).success).toBe(false);
    expect(companionEbookV1Schema.safeParse({ format: 'epub', sizeBytes: '12' }).success).toBe(false);
  });
});
