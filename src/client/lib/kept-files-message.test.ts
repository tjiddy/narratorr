import { describe, it, expect } from 'vitest';
import { describeKeptFiles } from './kept-files-message.js';

describe('describeKeptFiles (#1589)', () => {
  it('returns an empty string when nothing was preserved', () => {
    expect(describeKeptFiles([])).toBe('');
    expect(describeKeptFiles(undefined)).toBe('');
  });

  it('uses the singular noun for a single preserved file', () => {
    expect(describeKeptFiles(['book.epub'])).toBe('kept 1 non-audio file (book.epub)');
  });

  it('lists up to three names with the plural noun', () => {
    expect(describeKeptFiles(['book.epub', 'notes.pdf', 'cover.txt'])).toBe(
      'kept 3 non-audio files (book.epub, notes.pdf, cover.txt)',
    );
  });

  it('truncates the name list and reports the overflow count', () => {
    expect(describeKeptFiles(['a.epub', 'b.pdf', 'c.txt', 'd.srt', 'e.nfo'])).toBe(
      'kept 5 non-audio files (a.epub, b.pdf, c.txt, +2 more)',
    );
  });
});
