import { describe, it, expect } from 'vitest';
import { sanitizePath, renderTemplate, renderFilename, parseTemplate, toLastFirst, toSortTitle, toNamingOptions, ALLOWED_TOKENS, FOLDER_ALLOWED_TOKENS, FILE_ALLOWED_TOKENS } from './naming.js';

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
  const tokens = { author: 'Brandon Sanderson', title: 'The Way of Kings' };

  describe('separator transforms', () => {
    it('space separator leaves token values unchanged', () => {
      expect(renderTemplate('{author}/{title}', tokens, { separator: 'space' }))
        .toBe('Brandon Sanderson/The Way of Kings');
    });

    it('period separator replaces spaces within token values with periods', () => {
      expect(renderTemplate('{author}/{title}', tokens, { separator: 'period' }))
        .toBe('Brandon.Sanderson/The.Way.of.Kings');
    });

    it('underscore separator replaces spaces within token values with underscores', () => {
      expect(renderTemplate('{author}/{title}', tokens, { separator: 'underscore' }))
        .toBe('Brandon_Sanderson/The_Way_of_Kings');
    });

    it('dash separator replaces spaces within token values with dashes', () => {
      expect(renderTemplate('{author}/{title}', tokens, { separator: 'dash' }))
        .toBe('Brandon-Sanderson/The-Way-of-Kings');
    });

    it('does not transform literal template text like " - " or "/"', () => {
      expect(renderTemplate('{author} - {title}', tokens, { separator: 'period' }))
        .toBe('Brandon.Sanderson - The.Way.of.Kings');
    });

    it('does not affect single-word token values', () => {
      expect(renderTemplate('{author}/{title}', { author: 'Sanderson', title: 'Mistborn' }, { separator: 'period' }))
        .toBe('Sanderson/Mistborn');
    });

    it('does not create double-slash when token is missing with separator', () => {
      expect(renderTemplate('{author}/{series}/{title}', { author: 'Author', title: 'Book' }, { separator: 'period' }))
        .toBe('Author/Book');
    });
  });

  describe('case transforms', () => {
    it('default case leaves token values unchanged', () => {
      expect(renderTemplate('{author}/{title}', tokens, { case: 'default' }))
        .toBe('Brandon Sanderson/The Way of Kings');
    });

    it('lower case transforms token values to lowercase', () => {
      expect(renderTemplate('{author}/{title}', tokens, { case: 'lower' }))
        .toBe('brandon sanderson/the way of kings');
    });

    it('upper case transforms token values to uppercase', () => {
      expect(renderTemplate('{author}/{title}', tokens, { case: 'upper' }))
        .toBe('BRANDON SANDERSON/THE WAY OF KINGS');
    });

    it('title case capitalizes first letter of each word', () => {
      expect(renderTemplate('{author}/{title}', { author: 'brandon sanderson', title: 'the way of kings' }, { case: 'title' }))
        .toBe('Brandon Sanderson/The Way Of Kings');
    });

    it('does not transform literal template text', () => {
      expect(renderTemplate('{author} - {title}', tokens, { case: 'upper' }))
        .toBe('BRANDON SANDERSON - THE WAY OF KINGS');
    });

    it('combined separator and case: period + lowercase', () => {
      expect(renderTemplate('{author}/{title}', tokens, { separator: 'period', case: 'lower' }))
        .toBe('brandon.sanderson/the.way.of.kings');
    });
  });

  describe('boundary values', () => {
    it('empty token value with separator stays empty — no stray separators', () => {
      expect(renderTemplate('{author}/{series}/{title}', { author: 'Author', series: '', title: 'Book' }, { separator: 'period' }))
        .toBe('Author/Book');
    });

    it('single character token value — separator no effect, case applies', () => {
      expect(renderTemplate('{author}/{title}', { author: 'A', title: 'B' }, { separator: 'period', case: 'lower' }))
        .toBe('a/b');
    });

    it('zero-padded numeric tokens unaffected by separator/case', () => {
      expect(renderTemplate('{author}/{seriesPosition:00}', { author: 'Author', seriesPosition: 3 }, { separator: 'period', case: 'upper' }))
        .toBe('AUTHOR/03');
    });

    it('long token value truncated at 255 after transforms', () => {
      const longName = 'A B '.repeat(100).trim(); // lots of spaces
      const result = renderTemplate('{author}', { author: longName }, { separator: 'period' });
      expect(result.length).toBeLessThanOrEqual(255);
      expect(result).toContain('.');
    });
  });

  describe('conditional blocks with transforms', () => {
    it('case transform applies to token value but not conditional suffix text', () => {
      // {narrator? read by } — narrator value uppercased, "read by" literal stays
      const result = renderTemplate('{author} - {narrator? read by }{title}',
        { author: 'John Smith', narrator: 'Jane Doe', title: 'My Book' },
        { case: 'upper' });
      expect(result).toBe('JOHN SMITH - JANE DOE read by MY BOOK');
    });

    it('separator applies to token value inside conditional block', () => {
      const result = renderTemplate('{author}/{series? - }{title}',
        { author: 'Brandon Sanderson', series: 'The Stormlight Archive', title: 'Oathbringer' },
        { separator: 'period' });
      expect(result).toBe('Brandon.Sanderson/The.Stormlight.Archive - Oathbringer');
    });
  });
});

