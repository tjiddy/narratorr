import { describe, it, expect } from 'vitest';
import { libraryImportSection } from './libraryImportSection.js';
import { isLibraryDbDuplicate } from './isLibraryDbDuplicate.js';
import type { DiscoveredBook } from '@/lib/api';

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

describe('libraryImportSection (#2091)', () => {
  it('routes a slug duplicate to the copy section', () => {
    expect(libraryImportSection(book({ isDuplicate: true, duplicateReason: 'slug' }))).toBe('duplicate-copy');
  });

  it('routes a path duplicate to the hidden existing-path section', () => {
    expect(libraryImportSection(book({ isDuplicate: true, duplicateReason: 'path' }))).toBe('existing-path');
  });

  it('routes a non-duplicate to the main list', () => {
    expect(libraryImportSection(book({ isDuplicate: false }))).toBe('new');
  });

  // Selection is fail-closed on isDuplicate alone, so a reasonless duplicate must not become
  // visible-and-editable by falling through the section split; it stays behind the toggle.
  it('routes a duplicate with no duplicateReason to the hidden existing-path section', () => {
    expect(libraryImportSection(book({ isDuplicate: true }))).toBe('existing-path');
  });

  // #2091 AC8 / #2435: clearing isDuplicate is what returns a row to the main list, even though
  // the stale reason survives on the row.
  it('returns a row whose isDuplicate was cleared to the main list, stale reason and all', () => {
    expect(libraryImportSection(book({ isDuplicate: false, duplicateReason: 'slug' }))).toBe('new');
  });

  // AC6: visibility is a separate axis from eligibility. Every section that is not 'new' must
  // still be ineligible, and 'new' must still be eligible — one predicate, two readings.
  it.each([
    [book({ isDuplicate: false }), 'new', false],
    [book({ isDuplicate: true, duplicateReason: 'slug' }), 'duplicate-copy', true],
    [book({ isDuplicate: true, duplicateReason: 'path' }), 'existing-path', true],
  ])('agrees with isLibraryDbDuplicate on eligibility', (b, section, ineligible) => {
    expect(libraryImportSection(b)).toBe(section);
    expect(isLibraryDbDuplicate(b)).toBe(ineligible);
  });
});
