import { describe, it, expect } from 'vitest';
import { toConfirmItem } from './toConfirmItem.js';
import type { ImportRow } from '@/components/manual-import';
import type { DiscoveredBook } from '@/lib/api';

function book(overrides: Partial<DiscoveredBook> = {}): DiscoveredBook {
  return {
    path: '/audiobooks/Author/Book',
    parsedTitle: 'Book',
    parsedAuthor: 'Author',
    parsedSeries: null,
    fileCount: 3,
    totalSize: 100000,
    isDuplicate: false,
    ...overrides,
  };
}

function row(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    book: book(),
    selected: true,
    userEdited: false,
    edited: { title: 'Book', author: 'Author', series: '' },
    ...overrides,
  };
}

describe('toConfirmItem forceImport derivation', () => {
  // #1925: a former within-scan row is a NORMAL candidate (isDuplicate: false). With
  // force=false it must submit WITHOUT forceImport so `classifyConfirmItem` runs the
  // confirm-time recording ladder instead of the row bypassing it.
  it('isDuplicate=false + force=false → no forceImport (former within-scan row flows through the ladder)', () => {
    const item = toConfirmItem(row({ book: book({ isDuplicate: false, reviewReason: 'Possible duplicate folder in this scan' }) }), false);
    expect(item).not.toHaveProperty('forceImport');
  });

  it('force=true → forceImport true (held-review re-confirm still bypasses the safety net)', () => {
    const item = toConfirmItem(row({ book: book({ isDuplicate: false }) }), true);
    expect(item.forceImport).toBe(true);
  });

  it('isDuplicate=true (a DB duplicate) + force=false → forceImport true (manual-import trust boundary unchanged)', () => {
    const item = toConfirmItem(row({ book: book({ isDuplicate: true, duplicateReason: 'slug' }) }), false);
    expect(item.forceImport).toBe(true);
  });
});

// #1927 AC5 — two-state, pair-locked series mapping. A non-empty edited series emits
// seriesName (original, untrimmed) + its paired seriesPosition; empty/whitespace omits
// BOTH (defer). An untouched seeded row carries the provider primary (item-first no-op).
describe('toConfirmItem series mapping', () => {
  it('user-set series → payload carries seriesName + paired seriesPosition', () => {
    const item = toConfirmItem(row({ edited: { title: 'Book', author: 'Author', series: 'The Dresden Files', seriesPosition: 10 } }), false);
    expect(item.seriesName).toBe('The Dresden Files');
    expect(item.seriesPosition).toBe(10);
  });

  it('user-set series with no position → seriesName present, seriesPosition omitted (pair-lock)', () => {
    const item = toConfirmItem(row({ edited: { title: 'Book', author: 'Author', series: 'Custom Saga' } }), false);
    expect(item.seriesName).toBe('Custom Saga');
    expect(item).not.toHaveProperty('seriesPosition');
  });

  it('empty edited.series → BOTH seriesName and seriesPosition omitted (defer)', () => {
    const item = toConfirmItem(row({ edited: { title: 'Book', author: 'Author', series: '', seriesPosition: 15 } }), false);
    expect(item).not.toHaveProperty('seriesName');
    expect(item).not.toHaveProperty('seriesPosition');
  });

  it('whitespace-only edited.series → BOTH omitted (defer, non-React-caller parity)', () => {
    const item = toConfirmItem(row({ edited: { title: 'Book', author: 'Author', series: '   ', seriesPosition: 15 } }), false);
    expect(item).not.toHaveProperty('seriesName');
    expect(item).not.toHaveProperty('seriesPosition');
  });

  it('untouched seeded row (edited.series = provider primary) → seriesName carries that value verbatim (AC4 item-first no-op)', () => {
    // The padded value proves trim classifies but does NOT rewrite — the original string ships.
    const item = toConfirmItem(row({ edited: { title: 'Book', author: 'Author', series: ' Provider Saga ', seriesPosition: 2 } }), false);
    expect(item.seriesName).toBe(' Provider Saga ');
    expect(item.seriesPosition).toBe(2);
  });
});
