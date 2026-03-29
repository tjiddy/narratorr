import { describe, it, expect } from 'vitest';
import { sanitizePath, renderTemplate, renderFilename, parseTemplate, toLastFirst, toSortTitle, ALLOWED_TOKENS, FOLDER_ALLOWED_TOKENS, FILE_ALLOWED_TOKENS } from './naming.js';

describe('sanitizePath', () => {
  it('removes illegal filesystem characters', () => {
    expect(sanitizePath('Hello: World?')).toBe('Hello World');
    expect(sanitizePath('A<B>C')).toBe('ABC');
    expect(sanitizePath('path/with\\slashes')).toBe('pathwithslashes');
    expect(sanitizePath('file*name|test')).toBe('filenametest');
  });

  it('removes trailing dots', () => {
    expect(sanitizePath('test...')).toBe('test');
    expect(sanitizePath('name.')).toBe('name');
  });

  it('trims whitespace', () => {
    expect(sanitizePath('  hello  ')).toBe('hello');
  });

  it('returns Unknown for empty string after sanitization', () => {
    expect(sanitizePath('???')).toBe('Unknown');
    expect(sanitizePath('')).toBe('Unknown');
    expect(sanitizePath('   ')).toBe('Unknown');
  });

  it('collapses consecutive spaces', () => {
    expect(sanitizePath('Author  Name')).toBe('Author Name');
    expect(sanitizePath('Too   Many    Spaces')).toBe('Too Many Spaces');
  });

  it('collapses spaces left by stripped characters', () => {
    // Colon removal leaves double space: "Author: Name" → "Author  Name" → "Author Name"
    expect(sanitizePath('Author: Name')).toBe('Author Name');
  });

  it('preserves normal characters', () => {
    expect(sanitizePath('Brandon Sanderson')).toBe('Brandon Sanderson');
    expect(sanitizePath("The Hitchhiker's Guide")).toBe("The Hitchhiker's Guide");
  });

  it('truncates to 255 characters', () => {
    const long = 'A'.repeat(300);
    expect(sanitizePath(long).length).toBe(255);
  });
});

