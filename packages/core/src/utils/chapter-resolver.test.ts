import { describe, it, expect, vi } from 'vitest';
import {
  sortChapterSources,
  resolveChapterTitle,
  parseFilenameForTitle,
  readChapterSources,
  type ChapterSource,
} from './chapter-resolver.js';

vi.mock('music-metadata', () => ({
  parseFile: vi.fn(),
}));

import { parseFile } from 'music-metadata';

const mockParseFile = vi.mocked(parseFile);

describe('chapter-resolver', () => {
  describe('readChapterSources', () => {
    it('extracts title from ID3 metadata', async () => {
      mockParseFile.mockResolvedValueOnce({
        common: { title: 'The Beginning', track: { no: 1, of: null }, disk: { no: 1, of: null } },
        format: {},
        native: {},
        quality: { warnings: [] },
      } as never);

      const sources = await readChapterSources(['/audio/01.mp3']);
      expect(sources[0].title).toBe('The Beginning');
      expect(sources[0].trackNumber).toBe(1);
      expect(sources[0].discNumber).toBe(1);
    });

    it('handles files with no metadata gracefully', async () => {
      mockParseFile.mockRejectedValueOnce(new Error('No metadata'));

      const sources = await readChapterSources(['/audio/01.mp3']);
      expect(sources[0].title).toBeUndefined();
      expect(sources[0].trackNumber).toBeUndefined();
    });

    it('sorts by disc number then track number from ID3 tags', async () => {
      mockParseFile
        .mockResolvedValueOnce({
          common: { title: 'Ch 3', track: { no: 1, of: null }, disk: { no: 2, of: null } },
          format: {}, native: {}, quality: { warnings: [] },
        } as never)
        .mockResolvedValueOnce({
          common: { title: 'Ch 1', track: { no: 1, of: null }, disk: { no: 1, of: null } },
          format: {}, native: {}, quality: { warnings: [] },
        } as never)
        .mockResolvedValueOnce({
          common: { title: 'Ch 2', track: { no: 2, of: null }, disk: { no: 1, of: null } },
          format: {}, native: {}, quality: { warnings: [] },
        } as never);

      const sources = await readChapterSources(['/a/d2-01.mp3', '/a/d1-01.mp3', '/a/d1-02.mp3']);
      expect(sources.map(s => s.title)).toEqual(['Ch 1', 'Ch 2', 'Ch 3']);
    });

    it('falls back to alpha sort when ID3 track numbers missing', async () => {
      mockParseFile
        .mockResolvedValueOnce({
          common: { title: 'Beta' }, format: {}, native: {}, quality: { warnings: [] },
        } as never)
        .mockResolvedValueOnce({
          common: { title: 'Alpha' }, format: {}, native: {}, quality: { warnings: [] },
        } as never);

      const sources = await readChapterSources(['/a/02-beta.mp3', '/a/01-alpha.mp3']);
      expect(sources.map(s => s.title)).toEqual(['Alpha', 'Beta']);
    });
  });

  describe('sortChapterSources', () => {
    it('sorts by disc then track number', () => {
      const sources: ChapterSource[] = [
        { filePath: '/a/03.mp3', trackNumber: 1, discNumber: 2 },
        { filePath: '/a/01.mp3', trackNumber: 1, discNumber: 1 },
        { filePath: '/a/02.mp3', trackNumber: 2, discNumber: 1 },
      ];
      const sorted = sortChapterSources(sources);
      expect(sorted.map(s => s.filePath)).toEqual(['/a/01.mp3', '/a/02.mp3', '/a/03.mp3']);
    });

    it('falls back to alpha sort without track numbers', () => {
      const sources: ChapterSource[] = [
        { filePath: '/a/chapter_02.mp3' },
        { filePath: '/a/chapter_01.mp3' },
      ];
      const sorted = sortChapterSources(sources);
      expect(sorted.map(s => s.filePath)).toEqual(['/a/chapter_01.mp3', '/a/chapter_02.mp3']);
    });
  });

  describe('resolveChapterTitle', () => {
    it('uses ID3 title when available', () => {
      const source: ChapterSource = { filePath: '/a/01.mp3', title: 'The Dark Forest' };
      expect(resolveChapterTitle(source, 0)).toBe('The Dark Forest');
    });

    it('parses "Chapter 01 - Title.mp3" to "Title"', () => {
      const source: ChapterSource = { filePath: '/a/Chapter 01 - The Beginning.mp3' };
      expect(resolveChapterTitle(source, 0)).toBe('The Beginning');
    });

    it('parses "01 Title.mp3" to "Title"', () => {
      const source: ChapterSource = { filePath: '/a/01 Prologue.mp3' };
      expect(resolveChapterTitle(source, 0)).toBe('Prologue');
    });

    it('parses "01.mp3" to "Chapter 1" (fallback)', () => {
      const source: ChapterSource = { filePath: '/a/01.mp3' };
      expect(resolveChapterTitle(source, 0)).toBe('Chapter 1');
    });

    it('handles mixed sources — some ID3, some filename', () => {
      const withId3: ChapterSource = { filePath: '/a/01.mp3', title: 'From ID3' };
      const withFilename: ChapterSource = { filePath: '/a/02 - From Filename.mp3' };
      const withNeither: ChapterSource = { filePath: '/a/03.mp3' };

      expect(resolveChapterTitle(withId3, 0)).toBe('From ID3');
      expect(resolveChapterTitle(withFilename, 1)).toBe('From Filename');
      expect(resolveChapterTitle(withNeither, 2)).toBe('Chapter 3');
    });
  });

  describe('parseFilenameForTitle', () => {
    it('parses "Chapter 01 - Title.mp3"', () => {
      expect(parseFilenameForTitle('/a/Chapter 01 - The Beginning.mp3')).toBe('The Beginning');
    });

    it('parses "01 Title.mp3"', () => {
      expect(parseFilenameForTitle('/a/01 Prologue.mp3')).toBe('Prologue');
    });

    it('parses "01 - Title.mp3"', () => {
      expect(parseFilenameForTitle('/a/01 - Opening.mp3')).toBe('Opening');
    });

    it('returns null for "01.mp3" (just a number)', () => {
      expect(parseFilenameForTitle('/a/01.mp3')).toBeNull();
    });

    it('parses "Part 1/01 - Title.mp3" (disc subfolder)', () => {
      expect(parseFilenameForTitle('/audiobooks/Part 1/01 - The Start.mp3')).toBe('The Start');
    });

    it('strips Part prefix from filename', () => {
      expect(parseFilenameForTitle('/a/Part 1 - Introduction.mp3')).toBe('Introduction');
    });
  });
});
