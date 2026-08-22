import { describe, expect, it } from 'vitest';
import {
  importConfirmItemSchema,
  jobIdParamSchema,
  matchCandidateSchema,
  scanDirectoryBodySchema,
  heldReviewItemSchema,
  importSkipReasonSchema,
} from './library-scan.js';

describe('heldReviewItemSchema (#1711, retained)', () => {
  it('round-trips a held-review item with an optional existingBookId', () => {
    const item = { path: '/lib/Author/Title', title: 'Title', reason: 'recording-review-required' as const, existingBookId: 42 };
    const result = heldReviewItemSchema.safeParse(item);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(item);
  });

  it('accepts a held-review item without existingBookId', () => {
    const result = heldReviewItemSchema.safeParse({ path: '/lib/x', title: 'X', reason: 'recording-review-required' });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown reason enum value', () => {
    const result = heldReviewItemSchema.safeParse({ path: '/lib/x', title: 'X', reason: 'something-else' });
    expect(result.success).toBe(false);
  });
});

describe('importSkipReasonSchema (#1822, retained — consumed by the staged DTO)', () => {
  it('accepts the three live skip reasons', () => {
    expect(importSkipReasonSchema.safeParse('already-in-library').success).toBe(true);
    expect(importSkipReasonSchema.safeParse('already-importing').success).toBe(true);
    expect(importSkipReasonSchema.safeParse('duplicate-copy-at-other-path').success).toBe(true);
  });

  it('rejects an unknown skip reason', () => {
    expect(importSkipReasonSchema.safeParse('not-a-reason').success).toBe(false);
  });
});

