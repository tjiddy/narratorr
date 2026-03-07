import { describe, it, expect } from 'vitest';
import { idParamSchema } from './common.js';

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
      expect(result.error.issues[0].message).toBe('Invalid ID');
    }
  });

  it('rejects empty string', () => {
    const result = idParamSchema.safeParse({ id: '' });
    expect(result.success).toBe(false);
  });

  it('transforms zero', () => {
    const result = idParamSchema.safeParse({ id: '0' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.id).toBe(0);
  });

  it('transforms negative numbers', () => {
    const result = idParamSchema.safeParse({ id: '-5' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.id).toBe(-5);
  });

  it('truncates floating point strings to integer (parseInt behavior)', () => {
    // parseInt('3.14') returns 3 — documents current behavior
    // This is acceptable for route params since URLs don't produce fractional IDs
    const result = idParamSchema.safeParse({ id: '3.14' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.id).toBe(3);
  });
});
