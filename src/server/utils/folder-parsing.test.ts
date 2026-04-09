import { describe, it, expect } from 'vitest';
import {
  parseFolderStructure,
  cleanName,
  cleanNameWithTrace,
  extractYear,
  normalizeFolderName,
} from './folder-parsing.js';

describe('folder-parsing (extracted from library-scan.service)', () => {
  describe('parseFolderStructure', () => {
    it('returns Unknown title for empty parts array', () => {
      expect(parseFolderStructure([])).toEqual({ title: 'Unknown', author: null, series: null });
    });

    it('delegates single-element array to parseSingleFolder', () => {
      const result = parseFolderStructure(['Author - Title']);
      expect(result).toEqual({ title: 'Title', author: 'Author', series: null });
    });

    it('parses 2-part array as Author/Title', () => {
      const result = parseFolderStructure(['Brandon Sanderson', 'The Way of Kings']);
      expect(result.author).toBe('Brandon Sanderson');
      expect(result.title).toBe('The Way of Kings');
      expect(result.series).toBeNull();
    });

    it('parses 2-part array with Series–NN–Title in second segment', () => {
      const result = parseFolderStructure(['Brandon Sanderson', 'Stormlight Archive - 1 - The Way of Kings']);
      expect(result.author).toBe('Brandon Sanderson');
      expect(result.title).toBe('The Way of Kings');
      expect(result.series).toBe('Stormlight Archive');
    });

    it('parses 3-part array as Author/Series/Title', () => {
      const result = parseFolderStructure(['Brandon Sanderson', 'Stormlight Archive', 'The Way of Kings']);
      expect(result.author).toBe('Brandon Sanderson');
      expect(result.title).toBe('The Way of Kings');
      expect(result.series).toBe('Stormlight Archive');
    });

    it('parses 4+ part array using first, second-to-last, last', () => {
      const result = parseFolderStructure(['Author', 'SubDir', 'Series', 'Title']);
      expect(result.author).toBe('Author');
      expect(result.title).toBe('Title');
      expect(result.series).toBe('Series');
    });
  });

  describe('parseSingleFolder (via parseFolderStructure with 1 part)', () => {
    it('parses "Author - Title" pattern', () => {
      const result = parseFolderStructure(['Andy Weir - Project Hail Mary']);
      expect(result).toEqual({ title: 'Project Hail Mary', author: 'Andy Weir', series: null });
    });

    it('parses "Title (Author)" pattern', () => {
      const result = parseFolderStructure(['Dune (Frank Herbert)']);
      expect(result).toEqual({ title: 'Dune', author: 'Frank Herbert', series: null });
    });

    it('parses "Title [Author]" pattern', () => {
      const result = parseFolderStructure(['Dune [Frank Herbert]']);
      expect(result).toEqual({ title: 'Dune', author: 'Frank Herbert', series: null });
    });

    it('parses "Series – NN – Title" pattern with en-dash', () => {
      const result = parseFolderStructure(['Stormlight Archive – 1 – The Way of Kings']);
      expect(result.series).toBe('Stormlight Archive');
      expect(result.title).toBe('The Way of Kings');
      expect(result.author).toBeNull();
    });

    it('parses "Series - NN - Title" pattern with hyphen', () => {
      const result = parseFolderStructure(['Stormlight Archive - 1 - The Way of Kings']);
      expect(result.series).toBe('Stormlight Archive');
      expect(result.title).toBe('The Way of Kings');
      expect(result.author).toBeNull();
    });

    it('skips dash pattern when left side is just a number', () => {
      const result = parseFolderStructure(['01 - The Way of Kings']);
      expect(result.title).toBe('The Way of Kings');
      expect(result.author).toBeNull();
    });

    it('returns title only when no pattern matches', () => {
      const result = parseFolderStructure(['JustATitle']);
      expect(result).toEqual({ title: 'JustATitle', author: null, series: null });
    });
  });

  describe('cleanName', () => {
    it('strips leading decimal position prefix (6.5 - )', () => {
      expect(cleanName('6.5 - The Way of Kings')).toBe('The Way of Kings');
    });

    it('strips leading integer position prefix (01 - )', () => {
      expect(cleanName('01 - The Way of Kings')).toBe('The Way of Kings');
    });

    it('strips leading integer dot prefix (01. )', () => {
      expect(cleanName('01. The Way of Kings')).toBe('The Way of Kings');
    });

    it('strips series markers (, Book 01)', () => {
      expect(cleanName('The Way of Kings, Book 01')).toBe('The Way of Kings');
    });

    it('normalizes underscores and dots to spaces', () => {
      expect(cleanName('The_Way.of.Kings')).toBe('The Way of Kings');
    });

    it('strips codec tags (MP3, M4B, FLAC)', () => {
      expect(cleanName('Title MP3')).toBe('Title');
    });

    it('strips trailing parenthesized year (2020)', () => {
      expect(cleanName('Title (2020)')).toBe('Title');
    });

    it('strips trailing bracketed year [2019]', () => {
      expect(cleanName('Title [2019]')).toBe('Title');
    });

    it('strips bare trailing year', () => {
      expect(cleanName('Title 2020')).toBe('Title');
    });

    it('removes empty parentheses after codec strip', () => {
      expect(cleanName('Title (MP3)')).toBe('Title');
    });

    it('removes empty brackets after codec strip', () => {
      expect(cleanName('Title [FLAC]')).toBe('Title');
    });

    it('strips trailing narrator parenthetical (1-3 word name)', () => {
      expect(cleanName('Title (Jeff Hays)')).toBe('Title');
    });

    it('does not strip narrator paren if content is codec tag', () => {
      // MP3 is a codec tag — should be handled by normalize step, not narrator step
      const result = cleanName('Title (MP3)');
      expect(result).toBe('Title');
    });

    it('deduplicates repeated title segments across dash', () => {
      expect(cleanName('Title 01 – Title')).toBe('Title');
    });

    it('falls back to original name when normalization strips everything', () => {
      expect(cleanName('MP3')).toBe('MP3');
    });

    it('preserves non-codec bracket tags like [GA]', () => {
      expect(cleanName('Title [GA]')).toBe('Title [GA]');
    });
  });

  describe('cleanNameWithTrace', () => {
    it('returns all 10 steps with before/after values', () => {
      const trace = cleanNameWithTrace('Title');
      expect(trace.steps).toHaveLength(10);
      expect(trace.steps.map(s => s.name)).toEqual([
        'leadingNumeric', 'seriesMarker', 'normalize',
        'yearParenStrip', 'yearBracketStrip', 'yearBareStrip',
        'emptyParenStrip', 'emptyBracketStrip', 'narratorParen', 'dedup',
      ]);
    });

    it('each step reflects the actual transformation applied', () => {
      const trace = cleanNameWithTrace('01 - Title, Book 01');
      // leadingNumeric strips "01 - "
      expect(trace.steps[0].output).toBe('Title, Book 01');
      // seriesMarker strips ", Book 01" (end-of-string match)
      expect(trace.steps[1].output).toBe('Title');
      expect(trace.result).toBe('Title');
    });

    it('steps are in correct pipeline order', () => {
      const trace = cleanNameWithTrace('Title');
      const names = trace.steps.map(s => s.name);
      expect(names.indexOf('leadingNumeric')).toBeLessThan(names.indexOf('seriesMarker'));
      expect(names.indexOf('seriesMarker')).toBeLessThan(names.indexOf('normalize'));
      expect(names.indexOf('normalize')).toBeLessThan(names.indexOf('yearParenStrip'));
      expect(names.indexOf('narratorParen')).toBeLessThan(names.indexOf('dedup'));
    });

    it('no-op steps show same input/output', () => {
      const trace = cleanNameWithTrace('Clean Title');
      // leadingNumeric is a no-op for "Clean Title"
      expect(trace.steps[0].output).toBe('Clean Title');
    });

    it('returns final result matching non-trace cleanName output', () => {
      const inputs = [
        '01 - Title, Book 01 (2020)',
        'The_Way.of.Kings MP3',
        'Title (Jeff Hays)',
        'Title 01 – Title',
        'MP3',
        'Title [GA]',
      ];
      for (const input of inputs) {
        const trace = cleanNameWithTrace(input);
        expect(trace.result).toBe(cleanName(input));
      }
    });
  });

  describe('normalizeFolderName', () => {
    it('replaces underscores with spaces', () => {
      expect(normalizeFolderName('The_Way_of_Kings')).toBe('The Way of Kings');
    });

    it('replaces dots with spaces', () => {
      expect(normalizeFolderName('The.Way.of.Kings')).toBe('The Way of Kings');
    });

    it('strips codec tags', () => {
      expect(normalizeFolderName('Title MP3 Unabridged')).toBe('Title');
    });

    it('collapses whitespace and trims', () => {
      expect(normalizeFolderName('  Title   Extra  ')).toBe('Title Extra');
    });
  });

  describe('extractYear', () => {
    it('extracts parenthesized year (2020)', () => {
      expect(extractYear('Title (2020)')).toBe(2020);
    });

    it('extracts bracketed year [2019]', () => {
      expect(extractYear('Title [2019]')).toBe(2019);
    });

    it('extracts bare trailing year', () => {
      expect(extractYear('Title 2017')).toBe(2017);
    });

    it('returns undefined when no year present', () => {
      expect(extractYear('Title')).toBeUndefined();
    });

    it('rejects years outside 1900-2099 range', () => {
      expect(extractYear('Title 1899')).toBeUndefined();
      expect(extractYear('Title 2100')).toBeUndefined();
    });
  });

  describe('extraction integrity', () => {
    it('parseFolderStructure returns identical results after extraction', () => {
      // Same test cases from library-scan.service.test.ts
      const cases: [string[], { title: string; author: string | null; series: string | null }][] = [
        [['Author', 'Title'], { title: 'Title', author: 'Author', series: null }],
        [['Author', 'Series', 'Title'], { title: 'Title', author: 'Author', series: 'Series' }],
        [['Author - Title'], { title: 'Title', author: 'Author', series: null }],
        [['Title (Author)'], { title: 'Title', author: 'Author', series: null }],
        [[], { title: 'Unknown', author: null, series: null }],
      ];
      for (const [parts, expected] of cases) {
        expect(parseFolderStructure(parts)).toEqual(expected);
      }
    });

    it('cleanName transformation order is preserved', () => {
      // Series markers before dedup
      expect(cleanName('Title, Book 01 – Title')).toBe('Title');
      // Leading numeric before everything
      expect(cleanName('01 - Title')).toBe('Title');
    });

    it('extractYear works identically after extraction', () => {
      expect(extractYear('Title (2020)')).toBe(2020);
      expect(extractYear('Title [2019]')).toBe(2019);
      expect(extractYear('Title 2017')).toBe(2017);
      expect(extractYear('No Year')).toBeUndefined();
    });
  });
});
