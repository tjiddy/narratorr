import { describe, it, expect } from 'vitest';
import {
  isCompanionEbookExposed,
  isCompanionEbookOwnerReadable,
  type CompanionEbookExposureInput,
} from './companion-ebook-exposure.js';
import { BOOK_STATUSES } from './schemas/book.js';
import { COMPANION_EBOOK_STATUSES } from './schemas/companion-ebook.js';

/** Every `(enabled × bookStatus × observationStatus)` combination — 70 of them. */
const ALL_COMBINATIONS: CompanionEbookExposureInput[] = [true, false].flatMap((enabled) =>
  BOOK_STATUSES.flatMap((bookStatus) =>
    COMPANION_EBOOK_STATUSES.map((observationStatus) => ({ enabled, bookStatus, observationStatus })),
  ),
);

const label = (input: CompanionEbookExposureInput): string =>
  `${String(input.enabled)}/${input.bookStatus}/${String(input.observationStatus)}`;

describe('isCompanionEbookExposed', () => {
  it('is true for exactly one of the 70 (enabled × bookStatus × observationStatus) combinations', () => {
    const trueCombinations: string[] = [];
    for (const enabled of [true, false]) {
      for (const bookStatus of BOOK_STATUSES) {
        for (const observationStatus of COMPANION_EBOOK_STATUSES) {
          if (isCompanionEbookExposed({ enabled, bookStatus, observationStatus })) {
            trueCombinations.push(`${String(enabled)}/${bookStatus}/${observationStatus}`);
          }
        }
      }
    }
    expect(trueCombinations).toEqual(['true/imported/available']);
  });

  it('is true when the feature is enabled, the book is imported, and an ebook is available', () => {
    expect(isCompanionEbookExposed({ enabled: true, bookStatus: 'imported', observationStatus: 'available' })).toBe(true);
  });

  it('is false when the feature is disabled, even with an imported book and an available ebook', () => {
    expect(isCompanionEbookExposed({ enabled: false, bookStatus: 'imported', observationStatus: 'available' })).toBe(false);
  });

  for (const observationStatus of ['none', 'ambiguous', 'invalid', 'drm_protected'] as const) {
    it(`is false for an imported book whose observation is '${observationStatus}'`, () => {
      expect(isCompanionEbookExposed({ enabled: true, bookStatus: 'imported', observationStatus })).toBe(false);
    });
  }

  it('is false for an absent observation (null) and does not throw', () => {
    expect(isCompanionEbookExposed({ enabled: true, bookStatus: 'imported', observationStatus: null })).toBe(false);
  });

  it('is false for an absent observation (undefined) and does not throw', () => {
    expect(isCompanionEbookExposed({ enabled: true, bookStatus: 'imported', observationStatus: undefined })).toBe(false);
  });

  // The load-bearing status term. `library-scan.service.ts` flips `imported → missing`
  // WITHOUT clearing `books.path` and without touching the companion row, so without this
  // term a book whose folder was deleted keeps advertising an ebook while every click 404s.
  it("is false for a 'missing' book with an untouched 'available' observation", () => {
    expect(isCompanionEbookExposed({ enabled: true, bookStatus: 'missing', observationStatus: 'available' })).toBe(false);
  });

  it("is false mid-import ('importing' is not exposure)", () => {
    expect(isCompanionEbookExposed({ enabled: true, bookStatus: 'importing', observationStatus: 'available' })).toBe(false);
  });

  // The ACCEPTED stale window, pinned so it cannot be mistaken for an oversight.
  //
  // Since #1955 a transient probe errno (EACCES/EIO/ESTALE, or a code-less throw) leaves
  // the book `imported` by design, so all three terms of this predicate stay true and the
  // advertisement is stale until a reconcile re-observes the book. That is the intended
  // outcome, not a defect: this helper decides ADVERTISEMENT, the stream's live open is the
  // authority, and the owner-visible result at click time is a clean
  // `404 companion_epub_unavailable`. A future change here has to confront this deliberately
  // — do NOT "fix" it by adding a live filesystem term (see the module docstring).
  it("stays true for a book still 'imported' behind a transiently-unreachable mount", () => {
    expect(isCompanionEbookExposed({ enabled: true, bookStatus: 'imported', observationStatus: 'available' })).toBe(true);
  });
});

describe('isCompanionEbookOwnerReadable', () => {
  it('is true for exactly two of the 70 combinations — available and drm_protected', () => {
    const trueCombinations = ALL_COMBINATIONS.filter(isCompanionEbookOwnerReadable).map(label);

    expect(trueCombinations).toEqual(['true/imported/available', 'true/imported/drm_protected']);
  });

  it('is true for an imported book whose stored observation is drm_protected', () => {
    expect(
      isCompanionEbookOwnerReadable({ enabled: true, bookStatus: 'imported', observationStatus: 'drm_protected' }),
    ).toBe(true);
  });

  it('is false for a drm_protected observation when the feature is disabled', () => {
    expect(
      isCompanionEbookOwnerReadable({ enabled: false, bookStatus: 'imported', observationStatus: 'drm_protected' }),
    ).toBe(false);
  });

  // The `imported` term is shared with the advertisement gate and carries the same weight here:
  // `library-scan.service.ts` flips `imported → missing` without touching the companion row, so
  // a deleted book must not become owner-readable just because its stored status names a file.
  for (const bookStatus of ['missing', 'importing'] as const) {
    it(`is false for a '${bookStatus}' book with a drm_protected observation`, () => {
      expect(isCompanionEbookOwnerReadable({ enabled: true, bookStatus, observationStatus: 'drm_protected' })).toBe(
        false,
      );
    });
  }

  for (const observationStatus of ['none', 'ambiguous', 'invalid'] as const) {
    it(`is false for an imported book whose observation is '${observationStatus}'`, () => {
      expect(isCompanionEbookOwnerReadable({ enabled: true, bookStatus: 'imported', observationStatus })).toBe(false);
    });
  }

  it('is false for an absent observation (null) and does not throw', () => {
    expect(isCompanionEbookOwnerReadable({ enabled: true, bookStatus: 'imported', observationStatus: null })).toBe(
      false,
    );
  });

  it('is false for an absent observation (undefined) and does not throw', () => {
    expect(isCompanionEbookOwnerReadable({ enabled: true, bookStatus: 'imported', observationStatus: undefined })).toBe(
      false,
    );
  });
});

/**
 * #2038 AC2 — the relationship between the two gates, pinned as a RELATION rather than as two
 * hand-listed truth tables. A hand-listed expectation for each passes when both gates drift
 * together (widen `isCompanionEbookExposed` to admit `drm_protected` and two independently
 * authored tables can still agree with each other); the implication plus the COMPUTED difference
 * set cannot.
 */
describe('the two gates, as one relation', () => {
  it('advertisement implies owner-readability, over all 70 combinations', () => {
    const violations = ALL_COMBINATIONS.filter(
      (input) => isCompanionEbookExposed(input) && !isCompanionEbookOwnerReadable(input),
    ).map(label);

    expect(violations).toEqual([]);
  });

  it('disagrees on exactly one combination: an imported book with a stored drm_protected row', () => {
    const difference = ALL_COMBINATIONS.filter(
      (input) => isCompanionEbookExposed(input) !== isCompanionEbookOwnerReadable(input),
    ).map(label);

    expect(difference).toEqual(['true/imported/drm_protected']);
  });
});