describe('toNamingOptions', () => {
  it('converts { namingSeparator, namingCase } to NamingOptions with { separator, case }', () => {
    expect(toNamingOptions({ namingSeparator: 'dash', namingCase: 'lower' }))
      .toEqual({ separator: 'dash', case: 'lower' });
  });

  it('handles all valid NamingSeparator values', () => {
    for (const sep of ['space', 'period', 'underscore', 'dash'] as const) {
      const result = toNamingOptions({ namingSeparator: sep, namingCase: 'default' });
      expect(result.separator).toBe(sep);
    }
  });

  it('handles all valid NamingCase values', () => {
    for (const c of ['default', 'lower', 'upper', 'title'] as const) {
      const result = toNamingOptions({ namingSeparator: 'space', namingCase: c });
      expect(result.case).toBe(c);
    }
  });
});

describe('renderTemplate — comma-space separator edge cases', () => {
  it('collapses comma-space to comma with dash separator — no stray dash after punctuation', () => {
    const result = renderTemplate('{author}', { author: 'Sanderson, Brandon', title: 'Book' }, { separator: 'dash' });
    expect(result).toBe('Sanderson,Brandon');
  });

  it('collapses comma-space to comma with period separator', () => {
    const result = renderTemplate('{author}', { author: 'Sanderson, Brandon', title: 'Book' }, { separator: 'period' });
    expect(result).toBe('Sanderson,Brandon');
  });

  it('collapses comma-space to comma with underscore separator', () => {
    const result = renderTemplate('{author}', { author: 'Sanderson, Brandon', title: 'Book' }, { separator: 'underscore' });
    expect(result).toBe('Sanderson,Brandon');
  });

  it('preserves comma-space unchanged with space separator', () => {
    const result = renderTemplate('{author}', { author: 'Sanderson, Brandon', title: 'Book' }, { separator: 'space' });
    expect(result).toBe('Sanderson, Brandon');
  });

  it('collapses all comma-spaces in multi-comma value with dash separator', () => {
    // Note: trailing "." stripped by sanitizePath (removes trailing dots)
    const result = renderTemplate('{author}', { author: 'Last, First, Jr.', title: 'Book' }, { separator: 'dash' });
    expect(result).toBe('Last,First,Jr');
  });

  it('leaves comma without trailing space unchanged with dash separator', () => {
    const result = renderTemplate('{author}', { author: 'LastFirst,Extra', title: 'Book' }, { separator: 'dash' });
    expect(result).toBe('LastFirst,Extra');
  });
});

describe('renderTemplate — consecutive separator collapse', () => {
  it('collapses double space to single separator with period separator', () => {
    const result = renderTemplate('{author}', { author: 'Author  Name', title: 'Book' }, { separator: 'period' });
    expect(result).toBe('Author.Name');
  });

  it('collapses leading spaces with dash separator', () => {
    const result = renderTemplate('{author}', { author: '  Leading', title: 'Book' }, { separator: 'dash' });
    expect(result).not.toMatch(/^-/);
    expect(result).toBe('Leading');
  });
});

describe('renderTemplate — separator + numeric padding interaction', () => {
  it('numeric formatted token {seriesPosition:00} unaffected by period separator', () => {
    expect(renderTemplate('{author}/{seriesPosition:00}', { author: 'Author', seriesPosition: 1 }, { separator: 'period' }))
      .toBe('Author/01');
  });

  it('conditional literal text {seriesPosition:00? - } unaffected by period separator', () => {
    expect(renderTemplate('{seriesPosition:00? - }{title}', { title: 'Book', seriesPosition: 1 }, { separator: 'period' }))
      .toBe('01 - Book');
  });
});

describe('renderTemplate — unresolved tokens', () => {
  it('erases unresolved {unknownToken} from output — not passthrough', () => {
    const result = renderTemplate('{unknownToken} - {title}', { title: 'Book' });
    expect(result).toBe('- Book');
    expect(result).not.toContain('{unknownToken}');
  });
});

describe('renderFilename — unresolved tokens', () => {
  it('erases unresolved {unknownToken} from output — not passthrough', () => {
    const result = renderFilename('{unknownToken} - {title}', { title: 'Book' });
    expect(result).toBe('- Book');
    expect(result).not.toContain('{unknownToken}');
  });
});

