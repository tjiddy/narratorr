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

  it('returns fallback for non-Error primitives', () => {
    expect(getErrorMessage('just a string')).toBe('Unknown error');
    expect(getErrorMessage(42)).toBe('Unknown error');
    expect(getErrorMessage(true)).toBe('Unknown error');
  });

  it('returns fallback for null', () => {
    expect(getErrorMessage(null)).toBe('Unknown error');
  });

  it('returns fallback for undefined', () => {
    expect(getErrorMessage(undefined)).toBe('Unknown error');
  });

  it('returns fallback for plain object', () => {
    expect(getErrorMessage({ code: 'ERR' })).toBe('Unknown error');
  });

  it('returns .message from custom Error subclass', () => {
    class AppError extends Error {
      code = 'APP_ERR';
    }
    expect(getErrorMessage(new AppError('custom'))).toBe('custom');
  });

  it('returns empty string when Error has empty .message', () => {
    expect(getErrorMessage(new Error(''))).toBe('');
  });

  it('uses provided custom fallback string for non-Error values', () => {
    expect(getErrorMessage('oops', 'Scan failed')).toBe('Scan failed');
    expect(getErrorMessage(null, 'Database unreachable')).toBe('Database unreachable');
  });

  it('uses Unknown error as default when no fallback provided', () => {
    expect(getErrorMessage({})).toBe('Unknown error');
  });
});
