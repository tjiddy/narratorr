import { describe, it, expect } from 'vitest';
import {
  isCompanionEbookExposed,
  isCompanionEbookOwnerReadable,
  type CompanionEbookExposureInput,
} from './companion-ebook-exposure.js';
import { BOOK_STATUSES } from './schemas/book.js';
import { COMPANION_EBOOK_STATUSES } from './schemas/companion-ebook.js';

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

  it("is false for a 'missing' book with an untouched 'available' observation", () => {
    expect(isCompanionEbookExposed({ enabled: true, bookStatus: 'missing', observationStatus: 'available' })).toBe(false);
  });

  it("is false mid-import ('importing' is not exposure)", () => {
    expect(isCompanionEbookExposed({ enabled: true, bookStatus: 'importing', observationStatus: 'available' })).toBe(false);
  });

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

// Test the implication and computed difference so both gates cannot drift together.
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
