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

  it('post-match duplicate deselects a selected high-confidence row and flags row.book (#1662 F8)', () => {
    const result = mergeMatchIntoRow(
      makeRow({ selected: true }),
      makeMatch({ confidence: 'high', isDuplicate: true, existingBookId: 421, duplicateReason: 'slug' }),
    );
    expect(result.selected).toBe(false);
    expect(result.book.isDuplicate).toBe(true);
    expect(result.book.existingBookId).toBe(421);
    expect(result.book.duplicateReason).toBe('slug');
  });

  it('post-match duplicate override beats the userEdited selection branch (#1662 F8)', () => {
    const result = mergeMatchIntoRow(
      makeRow({ userEdited: true, selected: true }),
      makeMatch({ confidence: 'high', isDuplicate: true, existingBookId: 7, duplicateReason: 'slug' }),
    );
    expect(result.selected).toBe(false);
    expect(result.book.isDuplicate).toBe(true);
  });

  it('a non-duplicate high match still preserves selection and leaves row.book untouched (no regression)', () => {
    const result = mergeMatchIntoRow(makeRow({ selected: true }), makeMatch({ confidence: 'high' }));
    expect(result.selected).toBe(true);
    expect(result.book.isDuplicate).toBe(false);
  });

  it('threads recordingVerdict onto row.book for a same-recording duplicate (#1712)', () => {
    const result = mergeMatchIntoRow(
      makeRow({ selected: true }),
      makeMatch({ confidence: 'high', isDuplicate: true, existingBookId: 5, duplicateReason: 'slug', recordingVerdict: 'same-recording' }),
    );
    expect(result.book.isDuplicate).toBe(true);
    expect(result.book.recordingVerdict).toBe('same-recording');
  });

  it('threads recordingVerdict onto row.book for a different-recording (new version of owned title), row stays selected (#1712)', () => {
    const result = mergeMatchIntoRow(
      makeRow({ selected: true }),
      makeMatch({ confidence: 'high', recordingVerdict: 'different-recording' }),
    );
    // Not a hard duplicate — a deliberate new copy stays selected.
    expect(result.selected).toBe(true);
    expect(result.book.isDuplicate).toBe(false);
    expect(result.book.recordingVerdict).toBe('different-recording');
  });

  it('threads recordingVerdict alongside reviewReason for a review verdict (#1712)', () => {
    const result = mergeMatchIntoRow(
      makeRow({ selected: true }),
      makeMatch({ confidence: 'high', reviewReason: 'Possible different recording', recordingVerdict: 'review' }),
    );
    expect(result.book.reviewReason).toBe('Possible different recording');
    expect(result.book.recordingVerdict).toBe('review');
  });

  it('produces identical output for the same (row, match) inputs — no per-caller drift', () => {
    const row = makeRow({ userEdited: true, selected: true });
    const match = makeMatch({ confidence: 'medium' });
    expect(mergeMatchIntoRow(row, match)).toEqual(mergeMatchIntoRow({ ...row }, { ...match }));
  });
});
