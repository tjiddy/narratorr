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
