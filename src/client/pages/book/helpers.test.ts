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
      const result = mergeBookData(book, { duration: undefined });
      expect(result.metaDots.some((d: string) => /\d+[hm]/.test(d))).toBe(false);
    });
  });
});
