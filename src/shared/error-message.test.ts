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

  it('returns String(value) for non-Error string', () => {
    expect(getErrorMessage('just a string')).toBe('just a string');
  });

  it('returns String(value) for non-Error number', () => {
    expect(getErrorMessage(42)).toBe('42');
  });

  it('returns String(value) for non-Error boolean', () => {
    expect(getErrorMessage(true)).toBe('true');
  });

  it('returns String(value) for null', () => {
    expect(getErrorMessage(null)).toBe('null');
  });

  it('returns String(value) for undefined', () => {
    expect(getErrorMessage(undefined)).toBe('undefined');
  });

  it('returns String(value) for plain object', () => {
    expect(getErrorMessage({ message: 'sneaky' })).toBe('[object Object]');
    expect(getErrorMessage({ code: 'ERR' })).toBe('[object Object]');
  });

  it('returns empty string when Error has empty .message', () => {
    expect(getErrorMessage(new Error(''))).toBe('');
  });

  it('returns .message from custom Error subclass', () => {
    class AppError extends Error {
      code = 'APP_ERR';
    }
    expect(getErrorMessage(new AppError('custom'))).toBe('custom');
  });
});
