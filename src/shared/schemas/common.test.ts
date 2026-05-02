import { describe, it, expect } from 'vitest';
import { idParamSchema, paginationParamsSchema } from './common.js';

describe('idParamSchema', () => {
  it('transforms valid numeric string to number', () => {
    const result = idParamSchema.safeParse({ id: '123' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.id).toBe(123);
  });

  it('rejects non-numeric string', () => {
    const result = idParamSchema.safeParse({ id: 'abc' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toBe('Invalid ID');
    }
  });

  it('rejects empty string', () => {
    const result = idParamSchema.safeParse({ id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects zero (IDs must be positive)', () => {
    const result = idParamSchema.safeParse({ id: '0' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toBe('Invalid ID');
    }
  });

  it('rejects negative numbers', () => {
    const result = idParamSchema.safeParse({ id: '-5' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toBe('Invalid ID');
    }
  });

  it('truncates floating point strings to integer (parseInt behavior)', () => {
    // parseInt('3.14') returns 3 — documents current behavior
    // This is acceptable for route params since URLs don't produce fractional IDs
    const result = idParamSchema.safeParse({ id: '3.14' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.id).toBe(3);
  });
});

describe('paginationParamsSchema', () => {
  it('accepts valid limit and offset', () => {
    const result = paginationParamsSchema.safeParse({ limit: 10, offset: 0 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
      expect(result.data.offset).toBe(0);
    }
  });

  it('coerces string values to numbers', () => {
    const result = paginationParamsSchema.safeParse({ limit: '10', offset: '20' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
      expect(result.data.offset).toBe(20);
    }
  });

  it('allows omitting both params', () => {
    const result = paginationParamsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBeUndefined();
      expect(result.data.offset).toBeUndefined();
    }
  });

  it('rejects non-numeric limit', () => {
    const result = paginationParamsSchema.safeParse({ limit: 'abc' });
    expect(result.success).toBe(false);
  });

  it('rejects limit = 0 (min 1)', () => {
    const result = paginationParamsSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects negative limit', () => {
    const result = paginationParamsSchema.safeParse({ limit: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects limit exceeding max (500)', () => {
    const result = paginationParamsSchema.safeParse({ limit: 600 });
    expect(result.success).toBe(false);
  });

  it('accepts limit at max boundary (500)', () => {
    const result = paginationParamsSchema.safeParse({ limit: 500 });
    expect(result.success).toBe(true);
  });

  it('rejects negative offset', () => {
    const result = paginationParamsSchema.safeParse({ offset: -5 });
    expect(result.success).toBe(false);
  });

  it('accepts offset = 0', () => {
    const result = paginationParamsSchema.safeParse({ offset: 0 });
    expect(result.success).toBe(true);
  });
});
