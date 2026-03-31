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

describe('createBookBodySchema — authors default', () => {
  it.todo('accepts payload with title only, no authors field — defaults to []');
  it.todo('accepts payload with title + explicit authors array');
  it.todo('accepts payload with title + empty authors array');
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
