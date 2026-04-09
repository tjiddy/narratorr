import { describe, it, expect } from 'vitest';
import {
  parseFolderStructure,
  parseFolderStructureRaw,
  cleanName,
  cleanNameWithTrace,
  extractYear,
  extractASIN,
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

  describe('parseFolderStructureRaw', () => {
    it('returns Unknown for empty parts', () => {
      expect(parseFolderStructureRaw([])).toEqual({ title: 'Unknown', author: null, series: null });
    });

    it('returns raw "Author - Title" from regex capture groups', () => {
      const result = parseFolderStructureRaw(['Andy Weir - Project Hail Mary']);
      // Dash regex: /^(.+?)\s*-\s*(.+)$/ — group 2 captures everything after "- "
      expect(result.author).toBe('Andy Weir');
      expect(result.title).toBe('Project Hail Mary');
    });

    it('returns raw "Title (Author)" without cleaning', () => {
      const result = parseFolderStructureRaw(['Dune (Frank Herbert)']);
      expect(result.title).toBe('Dune');
      expect(result.author).toBe('Frank Herbert');
    });

    it('returns raw "Title [Author]" without cleaning', () => {
      const result = parseFolderStructureRaw(['Dune [Frank Herbert]']);
      expect(result.title).toBe('Dune');
      expect(result.author).toBe('Frank Herbert');
    });

    it('returns raw "Title by Author" without cleaning', () => {
      const result = parseFolderStructureRaw(['Project Hail Mary by Andy Weir']);
      // parseSingleFolderRaw trims the by-match groups (same as cleaned parser guard logic)
      expect(result.title).toBe('Project Hail Mary');
      expect(result.author).toBe('Andy Weir');
    });

    it('returns raw title with no author when no pattern matches', () => {
      const result = parseFolderStructureRaw(['JustATitle MP3']);
      expect(result.title).toBe('JustATitle MP3');
      expect(result.author).toBeNull();
    });

    it('skips dash pattern when left is numeric (same as cleaned parser)', () => {
      const result = parseFolderStructureRaw(['01 - The Way of Kings']);
      // Numeric left skips dash match, falls through to "just a title"
      expect(result.title).toBe('01 - The Way of Kings');
      expect(result.author).toBeNull();
    });

    it('returns raw Series–NN–Title for single segment', () => {
      const result = parseFolderStructureRaw(['Stormlight Archive - 1 - The Way of Kings']);
      expect(result.series).toBe('Stormlight Archive');
      expect(result.title).toBe('The Way of Kings');
      expect(result.author).toBeNull();
    });

    it('returns raw 2-part Author/Title without cleaning', () => {
      const result = parseFolderStructureRaw(['Author Name', 'Title MP3']);
      expect(result.author).toBe('Author Name');
      expect(result.title).toBe('Title MP3');
      expect(result.series).toBeNull();
    });

    it('returns raw 2-part with Series–NN–Title in second segment', () => {
      const result = parseFolderStructureRaw(['Author', 'Series - 1 - Title']);
      expect(result.author).toBe('Author');
      expect(result.title).toBe('Title');
      expect(result.series).toBe('Series');
    });

    it('returns raw 3-part segments without cleaning', () => {
      const result = parseFolderStructureRaw(['Author MP3', 'Series (2020)', 'Title [GA]']);
      expect(result.author).toBe('Author MP3');
      expect(result.series).toBe('Series (2020)');
      expect(result.title).toBe('Title [GA]');
    });

    it('returns raw 4+ part segments using first/second-to-last/last', () => {
      const result = parseFolderStructureRaw(['Author', 'SubDir', 'Series', 'Title MP3']);
      expect(result.author).toBe('Author');
      expect(result.series).toBe('Series');
      expect(result.title).toBe('Title MP3');
    });

    it('stays branch-aligned with cleaned parser for all patterns', () => {
      const cases: string[][] = [
        [],
        ['Author - Title'],
        ['Title (Author)'],
        ['Title [Author]'],
        ['Title by Author'],
        ['Series - 1 - Title'],
        ['JustATitle'],
        ['01 - Title'],
        ['Author', 'Title'],
        ['Author', 'Series - 1 - Title'],
        ['Author', 'Series', 'Title'],
        ['A', 'B', 'C', 'D'],
      ];
      for (const parts of cases) {
        const raw = parseFolderStructureRaw(parts);
        const cleaned = parseFolderStructure(parts);
        // Raw and cleaned must agree on which fields are null vs non-null
        expect(raw.title !== null).toBe(cleaned.title !== null);
        expect((raw.author !== null)).toBe((cleaned.author !== null));
        expect((raw.series !== null)).toBe((cleaned.series !== null));
      }
    });
  });

  describe('ASIN detection (issue #454)', () => {
    describe('extractASIN helper', () => {
      it('extracts ASIN and returns cleaned string', () => {
        const result = extractASIN('Title [B0D18DYG5C]');
        expect(result).toEqual({ asin: 'B0D18DYG5C', cleaned: 'Title' });
      });

      it('normalizes lowercase ASIN to uppercase', () => {
        const result = extractASIN('Title [b0d18dyg5c]');
        expect(result).toEqual({ asin: 'B0D18DYG5C', cleaned: 'Title' });
      });

      it('returns undefined asin when no match', () => {
        const result = extractASIN('Title [Author Name]');
        expect(result).toEqual({ asin: undefined, cleaned: 'Title [Author Name]' });
      });
    });

    describe('positive cases', () => {
      it('detects ASIN in "Title [B0D18DYG5C]" and does not treat as author', () => {
        const result = parseFolderStructure(['Title [B0D18DYG5C]']);
        expect(result.title).toBe('Title');
        expect(result.author).toBeNull();
        expect(result.asin).toBe('B0D18DYG5C');
      });

      it('detects ASIN with mixed alpha/numeric chars', () => {
        const result = parseFolderStructure(['Title [B0ABCDEF12]']);
        expect(result.asin).toBe('B0ABCDEF12');
        expect(result.title).toBe('Title');
      });

      it('normalizes lowercase ASIN to uppercase', () => {
        const result = parseFolderStructure(['Title [b0d18dyg5c]']);
        expect(result.asin).toBe('B0D18DYG5C');
      });

      it('extracts ASIN in 1-part path via parseFolderStructure', () => {
        const result = parseFolderStructure(['Title [B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('Title');
        expect(result.author).toBeNull();
      });

      it('extracts ASIN in 2-part path (exercises 2-part branch)', () => {
        const result = parseFolderStructure(['Author', 'Title [B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('Title');
        expect(result.author).toBe('Author');
      });

      it('extracts ASIN in 3+-part path', () => {
        const result = parseFolderStructure(['Author', 'Series', 'Title [B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('Title');
        expect(result.author).toBe('Author');
        expect(result.series).toBe('Series');
      });

      it('parseFolderStructureRaw returns ASIN in raw output with ASIN-stripped title', () => {
        const result = parseFolderStructureRaw(['Title MP3 [B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        // Raw title is ASIN-stripped but NOT cleaned (MP3 remains)
        expect(result.title).toBe('Title MP3');
      });
    });

    describe('negative cases (no false positives)', () => {
      it('does not match [Author Name] — author parsed normally', () => {
        const result = parseFolderStructure(['Dune [Frank Herbert]']);
        expect(result.asin).toBeUndefined();
        expect(result.author).toBe('Frank Herbert');
        expect(result.title).toBe('Dune');
      });

      it('does not match [2017] — year parsed normally', () => {
        const result = parseFolderStructure(['Title [2017]']);
        expect(result.asin).toBeUndefined();
      });

      it('does not match [B0SHORT] — too few chars after B0', () => {
        const result = parseFolderStructure(['Title [B0SHORT]']);
        expect(result.asin).toBeUndefined();
      });

      it('does not match [NOTASIN1234] — does not start with B0', () => {
        const result = parseFolderStructure(['Title [NOTASIN1234]']);
        expect(result.asin).toBeUndefined();
      });

      it('does not match [B0TOOLONG123] — too many chars after B0', () => {
        const result = parseFolderStructure(['Title [B0TOOLONG123]']);
        expect(result.asin).toBeUndefined();
      });
    });

    describe('boundary values and edge cases', () => {
      it('folder name is ONLY the ASIN bracket — title falls back to original input', () => {
        const result = parseFolderStructure(['[B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        // When stripped result is empty, should fall back
        expect(result.title).toBe('[B0D18DYG5C]');
      });

      it('ASIN in middle position — extracts ASIN, parses remainder', () => {
        const result = parseFolderStructure(['Title [B0D18DYG5C] Extra']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('Title Extra');
      });

      it('ASIN stripped before author-title split', () => {
        const result = parseFolderStructure(['Author - Title [B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('Title');
        expect(result.author).toBe('Author');
      });

      it('multiple ASIN-like brackets — only first match extracted', () => {
        const result = parseFolderStructure(['Title [B0AAAAAAAA] [B0BBBBBBBB]']);
        expect(result.asin).toBe('B0AAAAAAAA');
      });

      it('ASIN-only segment in 2-part path — title falls back to original segment', () => {
        const result = parseFolderStructure(['Author', '[B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('[B0D18DYG5C]');
        expect(result.author).toBe('Author');
      });

      it('ASIN-only segment in 3+-part path — title falls back to original segment', () => {
        const result = parseFolderStructure(['Author', 'Series', '[B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('[B0D18DYG5C]');
        expect(result.author).toBe('Author');
        expect(result.series).toBe('Series');
      });

      it('ASIN-only segment in 2-part raw path — title falls back to original', () => {
        const result = parseFolderStructureRaw(['Author', '[B0D18DYG5C]']);
        expect(result.asin).toBe('B0D18DYG5C');
        expect(result.title).toBe('[B0D18DYG5C]');
      });

      it('extractYear not affected by ASIN brackets', () => {
        expect(extractYear('Title [B0D18DYG5C]')).toBeUndefined();
      });
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
