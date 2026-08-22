import { describe, it, expect } from 'vitest';
import type { DiscoveredBook } from '@/lib/api';
import { buildCopyAnnotation } from './copyAnnotation.js';

const LIBRARY_ROOT = '/audiobooks';

function makeBook(overrides?: Partial<DiscoveredBook>): DiscoveredBook {
  return {
    path: '/audiobooks/Robin Hobb/Realms of the Elderlings/02 - Royal Assassin',
    parsedTitle: 'Royal Assassin',
    parsedAuthor: 'Robin Hobb',
    parsedSeries: 'Realms of the Elderlings',
    fileCount: 1,
    totalSize: 60000,
    isDuplicate: false,
    ...overrides,
  };
}

function copyBook(overrides?: Partial<DiscoveredBook>): DiscoveredBook {
  return makeBook({ isDuplicate: true, duplicateReason: 'slug', ...overrides });
}

describe('buildCopyAnnotation — classification (AC12)', () => {
  it('annotates a slug duplicate', () => {
    expect(buildCopyAnnotation(copyBook(), LIBRARY_ROOT)).not.toBeNull();
  });

  // Each of these is a row a naive "same recording" read would sweep in; the builder defers the
  // verdict to `libraryImportSection` rather than re-spelling the guard.
  it.each([
    ['a path duplicate', { isDuplicate: true, duplicateReason: 'path' as const }],
    ['a duplicate with no reason', { isDuplicate: true }],
    ['a review verdict', { isDuplicate: false, recordingVerdict: 'review' as const }],
    ['a different recording', { isDuplicate: false, recordingVerdict: 'different-recording' as const }],
    ['a same recording that is not a duplicate', { isDuplicate: false, recordingVerdict: 'same-recording' as const }],
    ['a plain new row', { isDuplicate: false }],
  ])('returns null for %s', (_label, overrides) => {
    expect(buildCopyAnnotation(makeBook(overrides), LIBRARY_ROOT)).toBeNull();
  });
});

describe('buildCopyAnnotation — badge', () => {
  it('badges a copy row exactly "Duplicate copy" / warning', () => {
    expect(buildCopyAnnotation(copyBook(), LIBRARY_ROOT)?.badge).toEqual({
      label: 'Duplicate copy',
      variant: 'warning',
    });
  });
});

describe('buildCopyAnnotation — note (AC14/AC15)', () => {
  const GENERIC = 'Same recording as a book already in your library';

  it('names the incumbent by its relative spelling when it sits inside the root', () => {
    const result = buildCopyAnnotation(
      copyBook({ existingPath: '/audiobooks/Robin Hobb/Farseer Trilogy/02 - Royal Assassin' }),
      LIBRARY_ROOT,
    );
    expect(result?.note).toBe('Same recording as Robin Hobb/Farseer Trilogy/02 - Royal Assassin');
  });

  it('falls back to the absolute spelling for an incumbent outside the root (prefix collision)', () => {
    const result = buildCopyAnnotation(copyBook({ existingPath: '/audiobooks-old/A/B' }), '/audiobooks');
    expect(result?.note).toBe('Same recording as /audiobooks-old/A/B');
  });

  it('falls back to the absolute spelling when the incumbent IS the root', () => {
    const result = buildCopyAnnotation(copyBook({ existingPath: '/audiobooks' }), LIBRARY_ROOT);
    expect(result?.note).toBe('Same recording as /audiobooks');
  });

  it('falls back to the absolute spelling when the root is empty (LibraryImportPage passes `?? \'\'`)', () => {
    const result = buildCopyAnnotation(copyBook({ existingPath: '/audiobooks/A/B' }), '');
    expect(result?.note).toBe('Same recording as /audiobooks/A/B');
  });

  it('degrades to generic wording when the row carries no incumbent path', () => {
    const result = buildCopyAnnotation(copyBook(), LIBRARY_ROOT);
    expect(result?.note).toBe(GENERIC);
    expect(result?.note).not.toMatch(/Same recording as\s*$/);
    expect(result?.note).not.toContain('undefined');
  });

  it('degrades to generic wording for an empty incumbent path', () => {
    expect(buildCopyAnnotation(copyBook({ existingPath: '' }), LIBRARY_ROOT)?.note).toBe(GENERIC);
  });

  // AC15: the one behavior that intentionally changes — today's card-level truthiness check
  // renders `Same recording as    ` for this input.
  it('degrades to generic wording for a whitespace-only incumbent path', () => {
    expect(buildCopyAnnotation(copyBook({ existingPath: '   ' }), LIBRARY_ROOT)?.note).toBe(GENERIC);
  });

  it.each([
    ['a named incumbent', '/audiobooks/A/B'],
    ['no incumbent', undefined],
  ])('never promises a recording check at import for %s', (_label, existingPath) => {
    const book = copyBook(existingPath === undefined ? {} : { existingPath });
    expect(buildCopyAnnotation(book, LIBRARY_ROOT)?.note).not.toMatch(
      /checking recording|checked on import|will be checked/i,
    );
  });
});
