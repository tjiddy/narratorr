import { describe, expect, it } from 'vitest';
import { ensureError } from './ensure-error.js';

describe('ensureError', () => {
  it('returns the same instance when input is already an Error', () => {
    const input = new Error('boom');
    const result = ensureError(input);
    expect(result).toBe(input);
  });

  it('preserves Error subclasses (TypeError)', () => {
    const input = new TypeError('bad type');
    const result = ensureError(input);
    expect(result).toBe(input);
    expect(result).toBeInstanceOf(TypeError);
  });

  it('preserves custom Error subclasses', () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }
    const input = new CustomError('custom');
    const result = ensureError(input);
    expect(result).toBe(input);
    expect(result).toBeInstanceOf(CustomError);
  });

  it('wraps strings into Error with the string as message', () => {
    const result = ensureError('boom');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('boom');
  });

  it('wraps numbers into Error with the stringified number as message', () => {
    const result = ensureError(42);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('42');
  });

  it('wraps null into Error with message "null"', () => {
    const result = ensureError(null);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('null');
  });

  it('wraps undefined into Error with message "undefined"', () => {
    const result = ensureError(undefined);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('undefined');
  });

  it('wraps plain objects into Error with message "[object Object]" (no field extraction)', () => {
    const result = ensureError({ msg: 'oops' });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('[object Object]');
  });

  it('every wrapped non-Error value satisfies instanceof Error', () => {
    const cases: unknown[] = ['s', 0, false, null, undefined, {}, [], Symbol('s')];
    for (const value of cases) {
      expect(ensureError(value)).toBeInstanceOf(Error);
    }
  });
});
