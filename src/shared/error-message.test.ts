import { describe, expect, it } from 'vitest';
import { getErrorMessage } from './error-message.js';

describe('getErrorMessage (shared)', () => {
  it('returns .message from Error instances', () => {
    expect(getErrorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('returns .message from Error subclasses (TypeError, RangeError)', () => {
    expect(getErrorMessage(new TypeError('bad type'))).toBe('bad type');
    expect(getErrorMessage(new RangeError('out of range'))).toBe('out of range');
  });

  it('returns fallback for non-Error primitives (string, number, boolean)', () => {
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

  it('returns fallback for plain object with .message property', () => {
    expect(getErrorMessage({ message: 'sneaky' })).toBe('Unknown error');
    expect(getErrorMessage({ code: 'ERR' })).toBe('Unknown error');
  });

  it('returns empty string when Error has empty .message', () => {
    expect(getErrorMessage(new Error(''))).toBe('');
  });

  it('uses custom fallback when provided', () => {
    expect(getErrorMessage('oops', 'Scan failed')).toBe('Scan failed');
    expect(getErrorMessage(null, 'Database unreachable')).toBe('Database unreachable');
  });

  it('uses default fallback "Unknown error" when no fallback provided', () => {
    expect(getErrorMessage({})).toBe('Unknown error');
  });

  it('returns .message from custom Error subclass', () => {
    class AppError extends Error {
      code = 'APP_ERR';
    }
    expect(getErrorMessage(new AppError('custom'))).toBe('custom');
  });
});