describe('renderTemplate', () => {
  const sampleTokens = {
    author: 'Brandon Sanderson',
    title: 'The Way of Kings',
    series: 'The Stormlight Archive',
    seriesPosition: 1,
    year: '2010',
    narrator: 'Michael Kramer, Kate Reading',
  };

  it('replaces simple tokens', () => {
    expect(renderTemplate('{author}/{title}', sampleTokens))
      .toBe('Brandon Sanderson/The Way of Kings');
  });

  it('replaces all 6 tokens', () => {
    const result = renderTemplate('{author}/{series}/{title} ({year}) [{narrator}]', sampleTokens);
    expect(result).toBe('Brandon Sanderson/The Stormlight Archive/The Way of Kings (2010) [Michael Kramer, Kate Reading]');
  });

  it('handles missing tokens by producing empty string', () => {
    const result = renderTemplate('{author}/{title}', { author: 'Author', title: 'Book', series: undefined });
    expect(result).toBe('Author/Book');
  });

  it('filters out empty path segments from missing tokens', () => {
    const result = renderTemplate('{author}/{series}/{title}', { author: 'Author', title: 'Book' });
    // series is undefined, so that segment should be gone
    expect(result).toBe('Author/Book');
  });

  describe('conditional blocks', () => {
    it('renders conditional text when token has value', () => {
      const result = renderTemplate('{author}/{series? - }{title}', sampleTokens);
      expect(result).toBe('Brandon Sanderson/The Stormlight Archive - The Way of Kings');
    });

    it('omits conditional text when token is missing', () => {
      const result = renderTemplate('{author}/{series? - }{title}', { author: 'Author', title: 'Book' });
      expect(result).toBe('Author/Book');
    });

    it('handles multiple conditionals', () => {
      const result = renderTemplate('{author}/{series? - }{year? - }{title}', {
        author: 'Author',
        title: 'Book',
        series: 'My Series',
      });
      // series present → "My Series - ", year missing → "", title → "Book"
      expect(result).toBe('Author/My Series - Book');
    });
  });

  describe('format specifiers', () => {
    it('zero-pads seriesPosition with :00', () => {
      const result = renderTemplate('{author}/{title} {seriesPosition:00}', {
        author: 'Author',
        title: 'Book',
        seriesPosition: 1,
      });
      expect(result).toBe('Author/Book 01');
    });

    it('zero-pads with :000', () => {
      const result = renderTemplate('{seriesPosition:000}', { title: 'X', seriesPosition: 5 });
      expect(result).toBe('005');
    });

    it('does not pad non-numeric values', () => {
      const result = renderTemplate('{title:00}', { title: 'Book' });
      expect(result).toBe('Book');
    });

    it('applies zero-padding with conditional suffix {seriesPosition:00? - }', () => {
      const result = renderTemplate('{seriesPosition:00? - }{title}', {
        title: 'Book',
        seriesPosition: 3,
      });
      expect(result).toBe('03 - Book');
    });

    it('omits both pad and conditional when token is missing', () => {
      const result = renderTemplate('{seriesPosition:00? - }{title}', {
        title: 'Book',
      });
      expect(result).toBe('Book');
    });
  });

  describe('sanitization', () => {
    it('sanitizes illegal characters in token values', () => {
      const result = renderTemplate('{author}/{title}', {
        author: 'Author: Name',
        title: 'Book? Title',
      });
      expect(result).toBe('Author Name/Book Title');
    });

    it('handles tokens producing empty values gracefully', () => {
      const result = renderTemplate('{author}/{title}', { author: '', title: 'Book' });
      expect(result).toBe('Book');
    });
  });

  describe('edge cases', () => {
    it('handles template with no tokens', () => {
      const result = renderTemplate('static/path', {});
      expect(result).toBe('static/path');
    });

    it('handles double slashes from missing values', () => {
      const result = renderTemplate('{author}//{title}', { author: '', title: 'Book' });
      expect(result).not.toContain('//');
    });
  });
});

describe('parseTemplate', () => {
  it('extracts token names', () => {
    const result = parseTemplate('{author}/{title}');
    expect(result.tokens).toContain('author');
    expect(result.tokens).toContain('title');
    expect(result.errors).toEqual([]);
  });

  it('errors on missing {title}', () => {
    const result = parseTemplate('{author}/{series}');
    expect(result.errors).toContain('Template must include {title} or {titleSort}');
  });

  it('warns on missing {author}', () => {
    const result = parseTemplate('{title}');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/author/i);
  });

  it('errors on unknown tokens', () => {
    const result = parseTemplate('{title}/{unknown}');
    expect(result.errors).toContain('Unknown token: {unknown}');
  });

  it('handles conditional tokens', () => {
    const result = parseTemplate('{author}/{series? - }{title}');
    expect(result.tokens).toContain('series');
    expect(result.errors).toEqual([]);
  });

  it('handles format specifiers', () => {
    const result = parseTemplate('{author}/{title} {seriesPosition:00}');
    expect(result.tokens).toContain('seriesPosition');
    expect(result.errors).toEqual([]);
  });

  it('does not duplicate tokens', () => {
    const result = parseTemplate('{author}/{author}/{title}');
    expect(result.tokens.filter((t) => t === 'author').length).toBe(1);
  });

  it('recognizes all allowed tokens', () => {
    const template = ALLOWED_TOKENS.map((t) => `{${t}}`).join('/');
    const result = parseTemplate(template);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.tokens.sort()).toEqual([...ALLOWED_TOKENS].sort());
  });

  it('accepts {titleSort} as valid title token', () => {
    const result = parseTemplate('{author}/{titleSort}');
    expect(result.errors).toEqual([]);
  });

  it('accepts {authorLastFirst} as valid author token', () => {
    const result = parseTemplate('{authorLastFirst}/{title}');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('accepts file-specific tokens when FILE_ALLOWED_TOKENS is passed', () => {
    const result = parseTemplate('{author} - {title} {trackNumber:00}', FILE_ALLOWED_TOKENS);
    expect(result.errors).toEqual([]);
  });

  it('rejects file-specific tokens with default (folder) token list', () => {
    const result = parseTemplate('{author}/{title} {trackNumber}');
    expect(result.errors).toContain('Unknown token: {trackNumber}');
  });
});

