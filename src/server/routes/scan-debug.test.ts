import { describe, it, expect, type vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { scanDebugTraceSchema } from '../../shared/schemas.js';

describe('POST /api/library/scan-debug', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
  });

  describe('schema validation', () => {
    it('returns 200 with structured trace JSON for valid folderName', async () => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>)
        .mockResolvedValue([{ title: 'Title', authors: [{ name: 'Author' }], asin: 'B001', providerId: 'us-B001' }]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>)
        .mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Title' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      // Validate response conforms to the shared debug-trace schema
      const parsed = scanDebugTraceSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      expect(body.input).toBe('Author/Title');
      expect(body.parts).toEqual(['Author', 'Title']);
      expect(body.parsing).toBeDefined();
      expect(body.cleaning).toBeDefined();
      expect(body.search).toBeDefined();
      expect(body.match).toBeDefined();
      expect(body.duplicate).toBeDefined();
    });

    it('returns 400 when folderName is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when folderName is empty string', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: '' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when folderName is whitespace-only', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: '   ' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when folderName is non-string', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 123 },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('pre-parse segmentation', () => {
    beforeEach(() => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    });

    it('splits forward-slash path into parts array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Series/Title' },
      });

      const body = JSON.parse(res.payload);
      expect(body.parts).toEqual(['Author', 'Series', 'Title']);
    });

    it('splits backslash path into parts array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author\\Series\\Title' },
      });

      const body = JSON.parse(res.payload);
      expect(body.parts).toEqual(['Author', 'Series', 'Title']);
    });

    it('single segment with no separators produces 1-element array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author - Title' },
      });

      const body = JSON.parse(res.payload);
      expect(body.parts).toEqual(['Author - Title']);
    });

    it('filters out empty segments from leading/trailing separators', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: '/Author/Title/' },
      });

      const body = JSON.parse(res.payload);
      expect(body.parts).toEqual(['Author', 'Title']);
    });
  });

  describe('parsing step', () => {
    beforeEach(() => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    });

    it('reports 1-part pattern for single segment input', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author - Title' },
      });

      const body = JSON.parse(res.payload);
      expect(body.parsing.pattern).toBe('1-part');
    });

    it('reports 3+-part pattern for three-segment path', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Series/Title' },
      });

      const body = JSON.parse(res.payload);
      expect(body.parsing.pattern).toBe('3+-part');
      expect(body.parsing.raw.author).toBe('Author');
      expect(body.parsing.raw.title).toBe('Title');
      expect(body.parsing.raw.series).toBe('Series');
    });

    it('reports 3+-part pattern for four-segment path (same parser branch)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/SubDir/Series/Title' },
      });

      const body = JSON.parse(res.payload);
      expect(body.parsing.pattern).toBe('3+-part');
    });

    it('extracts author/title from "Author - Title" single segment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Andy Weir - Project Hail Mary' },
      });

      const body = JSON.parse(res.payload);
      expect(body.parsing.raw.author).toBe('Andy Weir');
      expect(body.parsing.raw.title).toBe('Project Hail Mary');
    });

    it('returns null author for title-only single segment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'JustATitle' },
      });

      const body = JSON.parse(res.payload);
      expect(body.parsing.raw.author).toBeNull();
      expect(body.parsing.raw.title).toBe('JustATitle');
    });
  });

  describe('cleaning step', () => {
    beforeEach(() => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    });

    it('includes all 10 cleaning sub-steps in trace', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Title' },
      });

      const body = JSON.parse(res.payload);
      expect(body.cleaning.title.steps).toHaveLength(10);
      expect(body.cleaning.title.steps.map((s: { name: string }) => s.name)).toEqual([
        'leadingNumeric', 'seriesMarker', 'normalize',
        'yearParenStrip', 'yearBracketStrip', 'yearBareStrip',
        'emptyParenStrip', 'emptyBracketStrip', 'narratorParen', 'dedup',
      ]);
    });

    it('shows transformation for segment with codec tag starting from raw input', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Title MP3' },
      });

      const body = JSON.parse(res.payload);
      // Cleaning trace must start from the raw segment, not the already-cleaned parser output
      expect(body.cleaning.title.input).toBe('Title MP3');
      // normalize step is the transition that strips "MP3"
      const normalizeStep = body.cleaning.title.steps.find((s: { name: string }) => s.name === 'normalize');
      expect(normalizeStep.output).toBe('Title');
      expect(body.cleaning.title.result).toBe('Title');
    });

    it('preserves non-codec bracket tag like [GA]', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Title [GA]' },
      });

      const body = JSON.parse(res.payload);
      expect(body.cleaning.title.result).toBe('Title [GA]');
    });
  });

  describe('search step', () => {
    it('includes initialQuery and results when search returns matches', async () => {
      const mockResults = [
        { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }], asin: 'B001', providerId: 'us-B001' },
      ];
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Brandon Sanderson/The Way of Kings' },
      });

      const body = JSON.parse(res.payload);
      expect(body.search.initialQuery).toBe('The Way of Kings Brandon Sanderson');
      expect(body.search.results).toHaveLength(1);
      expect(body.search.results[0].title).toBe('The Way of Kings');
      expect(body.search.results[0].authors).toEqual(['Brandon Sanderson']);
      expect(body.search.results[0].asin).toBe('B001');
      expect(body.search.results[0].providerId).toBe('us-B001');
    });

    it('shows swapRetry true and swapQuery when initial returns zero with author', async () => {
      const mockResults = [{ title: 'Found', authors: [{ name: 'Author' }], asin: 'B002', providerId: 'us-B002' }];
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(mockResults);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Title' },
      });

      const body = JSON.parse(res.payload);
      expect(body.search.swapRetry).toBe(true);
      expect(body.search.swapQuery).toBe('Author Title');
      expect(body.search.initialResultCount).toBe(0);
    });

    it('shows swapRetry false when no author present', async () => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'JustATitle' },
      });

      const body = JSON.parse(res.payload);
      expect(body.search.swapRetry).toBe(false);
      expect(body.search.swapQuery).toBeNull();
    });
  });

  describe('match step', () => {
    it('returns status "matched" with selected top result', async () => {
      const mockResults = [
        { title: 'Title', authors: [{ name: 'Author' }], asin: 'B001', providerId: 'us-B001' },
        { title: 'Title 2', authors: [{ name: 'Author' }], asin: 'B002', providerId: 'us-B002' },
      ];
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Title' },
      });

      const body = JSON.parse(res.payload);
      expect(body.match.status).toBe('matched');
      expect(body.match.selected.title).toBe('Title');
      expect(body.match.selected.asin).toBe('B001');
    });

    it('returns status "no match" when no results', async () => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Title' },
      });

      const body = JSON.parse(res.payload);
      expect(body.match.status).toBe('no match');
      expect(body.match.selected).toBeNull();
    });
  });

  describe('duplicate check', () => {
    it('reports isDuplicate true when findDuplicate returns a match', async () => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ id: 42, title: 'Title' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Title' },
      });

      const body = JSON.parse(res.payload);
      expect(body.duplicate.isDuplicate).toBe(true);
      expect(body.duplicate.existingBookId).toBe(42);
      expect(body.duplicate.reason).toBe('library-match');
    });

    it('reports isDuplicate false when no match', async () => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Title' },
      });

      const body = JSON.parse(res.payload);
      expect(body.duplicate.isDuplicate).toBe(false);
      expect(body.duplicate.existingBookId).toBeNull();
      expect(body.duplicate.reason).toBeNull();
    });

    it('uses title-only matching for authorless input', async () => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'JustATitle' },
      });

      expect(res.statusCode).toBe(200);
      // findDuplicate called with title only, no authorList
      expect(services.book.findDuplicate).toHaveBeenCalledWith('JustATitle', undefined);
    });
  });

  describe('error contract', () => {
    it('returns 502 with partialTrace when metadata provider fails', async () => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('API timeout'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Title' },
      });

      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Bad Gateway');
      expect(body.message).toContain('API timeout');
      expect(body.partialTrace).toBeDefined();
      expect(body.partialTrace.parsing).toBeDefined();
      expect(body.partialTrace.cleaning).toBeDefined();
      expect(body.partialTrace.search).toBeNull();
      expect(body.partialTrace.match).toBeNull();
      expect(body.partialTrace.duplicate).toBeNull();
    });

    it('partialTrace includes completed parsing/cleaning, null for search/match/duplicate', async () => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('Rate limited'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Title' },
      });

      const body = JSON.parse(res.payload);
      expect(body.partialTrace.input).toBe('Author/Title');
      expect(body.partialTrace.parts).toEqual(['Author', 'Title']);
      expect(body.partialTrace.parsing.pattern).toBe('2-part');
      expect(body.partialTrace.cleaning.title).toBeDefined();
      expect(body.partialTrace.cleaning.author).toBeDefined();
    });

    it('returns 400 for validation errors without partialTrace', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.partialTrace).toBeUndefined();
    });

    it('returns 500 when duplicate check fails (not 502 metadata error)', async () => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('DB connection lost'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Author/Title' },
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe('Internal Server Error');
      expect(body.message).toContain('Duplicate check failed');
      expect(body.message).toContain('DB connection lost');
      // Partial trace should include completed search/match but null duplicate
      expect(body.partialTrace.search).not.toBeNull();
      expect(body.partialTrace.match).not.toBeNull();
      expect(body.partialTrace.duplicate).toBeNull();
    });
  });

  describe('ASIN direct lookup trace (issue #454)', () => {
    it('returns parsing.raw.asin for ASIN-tagged folder', async () => {
      (services.metadata.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ title: 'Tress', authors: [{ name: 'Sanderson' }], asin: 'B0D18DYG5C', providerId: 'p1' });
      (services.book.findDuplicate as ReturnType<typeof vi.fn>)
        .mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Tress of the Emerald Sea [B0D18DYG5C]' },
      });

      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.parsing.raw.asin).toBe('B0D18DYG5C');
    });

    it('returns parsing.raw.asin as null for non-ASIN folder', async () => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>)
        .mockResolvedValue([{ title: 'Title', authors: [{ name: 'Author' }], asin: null, providerId: null }]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>)
        .mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Just A Title' },
      });

      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.parsing.raw.asin).toBeNull();
    });

    it('returns parsing.raw.title as ASIN-stripped value', async () => {
      (services.metadata.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ title: 'Tress', authors: [{ name: 'Sanderson' }], asin: 'B0D18DYG5C', providerId: 'p1' });
      (services.book.findDuplicate as ReturnType<typeof vi.fn>)
        .mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Tress of the Emerald Sea [B0D18DYG5C]' },
      });

      const body = res.json();
      expect(body.parsing.raw.title).toBe('Tress of the Emerald Sea');
    });

    it('returns search.directLookup with hit:true when getBook succeeds', async () => {
      (services.metadata.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ title: 'Tress', authors: [{ name: 'Sanderson' }], asin: 'B0D18DYG5C', providerId: 'p1' });
      (services.book.findDuplicate as ReturnType<typeof vi.fn>)
        .mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Tress [B0D18DYG5C]' },
      });

      const body = res.json();
      expect(body.search.directLookup).toEqual({ asin: 'B0D18DYG5C', hit: true });
      expect(body.search.initialQuery).toBe('B0D18DYG5C');
      expect(body.search.initialResultCount).toBe(1);
      expect(body.search.swapRetry).toBe(false);
      expect(body.search.results).toHaveLength(1);
      expect(body.match.status).toBe('matched');
    });

    it('returns search.directLookup with hit:false when getBook returns null, falls back to keyword search', async () => {
      (services.metadata.getBook as ReturnType<typeof vi.fn>)
        .mockResolvedValue(null);
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>)
        .mockResolvedValue([{ title: 'Fallback', authors: [{ name: 'Author' }], asin: null, providerId: null }]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>)
        .mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Tress [B0D18DYG5C]' },
      });

      const body = res.json();
      expect(body.search.directLookup).toEqual({ asin: 'B0D18DYG5C', hit: false });
      // Falls back to keyword search
      expect(body.search.results).toHaveLength(1);
      expect(body.search.results[0].title).toBe('Fallback');
    });

    it('returns search.directLookup with hit:false when getBook throws, falls back to keyword search', async () => {
      (services.metadata.getBook as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('Provider timeout'));
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>)
        .mockResolvedValue([{ title: 'Fallback', authors: [{ name: 'Author' }], asin: null, providerId: null }]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>)
        .mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Tress [B0D18DYG5C]' },
      });

      const body = res.json();
      expect(res.statusCode).toBe(200);
      expect(body.search.directLookup).toEqual({ asin: 'B0D18DYG5C', hit: false });
      // Falls back to keyword search, NOT a 502
      expect(body.search.results).toHaveLength(1);
      expect(body.search.results[0].title).toBe('Fallback');
    });

    it('returns search.directLookup as null when no ASIN detected', async () => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>)
        .mockResolvedValue([{ title: 'Title', authors: [{ name: 'Author' }], asin: null, providerId: null }]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>)
        .mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Just A Title' },
      });

      const body = res.json();
      expect(body.search.directLookup).toBeNull();
    });
  });

  describe('all-numeric date-like titles (issue #701)', () => {
    it('Stephen King/11-22-63 preserves date-like title through parsing/cleaning into search', async () => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Stephen King/11-22-63' },
      });

      const body = JSON.parse(res.payload);
      expect(res.statusCode).toBe(200);
      expect(body.parsing.raw.title).toBe('11-22-63');
      expect(body.parsing.raw.series).toBeNull();
      expect(body.cleaning.title.result).toBe('11-22-63');
      expect(body.search.initialQuery).toBe('11-22-63 Stephen King');
    });

    it('Asimov/Foundation - 02 - Second Foundation (real series) still splits into series/title', async () => {
      (services.metadata.searchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (services.book.findDuplicate as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/library/scan-debug',
        payload: { folderName: 'Asimov/Foundation - 02 - Second Foundation' },
      });

      const body = JSON.parse(res.payload);
      expect(res.statusCode).toBe(200);
      expect(body.parsing.raw.series).toBe('Foundation');
      expect(body.parsing.raw.title).toBe('Second Foundation');
      expect(body.search.initialQuery).toBe('Second Foundation Asimov');
    });
  });
});
