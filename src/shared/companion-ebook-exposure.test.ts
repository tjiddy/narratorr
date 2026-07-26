import { describe, it, expect } from 'vitest';
import { isCompanionEbookExposed } from './companion-ebook-exposure.js';
import { BOOK_STATUSES } from './schemas/book.js';
import { COMPANION_EBOOK_STATUSES } from './schemas/companion-ebook.js';

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
