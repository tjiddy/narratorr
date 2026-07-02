import { describe, it, expect } from 'vitest';
import { computeMbPerHour, filterTabs } from './helpers';
import { LIBRARY_FILTER_VALUES } from '../../../shared/schemas/book.js';
import type { LibraryBookListItem } from '@/lib/api';

function makeBook(overrides: Partial<LibraryBookListItem> = {}): LibraryBookListItem {
  return {
    id: 1,
    title: 'Test Book',
    status: 'wanted',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    authors: [],
    narrators: [],
    coverUrl: null,
    seriesName: null,
    seriesPosition: null,
    duration: null,
    path: null,
    size: null,
    audioFileFormat: null,
    audioFileCount: null,
    audioTotalSize: null,
    audioDuration: null,
    lastGrabGuid: null,
    lastGrabInfoHash: null,
    ...overrides,
  };
}

describe('filterTabs (#351)', () => {
  it('includes failed and missing tab entries', () => {
    const keys = filterTabs.map((t) => t.key);
    expect(keys).toContain('failed');
    expect(keys).toContain('missing');
  });

  it('has 6 entries total', () => {
    expect(filterTabs).toHaveLength(6);
  });

  // #1447 (S2d) — tabs are derived from the canonical filter vocabulary
  it('keys equal LIBRARY_FILTER_VALUES in order', () => {
    expect(filterTabs.map((t) => t.key)).toEqual([...LIBRARY_FILTER_VALUES]);
  });
});

// #282 — computeMbPerHour helper
describe('computeMbPerHour (#282)', () => {
  it('computes MB/hr from audioTotalSize and audioDuration', () => {
    // 100 MB in 1 hour = 100 MB/hr
    const book = makeBook({ audioTotalSize: 100 * 1024 * 1024, audioDuration: 3600 });
    expect(computeMbPerHour(book)).toBeCloseTo(100, 1);
  });

  it('falls back to size when audioTotalSize is null', () => {
    // 50 MB in 1 hour = 50 MB/hr
    const book = makeBook({ audioTotalSize: null, size: 50 * 1024 * 1024, audioDuration: 3600 });
    expect(computeMbPerHour(book)).toBeCloseTo(50, 1);
  });

  it('returns null when audioDuration is null', () => {
    const book = makeBook({ audioTotalSize: 100 * 1024 * 1024, audioDuration: null });
    expect(computeMbPerHour(book)).toBeNull();
  });

  it('returns null when audioDuration is 0', () => {
    const book = makeBook({ audioTotalSize: 100 * 1024 * 1024, audioDuration: 0 });
    expect(computeMbPerHour(book)).toBeNull();
  });

  // #735 — audioDuration is in seconds, duration is in minutes; without unit
  // conversion the minutes-only path inflates results 60x.
  it('handles minutes-only duration via *60 conversion', () => {
    // 600 min = 10 hr; 360 MiB / 10 hr = 36 MB/hr
    const book = makeBook({ audioDuration: null, duration: 600, audioTotalSize: 360 * 1024 * 1024, size: null });
    expect(computeMbPerHour(book)).toBeCloseTo(36, 1);
  });

  it('prefers audioDuration when both audioDuration and duration are populated', () => {
    // audioDuration: 36000s = 10hr; duration field is ignored
    const book = makeBook({ audioDuration: 36000, duration: 600, audioTotalSize: 360 * 1024 * 1024, size: null });
    expect(computeMbPerHour(book)).toBeCloseTo(36, 1);
  });

  it('falls back to size when audioTotalSize is null and audioDuration is set', () => {
    const book = makeBook({ audioDuration: 36000, duration: null, audioTotalSize: null, size: 360 * 1024 * 1024 });
    expect(computeMbPerHour(book)).toBeCloseTo(36, 1);
  });

  it('falls through to duration when audioDuration is 0', () => {
    // audioDuration: 0 should NOT short-circuit; falls through to duration (600 min = 10 hr)
    const book = makeBook({ audioDuration: 0, duration: 600, audioTotalSize: 360 * 1024 * 1024, size: null });
    expect(computeMbPerHour(book)).toBeCloseTo(36, 1);
  });

  it('returns null when both duration sources are null/zero', () => {
    const book = makeBook({ audioDuration: 0, duration: null, audioTotalSize: 360 * 1024 * 1024 });
    expect(computeMbPerHour(book)).toBeNull();
  });

  it('returns null when both duration sources are null', () => {
    const book = makeBook({ audioDuration: null, duration: null, audioTotalSize: 360 * 1024 * 1024 });
    expect(computeMbPerHour(book)).toBeNull();
  });
});
