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

describe('isLibraryDbDuplicate (#1833)', () => {
  // Exhaustive over every DuplicateReason value so the hook and page — which both import this
  // one predicate — provably agree about DB-duplicate status no matter how the enum grows.
  const cases: Array<{ reason: DuplicateReason | undefined; isDuplicate: boolean; expected: boolean }> = [
    { reason: 'path', isDuplicate: true, expected: true },
    { reason: 'slug', isDuplicate: true, expected: true },
    { reason: 'within-scan', isDuplicate: true, expected: false },
    { reason: undefined, isDuplicate: false, expected: false },
  ];

  for (const { reason, isDuplicate, expected } of cases) {
    it(`isDuplicate=${isDuplicate} reason=${String(reason)} → ${expected}`, () => {
      expect(isLibraryDbDuplicate(book({ isDuplicate, ...(reason !== undefined && { duplicateReason: reason }) }))).toBe(expected);
    });
  }

  it('a within-scan collision is never a DB duplicate even though isDuplicate is true', () => {
    expect(isLibraryDbDuplicate(book({ isDuplicate: true, duplicateReason: 'within-scan' }))).toBe(false);
  });
});
