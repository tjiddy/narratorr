import { describe, it, expect } from 'vitest';
import { groupBooksBySeries } from './helpers.js';
import type { BookMetadata } from '@/lib/api';

function book(overrides: Partial<BookMetadata> & { title: string }): BookMetadata {
  const { title, ...rest } = overrides;
  return { title, authors: [{ name: 'Author' }], ...rest };
}

describe('groupBooksBySeries', () => {
  describe('standalone sorting', () => {
    it('sorts standalone books by publishedDate descending (newest first)', () => {
      const books = [
        book({ title: 'Old', publishedDate: '2020-01-01' }),
        book({ title: 'New', publishedDate: '2024-06-15' }),
        book({ title: 'Mid', publishedDate: '2022-03-10' }),
      ];

      const { standalone } = groupBooksBySeries(books);
      expect(standalone.map((b) => b.title)).toEqual(['New', 'Mid', 'Old']);
    });

    it('sorts books with missing publishedDate to end', () => {
      const books = [
        book({ title: 'No Date' }),
        book({ title: 'Dated', publishedDate: '2023-01-01' }),
      ];

      const { standalone } = groupBooksBySeries(books);
      expect(standalone.map((b) => b.title)).toEqual(['Dated', 'No Date']);
    });

    it('sorts books with undefined publishedDate to end', () => {
      const books = [
        book({ title: 'Undef', publishedDate: undefined }),
        book({ title: 'Early', publishedDate: '2021-05-01' }),
        book({ title: 'Late', publishedDate: '2023-11-01' }),
      ];

      const { standalone } = groupBooksBySeries(books);
      expect(standalone.map((b) => b.title)).toEqual(['Late', 'Early', 'Undef']);
    });

    it('sorts same-year standalone books by full date (not just year)', () => {
      const books = [
        book({ title: 'March', publishedDate: '2024-03-15' }),
        book({ title: 'November', publishedDate: '2024-11-01' }),
        book({ title: 'January', publishedDate: '2024-01-10' }),
      ];

      const { standalone } = groupBooksBySeries(books);
      expect(standalone.map((b) => b.title)).toEqual(['November', 'March', 'January']);
    });

    it('handles all standalone books (no series) — sorted by date', () => {
      const books = [
        book({ title: 'C', publishedDate: '2020-01-01' }),
        book({ title: 'A', publishedDate: '2024-01-01' }),
        book({ title: 'B', publishedDate: '2022-01-01' }),
      ];

      const { series, standalone } = groupBooksBySeries(books);
      expect(series).toEqual([]);
      expect(standalone.map((b) => b.title)).toEqual(['A', 'B', 'C']);
    });
  });

  describe('existing behavior preserved', () => {
    it('groups series books by series name', () => {
      const books = [
        book({ title: 'Book 1', series: [{ name: 'Mistborn', position: 1 }] }),
        book({ title: 'Book 2', series: [{ name: 'Mistborn', position: 2 }] }),
        book({ title: 'Standalone' }),
      ];

      const { series, standalone } = groupBooksBySeries(books);
      expect(series).toHaveLength(1);
      expect(series[0]!.name).toBe('Mistborn');
      expect(series[0]!.books).toHaveLength(2);
      expect(standalone).toHaveLength(1);
    });

    it('sorts series books by position within group', () => {
      const books = [
        book({ title: 'Third', series: [{ name: 'SA', position: 3 }] }),
        book({ title: 'First', series: [{ name: 'SA', position: 1 }] }),
        book({ title: 'Second', series: [{ name: 'SA', position: 2 }] }),
      ];

      const { series } = groupBooksBySeries(books);
      expect(series[0]!.books.map((b) => b.title)).toEqual(['First', 'Second', 'Third']);
    });

    it('returns empty series and standalone for empty input', () => {
      const { series, standalone } = groupBooksBySeries([]);
      expect(series).toEqual([]);
      expect(standalone).toEqual([]);
    });
  });
});
