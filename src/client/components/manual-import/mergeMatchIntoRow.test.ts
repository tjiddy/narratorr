import { describe, it, expect } from 'vitest';
import { mergeMatchIntoRow } from './mergeMatchIntoRow.js';
import type { ImportRow } from './types.js';
import type { MatchResult } from '@/lib/api';

function makeRow(overrides?: Partial<ImportRow>): ImportRow {
  return {
    book: {
      path: '/audiobooks/Author/Book',
      parsedTitle: 'Book',
      parsedAuthor: 'Author',
      parsedSeries: null,
      fileCount: 1,
      totalSize: 1000,
      isDuplicate: false,
    },
    selected: true,
    userEdited: false,
    edited: { title: 'Book', author: 'Author', series: '' },
    ...overrides,
  };
}

function makeMatch(overrides?: Partial<MatchResult>): MatchResult {
  return {
    path: '/audiobooks/Author/Book',
    confidence: 'medium',
    bestMatch: { title: 'Official', authors: [{ name: 'Author' }] },
    alternatives: [],
    ...overrides,
  };
}

describe('mergeMatchIntoRow', () => {
  it('high confidence preserves the prior selection', () => {
    expect(mergeMatchIntoRow(makeRow({ selected: true }), makeMatch({ confidence: 'high' })).selected).toBe(true);
    expect(mergeMatchIntoRow(makeRow({ selected: false }), makeMatch({ confidence: 'high' })).selected).toBe(false);
  });

  it('medium / none / garbage confidence fail closed to unchecked for non-userEdited rows', () => {
    expect(mergeMatchIntoRow(makeRow({ selected: true }), makeMatch({ confidence: 'medium' })).selected).toBe(false);
    expect(mergeMatchIntoRow(makeRow({ selected: true }), makeMatch({ confidence: 'none', bestMatch: null })).selected).toBe(false);
    expect(mergeMatchIntoRow(makeRow({ selected: true }), makeMatch({ confidence: 'garbage' as 'high' })).selected).toBe(false);
  });

  it('a userEdited row keeps its selection regardless of incoming confidence (#1374)', () => {
    expect(mergeMatchIntoRow(makeRow({ userEdited: true, selected: true }), makeMatch({ confidence: 'medium' })).selected).toBe(true);
    expect(mergeMatchIntoRow(makeRow({ userEdited: true, selected: true }), makeMatch({ confidence: 'none', bestMatch: null })).selected).toBe(true);
  });

  it('auto-populates edited fields only when the row has no prior metadata', () => {
    const fresh = mergeMatchIntoRow(makeRow(), makeMatch({ confidence: 'high' }));
    expect(fresh.edited.title).toBe('Official');

    const alreadyEdited = makeRow({ edited: { title: 'Mine', author: 'Author', series: '', metadata: { title: 'Mine', authors: [] } } });
    const merged = mergeMatchIntoRow(alreadyEdited, makeMatch({ confidence: 'high' }));
    expect(merged.edited.title).toBe('Mine');
  });

  it('does NOT overwrite a userEdited row that has no metadata (manual fix without picking a result, #1374 F1)', () => {
    // BookEditModal saves metadata: undefined when the user corrects fields
    // manually without selecting a provider result. The auto-populate guard must
    // honor userEdited, not just edited.metadata, or a later bestMatch clobbers
    // the user's corrections.
    const manualFix = makeRow({
      userEdited: true,
      selected: true,
      edited: { title: 'My Correction', author: 'My Author', series: 'My Series' },
    });
    const merged = mergeMatchIntoRow(manualFix, makeMatch({ confidence: 'high', bestMatch: { title: 'Provider Title', authors: [{ name: 'Provider Author' }] } }));

    expect(merged.edited.title).toBe('My Correction');
    expect(merged.edited.author).toBe('My Author');
    expect(merged.edited.series).toBe('My Series');
    expect(merged.edited.metadata).toBeUndefined();
    // The match result is still attached and selection is preserved.
    expect(merged.matchResult?.confidence).toBe('high');
    expect(merged.selected).toBe(true);
  });

  it('produces identical output for the same (row, match) inputs — no per-caller drift', () => {
    const row = makeRow({ userEdited: true, selected: true });
    const match = makeMatch({ confidence: 'medium' });
    expect(mergeMatchIntoRow(row, match)).toEqual(mergeMatchIntoRow({ ...row }, { ...match }));
  });
});