describe('renderFilename', () => {
  it('replaces tokens and sanitizes as a single filename', () => {
    const result = renderFilename('{author} - {title}', {
      author: 'Brandon Sanderson',
      title: 'The Way of Kings',
    });
    expect(result).toBe('Brandon Sanderson - The Way of Kings');
  });

  it('does not split on slashes (treats as single segment)', () => {
    const result = renderFilename('{author}/{title}', {
      author: 'Author',
      title: 'Book',
    });
    // Slashes are illegal chars and get stripped
    expect(result).not.toContain('/');
  });

  it('supports conditional blocks', () => {
    const result = renderFilename('{trackNumber? - Part }{title}', {
      trackNumber: 3,
      title: 'The Way of Kings',
    });
    expect(result).toBe('3 - Part The Way of Kings');
  });

  it('omits conditional when token is missing', () => {
    const result = renderFilename('{trackNumber? - Part }{title}', {
      title: 'The Way of Kings',
    });
    expect(result).toBe('The Way of Kings');
  });

  it('supports zero-padding format specifiers', () => {
    const result = renderFilename('{trackNumber:00} - {title}', {
      trackNumber: 1,
      title: 'Chapter One',
    });
    expect(result).toBe('01 - Chapter One');
  });

  it('applies zero-padding with conditional suffix {seriesPosition:00? - }', () => {
    const result = renderFilename('{author} - {seriesPosition:00? - }{title}', {
      author: 'Author',
      seriesPosition: 3,
      title: 'Book',
    });
    expect(result).toBe('Author - 03 - Book');
  });

  it('omits both pad and conditional when token is missing in filename', () => {
    const result = renderFilename('{author} - {seriesPosition:00? - }{title}', {
      author: 'Author',
      title: 'Book',
    });
    expect(result).toBe('Author - Book');
  });

  it('handles missing tokens gracefully', () => {
    const result = renderFilename('{author} - {title}', {
      title: 'Book',
    });
    expect(result).toBe('- Book');
  });

  it('sanitizes illegal filename characters', () => {
    const result = renderFilename('{title}', { title: 'Book: Subtitle?' });
    expect(result).toBe('Book Subtitle');
  });

  it('returns Unknown for empty result', () => {
    const result = renderFilename('{author}', { author: '' });
    expect(result).toBe('Unknown');
  });
});

describe('FOLDER_ALLOWED_TOKENS / FILE_ALLOWED_TOKENS', () => {
  it('FOLDER_ALLOWED_TOKENS matches ALLOWED_TOKENS', () => {
    expect([...FOLDER_ALLOWED_TOKENS]).toEqual([...ALLOWED_TOKENS]);
  });

  it('FILE_ALLOWED_TOKENS includes folder tokens plus file-specific tokens', () => {
    for (const token of FOLDER_ALLOWED_TOKENS) {
      expect(FILE_ALLOWED_TOKENS).toContain(token);
    }
    expect(FILE_ALLOWED_TOKENS).toContain('trackNumber');
    expect(FILE_ALLOWED_TOKENS).toContain('trackTotal');
    expect(FILE_ALLOWED_TOKENS).toContain('partName');
  });
});

