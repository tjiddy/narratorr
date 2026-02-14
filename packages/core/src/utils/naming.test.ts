import { describe, it, expect } from 'vitest';
import { sanitizePath, renderTemplate, parseTemplate, ALLOWED_TOKENS } from './naming.js';

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
    expect(result.errors).toContain('Template must include {title}');
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
});
