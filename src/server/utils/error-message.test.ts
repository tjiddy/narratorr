import { describe, expect, it } from 'vitest';
import { getErrorMessage } from './error-message.js';

describe('getErrorMessage', () => {
  it('returns .message from Error instances', () => {
    expect(getErrorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('returns .message from Error subclasses', () => {
    expect(getErrorMessage(new TypeError('bad type'))).toBe('bad type');
    expect(getErrorMessage(new RangeError('out of range'))).toBe('out of range');
  });

  it('returns Unknown error for string when no fallback', () => {
    expect(getErrorMessage('just a string')).toBe('Unknown error');
  });

  it('returns Unknown error for number when no fallback', () => {
    expect(getErrorMessage(42)).toBe('Unknown error');
  });

  it('returns Unknown error for null when no fallback', () => {
    expect(getErrorMessage(null)).toBe('Unknown error');
  });

  it('returns Unknown error for undefined when no fallback', () => {
    expect(getErrorMessage(undefined)).toBe('Unknown error');
  });

  it('returns Unknown error for plain object when no fallback', () => {
    expect(getErrorMessage({ code: 'ERR' })).toBe('Unknown error');
  });

  it('returns custom fallback for non-Error values when fallback provided', () => {
    expect(getErrorMessage('oops', 'Scan failed')).toBe('Scan failed');
    expect(getErrorMessage(null, 'Database unreachable')).toBe('Database unreachable');
  });

  it('returns .message from custom error class with .code property', () => {
    class AppError extends Error {
      code = 'APP_ERR';
    }
    expect(getErrorMessage(new AppError('custom'))).toBe('custom');
  });

  it('returns empty string when Error has empty .message', () => {
    expect(getErrorMessage(new Error(''))).toBe('');
  });
});
