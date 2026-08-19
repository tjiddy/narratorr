import { describe, it, expect } from 'vitest';
import { toConfirmItem } from './toConfirmItem.js';
import { mergeMatchIntoRow, type ImportRow } from '@/components/manual-import';
import type { DiscoveredBook, MatchResult } from '@/lib/api';

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
    const item = toConfirmItem(row({ edited: { title: 'Book', author: 'Author', series: ' Provider Saga ', seriesPosition: 2 } }), false);
    expect(item.seriesName).toBe(' Provider Saga ');
    expect(item.seriesPosition).toBe(2);
  });
});

// The server's #2296 mirror classifier is only correct if the client really does emit the provider's
// series at the top level of an untouched row. Pin that seam so the server fixtures cannot be fiction.
describe('toConfirmItem — the provider-series mirror the server classifies (#2296)', () => {
  // Shaped exactly as useLibraryImport seeds a fresh scan row: folder parse, untouched, no metadata.
  function scannedRow(parsedSeries: string, parsedSeriesPosition?: number): ImportRow {
    return row({
      book: book({ parsedSeries }),
      userEdited: false,
      edited: {
        title: 'Book', author: 'Author', series: parsedSeries,
        ...(parsedSeriesPosition !== undefined && { seriesPosition: parsedSeriesPosition }),
      },
    });
  }

  function matchWith(seriesPrimary: { name: string; position?: number }): MatchResult {
    return {
      path: '/audiobooks/Author/Book',
      confidence: 'high',
      alternatives: [],
      bestMatch: { title: 'Book', authors: [{ name: 'Author' }], seriesPrimary },
    };
  }

  it('an untouched row DISCARDS the folder series: the payload carries the provider primary at the top level', () => {
    const merged = mergeMatchIntoRow(scannedRow('Discworld', 4), matchWith({ name: 'Discworld: Death', position: 1 }));

    const item = toConfirmItem(merged, false);
    expect(item.seriesName).toBe('Discworld: Death');
    expect(item.seriesPosition).toBe(1);
    // Equal to metadata.seriesPrimary.name — exactly what mirrorsProviderSeries keys on.
    expect(item.metadata?.seriesPrimary).toStrictEqual({ name: 'Discworld: Death', position: 1 });
  });

  it('a provider primary with NO index yields the hybrid: provider name + the FOLDER position', () => {
    const merged = mergeMatchIntoRow(scannedRow('Discworld', 4), matchWith({ name: 'Discworld: Death' }));

    const item = toConfirmItem(merged, false);
    expect(item.seriesName).toBe('Discworld: Death');
    expect(item.seriesPosition).toBe(4);
  });

  it('a user-edited row keeps its own series, so the server sees no mirror', () => {
    const edited = { ...scannedRow('Discworld', 4), userEdited: true };
    const merged = mergeMatchIntoRow(edited, matchWith({ name: 'Discworld: Death', position: 1 }));

    expect(toConfirmItem(merged, false).seriesName).toBe('Discworld');
  });
});
