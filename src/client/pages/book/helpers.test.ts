import { describe, it, expect } from 'vitest';
import { mergeBookData } from './helpers.js';
import { bookStatusConfig } from '@/lib/status';
import { createMockBook } from '@/__tests__/factories';
import type { BookStatus } from '../../../shared/schemas.js';

describe('mergeBookData', () => {
  describe('status palette flow-through', () => {
    it('returns updated dot class for wanted status', () => {
      const book = createMockBook({ status: 'wanted' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.wanted!.dotClass);
    });

    it('returns updated dot class for searching status', () => {
      const book = createMockBook({ status: 'searching' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.searching!.dotClass);
    });

    it('returns updated dot class for downloading status', () => {
      const book = createMockBook({ status: 'downloading' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.downloading!.dotClass);
    });

    it('returns updated dot class for importing status', () => {
      const book = createMockBook({ status: 'importing' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.importing!.dotClass);
    });

    it('returns updated dot class for imported status', () => {
      const book = createMockBook({ status: 'imported' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.imported!.dotClass);
    });

    it('returns updated dot class for missing status', () => {
      const book = createMockBook({ status: 'missing' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.missing!.dotClass);
    });

    it('returns updated dot class for failed status', () => {
      const book = createMockBook({ status: 'failed' });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.failed!.dotClass);
    });

    it('returns bar class for each status', () => {
      const book = createMockBook({ status: 'imported' });
      const result = mergeBookData(book);
      expect(result.statusBarClass).toBe(bookStatusConfig.imported!.barClass);
    });

    it('falls back to wanted config for unknown status string', () => {
      const book = createMockBook({ status: 'nonexistent' as unknown as BookStatus });
      const result = mergeBookData(book);
      expect(result.statusDotClass).toBe(bookStatusConfig.wanted!.dotClass);
      expect(result.statusBarClass).toBe(bookStatusConfig.wanted!.barClass);
      expect(result.statusLabel).toBe('Wanted');
    });
  });

  describe('metaDots duration formatting', () => {
    it('includes formatted duration in metaDots from library book', () => {
      const book = createMockBook({ duration: 90 });
      const result = mergeBookData(book);
      expect(result.metaDots).toContain('1h 30m');
    });

    it('falls back to metadata duration when library book has none', () => {
      const book = createMockBook({ duration: null });
      const result = mergeBookData(book, { duration: 60 });
      expect(result.metaDots).toContain('1h');
    });

    it('excludes duration from metaDots when both sources are null', () => {
      const book = createMockBook({ duration: null });
      const result = mergeBookData(book, {});
      expect(result.metaDots.some((d: string) => /\d+[hm]/.test(d))).toBe(false);
    });
  });

  describe('metaDots publish year', () => {
    it('extracts year from a full ISO publishedDate', () => {
      const book = createMockBook({ publishedDate: '2010-08-31' });
      const result = mergeBookData(book);
      expect(result.metaDots).toContain('2010');
    });

    it('uses a bare 4-digit publishedDate as-is', () => {
      const book = createMockBook({ publishedDate: '2010' });
      const result = mergeBookData(book);
      expect(result.metaDots).toContain('2010');
    });

    it('omits year when publishedDate is null', () => {
      const book = createMockBook({ publishedDate: null });
      const result = mergeBookData(book);
      expect(result.metaDots).not.toContain('2010');
      expect(result.metaDots.some((d) => /^\d{4}$/.test(d))).toBe(false);
    });

    it('omits year when publishedDate is empty string', () => {
      const book = createMockBook({ publishedDate: '' });
      const result = mergeBookData(book);
      expect(result.metaDots.some((d) => /^\d{4}$/.test(d))).toBe(false);
    });

    it('omits year and renders no placeholder for unparseable values', () => {
      for (const value of ['invalid', '99', 'abc-de']) {
        const book = createMockBook({ publishedDate: value });
        const result = mergeBookData(book);
        expect(result.metaDots.some((d) => /^\d{4}$/.test(d))).toBe(false);
        const joined = result.metaDots.join(' · ');
        expect(joined).not.toMatch(/Unknown|NaN|Invalid Date/);
      }
    });

    it('falls back to metadataBook.publishedDate when library record is null', () => {
      const book = createMockBook({ publishedDate: null });
      const result = mergeBookData(book, { publishedDate: '2007-01-01' });
      expect(result.metaDots).toContain('2007');
    });

    it('falls back to metadataBook.publishedDate when library record is empty string', () => {
      const book = createMockBook({ publishedDate: '' });
      const result = mergeBookData(book, { publishedDate: '2007-01-01' });
      expect(result.metaDots).toContain('2007');
    });

    it('orders metaDots as series · duration · year · publisher when all are present', () => {
      const book = createMockBook({
        seriesName: 'The Stormlight Archive',
        seriesPosition: 1,
        duration: 872,
        publishedDate: '2010-08-31',
      });
      const result = mergeBookData(book, { publisher: 'Tor Books' });
      expect(result.metaDots).toEqual(['The Stormlight Archive #1', '14h 32m', '2010', 'Tor Books']);
    });

    it('orders metaDots as duration · year · publisher when no series is present', () => {
      const book = createMockBook({
        seriesName: null,
        seriesPosition: null,
        duration: 1708,
        publishedDate: '2007-06-12',
      });
      const result = mergeBookData(book, { publisher: 'Little, Brown & Company' });
      expect(result.metaDots).toEqual(['28h 28m', '2007', 'Little, Brown & Company']);
    });
  });

  // #1097 — metadata fallback prefers seriesPrimary over series[0]
  describe('canonical primary-series preference (#1097)', () => {
    it('prefers metadataBook.seriesPrimary over metadataBook.series[0] when library has no series', () => {
      const book = createMockBook({ seriesName: null, seriesPosition: null });
      const result = mergeBookData(book, {
        seriesPrimary: { name: 'The Stormlight Archive', position: 2 },
        series: [
          { name: 'Cosmere', position: 5 },
          { name: 'The Stormlight Archive', position: 2 },
        ],
      });
      expect(result.metaDots).toContain('The Stormlight Archive #2');
      expect(result.metaDots.some((d) => /Cosmere/.test(d))).toBe(false);
    });

    it('falls back to metadataBook.series[0] when seriesPrimary is absent', () => {
      const book = createMockBook({ seriesName: null, seriesPosition: null });
      const result = mergeBookData(book, {
        series: [{ name: 'Discworld', position: 9 }],
      });
      expect(result.metaDots).toContain('Discworld #9');
    });
  });
});
