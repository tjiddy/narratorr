import { describe, expect, it } from 'vitest';
import { createBookBodySchema, enrichmentStatusSchema } from './book.js';

describe('enrichmentStatusSchema', () => {
  it.each(['pending', 'enriched', 'failed', 'skipped', 'file-enriched'] as const)(
    'accepts valid value: %s',
    (value) => {
      expect(enrichmentStatusSchema.parse(value)).toBe(value);
    },
  );

  it('rejects invalid value', () => {
    expect(() => enrichmentStatusSchema.parse('invalid')).toThrow();
  });
});

const validBook = {
  title: 'My Book',
  authors: [{ name: 'Author Name' }],
};

describe('createBookBodySchema — series ASIN (#1071)', () => {
  it('accepts seriesAsin alongside scalar seriesName/seriesPosition', () => {
    const result = createBookBodySchema.safeParse({
      ...validBook,
      seriesName: 'The Band',
      seriesPosition: 1,
      seriesAsin: 'B07DHQY7DX',
      seriesProvider: 'audible',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seriesAsin).toBe('B07DHQY7DX');
      expect(result.data.seriesProvider).toBe('audible');
    }
  });

  it('treats seriesAsin/seriesProvider as optional (back-compat)', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, seriesName: 'The Band', seriesPosition: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seriesAsin).toBeUndefined();
    }
  });
});

describe('createBookBodySchema — authors default (#246)', () => {
  it('accepts payload with title only, no authors field — defaults to []', () => {
    const result = createBookBodySchema.safeParse({ title: 'Shogun' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.authors).toEqual([]);
    }
  });

  it('accepts payload with title + explicit authors array', () => {
    const result = createBookBodySchema.safeParse({ title: 'Shogun', authors: [{ name: 'James Clavell' }] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.authors).toEqual([{ name: 'James Clavell' }]);
    }
  });

  it('accepts payload with title + empty authors array', () => {
    const result = createBookBodySchema.safeParse({ title: 'Shogun', authors: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.authors).toEqual([]);
    }
  });
});

describe('createBookBodySchema — trim behavior', () => {
  it('rejects whitespace-only title', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, title: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from title', () => {
    const result = createBookBodySchema.safeParse({ ...validBook, title: '  My Book  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.title).toBe('My Book');
  });

  it('accepts valid title', () => {
    const result = createBookBodySchema.safeParse(validBook);
    expect(result.success).toBe(true);
  });
});