describe('toLastFirst', () => {
  it('flips "First Last" to "Last, First"', () => {
    expect(toLastFirst('Brandon Sanderson')).toBe('Sanderson, Brandon');
  });

  it('handles single name (no flip)', () => {
    expect(toLastFirst('Madonna')).toBe('Madonna');
  });

  it('handles multiple first names', () => {
    expect(toLastFirst('J. R. R. Tolkien')).toBe('Tolkien, J. R. R.');
  });

  it('passes through already "Last, First" format', () => {
    expect(toLastFirst('Sanderson, Brandon')).toBe('Sanderson, Brandon');
  });

  it('flips multiple authors separated by &', () => {
    expect(toLastFirst('Brandon Sanderson & Robert Jordan')).toBe('Sanderson, Brandon & Jordan, Robert');
  });

  it('flips multiple authors separated by "and"', () => {
    expect(toLastFirst('Brandon Sanderson and Robert Jordan')).toBe('Sanderson, Brandon & Jordan, Robert');
  });

  it('handles empty string', () => {
    expect(toLastFirst('')).toBe('');
  });

  it('handles whitespace-only string', () => {
    expect(toLastFirst('   ')).toBe('   ');
  });

  it('handles multiple narrators with commas (comma-separated list)', () => {
    // "Michael Kramer, Kate Reading" — commas indicate separate people
    expect(toLastFirst('Michael Kramer, Kate Reading')).toBe('Kramer, Michael & Reading, Kate');
  });
});

describe('toSortTitle', () => {
  it('strips leading "The"', () => {
    expect(toSortTitle('The Way of Kings')).toBe('Way of Kings');
  });

  it('strips leading "A"', () => {
    expect(toSortTitle('A Game of Thrones')).toBe('Game of Thrones');
  });

  it('strips leading "An"', () => {
    expect(toSortTitle('An Echo of Things to Come')).toBe('Echo of Things to Come');
  });

  it('is case-insensitive', () => {
    expect(toSortTitle('the way of kings')).toBe('way of kings');
  });

  it('does not strip articles mid-title', () => {
    expect(toSortTitle('Into the Wild')).toBe('Into the Wild');
  });

  it('returns original if stripping would leave empty', () => {
    expect(toSortTitle('The')).toBe('The');
  });

  it('passes through titles without leading articles', () => {
    expect(toSortTitle('Mistborn')).toBe('Mistborn');
  });
});

describe('renderTemplate with separator/case options', () => {
  describe('separator transforms', () => {
    it.todo('space separator leaves token values unchanged');
    it.todo('period separator replaces spaces within token values with periods');
    it.todo('underscore separator replaces spaces within token values with underscores');
    it.todo('dash separator replaces spaces within token values with dashes');
    it.todo('does not transform literal template text like " - " or "/"');
    it.todo('does not affect single-word token values');
    it.todo('does not create double-slash when token is missing with separator');
  });

  describe('case transforms', () => {
    it.todo('default case leaves token values unchanged');
    it.todo('lower case transforms token values to lowercase');
    it.todo('upper case transforms token values to uppercase');
    it.todo('title case capitalizes first letter of each word');
    it.todo('does not transform literal template text');
    it.todo('combined separator and case: period + lowercase');
  });

  describe('boundary values', () => {
    it.todo('empty token value with separator stays empty');
    it.todo('single character token value — separator no effect, case applies');
    it.todo('zero-padded numeric tokens unaffected by separator/case');
    it.todo('long token value truncated at 255 after transforms');
  });

  describe('conditional blocks with transforms', () => {
    it.todo('case transform applies to token value but not conditional suffix text');
    it.todo('separator applies to token value inside conditional block');
  });
});

describe('renderFilename with separator/case options', () => {
  it.todo('space separator leaves token values unchanged');
  it.todo('period separator replaces spaces within token values');
  it.todo('upper case transforms token values to uppercase');
  it.todo('combined separator and case');
  it.todo('does not transform literal text between tokens');
  it.todo('omitting options preserves existing behavior');
});
