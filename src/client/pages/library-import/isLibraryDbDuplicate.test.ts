import { describe, it, expect } from 'vitest';
import { isLibraryDbDuplicate } from './isLibraryDbDuplicate.js';
import type { DiscoveredBook } from '@/lib/api';

type DuplicateReason = NonNullable<DiscoveredBook['duplicateReason']>;

function book(overrides: Partial<DiscoveredBook>): DiscoveredBook {
  return {
    path: '/a/Book',
    parsedTitle: 'Book',
    parsedAuthor: 'Author',
    parsedSeries: null,
    fileCount: 1,
    totalSize: 1000,
    isDuplicate: false,
    ...overrides,
  };
}

describe('isLibraryDbDuplicate (#1833/#1925)', () => {
  const cases: Array<{ reason: DuplicateReason | undefined; isDuplicate: boolean; expected: boolean }> = [
    { reason: 'path', isDuplicate: true, expected: true },
    { reason: 'slug', isDuplicate: true, expected: true },
    { reason: undefined, isDuplicate: false, expected: false },
  ];

  for (const { reason, isDuplicate, expected } of cases) {
    it(`isDuplicate=${isDuplicate} reason=${String(reason)} → ${expected}`, () => {
      expect(isLibraryDbDuplicate(book({ isDuplicate, ...(reason !== undefined && { duplicateReason: reason }) }))).toBe(expected);
    });
  }

  it('a former within-scan row (isDuplicate=false, no duplicateReason) is not a DB duplicate (#1925)', () => {
    expect(isLibraryDbDuplicate(book({ isDuplicate: false }))).toBe(false);
  });
});