describe('renderFilename — comma-space separator edge cases', () => {
  it('collapses comma-space to comma with dash separator — no stray dash after punctuation', () => {
    const result = renderFilename('{author} - {title}', { author: 'Sanderson, Brandon', title: 'Book' }, { separator: 'dash' });
    expect(result).toBe('Sanderson,Brandon - Book');
  });

  it('collapses comma-space to comma with period separator', () => {
    const result = renderFilename('{author} - {title}', { author: 'Sanderson, Brandon', title: 'Book' }, { separator: 'period' });
    expect(result).toBe('Sanderson,Brandon - Book');
  });

  it('preserves comma-space unchanged with space separator', () => {
    const result = renderFilename('{author} - {title}', { author: 'Sanderson, Brandon', title: 'Book' }, { separator: 'space' });
    expect(result).toBe('Sanderson, Brandon - Book');
  });
});

describe('renderFilename — consecutive separator collapse', () => {
  it('collapses double space to single separator with period separator', () => {
    const result = renderFilename('{author} - {title}', { author: 'Author  Name', title: 'Book' }, { separator: 'period' });
    expect(result).toBe('Author.Name - Book');
  });
});

describe('prefix conditional syntax — resolveTokens / renderTemplate / renderFilename', () => {
  describe('positive cases', () => {
    it.todo('renders prefix + zero-padded value: {title}{ - pt?trackNumber:00} with trackNumber=1');
    it.todo('omits prefix when token absent: { - pt?trackNumber:00} with no trackNumber');
    it.todo('renders prefix with series: { - ?series}{title} with series present');
    it.todo('omits prefix when series absent: { - ?series}{title}');
    it.todo('renders both prefix and suffix: {pre?token?suf} with token present');
    it.todo('omits all when token absent: {pre?token?suf}');
    it.todo('empty prefix renders just value: {?trackNumber} with trackNumber=5');
  });

  describe('backward compatibility', () => {
    it.todo('existing suffix syntax unchanged: {seriesPosition:00? - } with seriesPosition=3');
    it.todo('suffix omitted when token missing');
    it.todo('plain token renders value: {title}');
    it.todo('zero-padding without conditional: {trackNumber:00}');
  });

  describe('disambiguation — suffix-first precedence', () => {
    it.todo('{author?title} parses as token=author, suffix="title" (both are known tokens)');
    it.todo('{title?series} parses as token=title, suffix="series" (both are known tokens)');
    it.todo('{ - pt?trackNumber:00} parses as prefix=" - pt", token=trackNumber (prefix is not a token)');
    it.todo('{Chapter ?partName} parses as prefix="Chapter ", token=partName');
  });

  describe('boundary / edge cases', () => {
    it.todo('whitespace-only prefix: { ?token} renders space + value');
    it.todo('prefix + pad + suffix: { - pt?trackNumber:000?!} renders all parts');
    it.todo('multiple prefix-conditional tokens: {title}{ - pt?trackNumber:00}{ of ?trackTotal}');
  });
});

describe('parseTemplate — prefix conditional syntax', () => {
  it.todo('prefix tokens reported by token name, not prefix text');
  it.todo('prefix syntax with unknown token name produces error');
  it.todo('template with both prefix and suffix conditionals extracts all tokens');
  it.todo('empty template returns empty tokens and no errors');
  it.todo('{unknownPrefix?title} — parsed as prefix syntax, valid');
  it.todo('{?unknownToken} — error: unknown token');
  it.todo('{title?unknownSuffix} — suffix syntax, valid');
});

describe('renderFilename with separator/case options', () => {
  it('space separator leaves token values unchanged', () => {
    expect(renderFilename('{author} - {title}', { author: 'Brandon Sanderson', title: 'The Way of Kings' }, { separator: 'space' }))
      .toBe('Brandon Sanderson - The Way of Kings');
  });

  it('period separator replaces spaces within token values', () => {
    expect(renderFilename('{author} - {title}', { author: 'Brandon Sanderson', title: 'The Way of Kings' }, { separator: 'period' }))
      .toBe('Brandon.Sanderson - The.Way.of.Kings');
  });

  it('upper case transforms token values to uppercase', () => {
    expect(renderFilename('{author} - {title}', { author: 'Brandon Sanderson', title: 'The Way of Kings' }, { case: 'upper' }))
      .toBe('BRANDON SANDERSON - THE WAY OF KINGS');
  });

  it('combined separator and case', () => {
    expect(renderFilename('{author} - {title}', { author: 'Brandon Sanderson', title: 'The Way of Kings' }, { separator: 'underscore', case: 'lower' }))
      .toBe('brandon_sanderson - the_way_of_kings');
  });

  it('does not transform literal text between tokens', () => {
    expect(renderFilename('{author} --- {title}', { author: 'Name Here', title: 'Book Title' }, { separator: 'period', case: 'upper' }))
      .toBe('NAME.HERE --- BOOK.TITLE');
  });

  it('omitting options preserves existing behavior', () => {
    expect(renderFilename('{author} - {title}', { author: 'Brandon Sanderson', title: 'The Way of Kings' }))
      .toBe('Brandon Sanderson - The Way of Kings');
  });
});