describe('scanDirectoryBodySchema — trim behavior', () => {
  it('rejects whitespace-only path', () => {
    const result = scanDirectoryBodySchema.safeParse({ path: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from path', () => {
    const result = scanDirectoryBodySchema.safeParse({ path: '  /books/  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.path).toBe('/books/');
  });
});

describe('importConfirmItemSchema — trim behavior', () => {
  const validItem = { path: '/books/file.mp3', title: 'My Book' };

  it('rejects whitespace-only path', () => {
    const result = importConfirmItemSchema.safeParse({ ...validItem, path: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only title', () => {
    const result = importConfirmItemSchema.safeParse({ ...validItem, title: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from path', () => {
    const result = importConfirmItemSchema.safeParse({ ...validItem, path: '  /books/file.mp3  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.path).toBe('/books/file.mp3');
  });

  it('trims leading/trailing spaces from title', () => {
    const result = importConfirmItemSchema.safeParse({ ...validItem, title: '  My Book  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.title).toBe('My Book');
  });

  it('accepts valid path and title', () => {
    const result = importConfirmItemSchema.safeParse(validItem);
    expect(result.success).toBe(true);
  });
});

describe('matchCandidateSchema — trim behavior', () => {
  const validCandidate = { path: '/books/file.mp3', title: 'My Book' };

  it('rejects whitespace-only path', () => {
    const result = matchCandidateSchema.safeParse({ ...validCandidate, path: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only title', () => {
    const result = matchCandidateSchema.safeParse({ ...validCandidate, title: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from path and title', () => {
    const result = matchCandidateSchema.safeParse({
      path: '  /books/file.mp3  ',
      title: '  My Book  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe('/books/file.mp3');
      expect(result.data.title).toBe('My Book');
    }
  });

  it('retains seriesPosition through the parse', () => {
    const result = matchCandidateSchema.safeParse({ ...validCandidate, seriesPosition: 3 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.seriesPosition).toBe(3);
  });

  it('retains a seriesPosition of 0 (not stripped as falsy)', () => {
    const result = matchCandidateSchema.safeParse({ ...validCandidate, seriesPosition: 0 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.seriesPosition).toBe(0);
  });
});

describe('jobIdParamSchema — trim behavior', () => {
  it('rejects whitespace-only jobId', () => {
    const result = jobIdParamSchema.safeParse({ jobId: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from jobId', () => {
    const result = jobIdParamSchema.safeParse({ jobId: '  job-123  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.jobId).toBe('job-123');
  });
});

import {
  duplicateReasonSchema,
  discoveredBookSchema,
  scanResultSchema,
  scanDebugTraceSchema,
} from './library-scan.js';

describe('importConfirmItemSchema — narrators and seriesPosition (#1028)', () => {
  const validItem = { path: '/books/file.mp3', title: 'My Book' };

  it('round-trips narrators and seriesPosition', () => {
    const result = importConfirmItemSchema.safeParse({
      ...validItem,
      narrators: ['Jim Dale', 'Stephen Fry'],
      seriesPosition: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.narrators).toEqual(['Jim Dale', 'Stephen Fry']);
      expect(result.data.seriesPosition).toBe(5);
    }
  });

  it('preserves seriesPosition: 0 (regression guard against falsy drop)', () => {
    const result = importConfirmItemSchema.safeParse({ ...validItem, seriesPosition: 0 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.seriesPosition).toBe(0);
  });

  it('accepts fractional seriesPosition like 1.5', () => {
    const result = importConfirmItemSchema.safeParse({ ...validItem, seriesPosition: 1.5 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.seriesPosition).toBe(1.5);
  });

  it('rejects whitespace-only narrator entries', () => {
    const result = importConfirmItemSchema.safeParse({ ...validItem, narrators: ['  '] });
    expect(result.success).toBe(false);
  });

  it('omits both fields when not provided', () => {
    const result = importConfirmItemSchema.safeParse(validItem);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.narrators).toBeUndefined();
      expect(result.data.seriesPosition).toBeUndefined();
    }
  });
});

describe('manualImportJobPayloadSchema — narrators and seriesPosition flow through (#1028)', () => {
  it('inherits narrators and seriesPosition from base schema (incl. 0)', async () => {
    const { manualImportJobPayloadSchema } = await import('../../server/services/import-adapters/types.js');
    const result = manualImportJobPayloadSchema.safeParse({
      path: '/books/file.mp3',
      title: 'My Book',
      narrators: ['Jim Dale'],
      seriesPosition: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.narrators).toEqual(['Jim Dale']);
      expect(result.data.seriesPosition).toBe(0);
    }
  });
});

describe('duplicateReasonSchema — DB-backed reasons only (#1925)', () => {
  it('accepts path and slug values', () => {
    expect(duplicateReasonSchema.safeParse('path').success).toBe(true);
    expect(duplicateReasonSchema.safeParse('slug').success).toBe(true);
  });

  it('rejects the removed within-scan value (#1925)', () => {
    const result = duplicateReasonSchema.safeParse('within-scan');
    expect(result.success).toBe(false);
  });

  it('rejects invalid values like foo', () => {
    const result = duplicateReasonSchema.safeParse('foo');
    expect(result.success).toBe(false);
  });
});

describe('discoveredBookSchema — parsedSeriesPosition field (#1042)', () => {
  const validDiscovery = {
    path: '/audiobooks/Author/Series/Book',
    parsedTitle: 'Book',
    parsedAuthor: 'Author',
    parsedSeries: 'Series',
    fileCount: 3,
    totalSize: 100,
    isDuplicate: false,
  };

  it('accepts validDiscovery without parsedSeriesPosition (optional field)', () => {
    const result = discoveredBookSchema.safeParse(validDiscovery);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.parsedSeriesPosition).toBeUndefined();
  });

  it('accepts decimal parsedSeriesPosition like 2.5', () => {
    const result = discoveredBookSchema.safeParse({ ...validDiscovery, parsedSeriesPosition: 2.5 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.parsedSeriesPosition).toBe(2.5);
  });

  it('preserves parsedSeriesPosition: 0 (regression guard)', () => {
    const result = discoveredBookSchema.safeParse({ ...validDiscovery, parsedSeriesPosition: 0 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.parsedSeriesPosition).toBe(0);
  });

  it('rejects explicit null parsedSeriesPosition (schema is optional, not nullable)', () => {
    const result = discoveredBookSchema.safeParse({ ...validDiscovery, parsedSeriesPosition: null });
    expect(result.success).toBe(false);
  });
});

describe('discoveredBookSchema — duplicateFirstPath removed (#1925)', () => {
  const validDiscovery = {
    path: '/audiobooks/Author/Title',
    parsedTitle: 'Title',
    parsedAuthor: 'Author',
    parsedSeries: null,
    fileCount: 3,
    totalSize: 100,
    isDuplicate: true,
    duplicateReason: 'slug',
  };

  it('no longer carries duplicateFirstPath — the field is stripped as unknown', () => {
    const result = discoveredBookSchema.safeParse({
      ...validDiscovery,
      duplicateFirstPath: '/audiobooks/Other/Title',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty('duplicateFirstPath');
  });
});

describe('discoveredBookSchema / scanResultSchema — existingPath (#2091)', () => {
  const copyDuplicate = {
    path: '/audiobooks/Robin Hobb/Realms of the Elderlings/02 - Royal Assassin',
    parsedTitle: 'Royal Assassin',
    parsedAuthor: 'Robin Hobb',
    parsedSeries: 'Realms of the Elderlings',
    fileCount: 1,
    totalSize: 100,
    isDuplicate: true,
    duplicateReason: 'slug',
    existingBookId: 7,
    existingPath: '/audiobooks/Robin Hobb/Farseer Trilogy/02 - Royal Assassin',
  };

  it('round-trips existingPath on a slug duplicate', () => {
    const result = discoveredBookSchema.safeParse(copyDuplicate);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.existingPath).toBe(copyDuplicate.existingPath);
  });

  it('accepts a discovery without existingPath', () => {
    const { existingPath: _omitted, ...withoutPath } = copyDuplicate;
    const result = discoveredBookSchema.safeParse(withoutPath);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.existingPath).toBeUndefined();
  });

  // Strip pin: the scan route re-parses its decorated response, so an undeclared
  // field reaches the type but never the client.
  it('survives scanResultSchema.parse, which strips undeclared keys', () => {
    const parsed = scanResultSchema.parse({
      discoveries: [{ ...copyDuplicate, previewUrl: '/api/import/preview/tok' }],
      totalFolders: 1,
    });
    expect(parsed.discoveries[0]!.existingPath).toBe(copyDuplicate.existingPath);
  });
});

describe('scanDebugTraceSchema — parsing.raw.seriesPosition contract (#1042)', () => {
  const validTrace = {
    input: 'Author/Title',
    parts: ['Author', 'Title'],
    parsing: {
      pattern: '2-part',
      raw: {
        author: 'Author',
        title: 'Title',
        series: null,
        seriesPosition: null,
        asin: null,
      },
    },
    cleaning: {},
    search: null,
    match: null,
    duplicate: null,
  };

  it('preserves a numeric parsing.raw.seriesPosition', () => {
    const result = scanDebugTraceSchema.safeParse({
      ...validTrace,
      parsing: { ...validTrace.parsing, raw: { ...validTrace.parsing.raw, seriesPosition: 2 } },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.parsing.raw.seriesPosition).toBe(2);
  });

  it('preserves a null parsing.raw.seriesPosition', () => {
    const result = scanDebugTraceSchema.safeParse(validTrace);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.parsing.raw.seriesPosition).toBeNull();
  });

  it('rejects a non-number parsing.raw.seriesPosition (e.g. string)', () => {
    const result = scanDebugTraceSchema.safeParse({
      ...validTrace,
      parsing: { ...validTrace.parsing, raw: { ...validTrace.parsing.raw, seriesPosition: '2' } },
    });
    expect(result.success).toBe(false);
  });
});
