import { describe, expect, it } from 'vitest';
import { getErrorMessage, isUniqueViolation } from './error-message.js';

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

  it('returns Unknown error for empty string (String("") is empty)', () => {
    expect(getErrorMessage('')).toBe('Unknown error');
  });

  it('returns Unknown error for empty array (String([]) is empty)', () => {
    expect(getErrorMessage([])).toBe('Unknown error');
  });

  it('returns "0" for falsy number zero (String(0) is non-empty)', () => {
    expect(getErrorMessage(0)).toBe('0');
  });

  it('returns "false" for falsy boolean (String(false) is non-empty)', () => {
    expect(getErrorMessage(false)).toBe('false');
  });

  it('returns "NaN" for NaN (String(NaN) is non-empty)', () => {
    expect(getErrorMessage(NaN)).toBe('NaN');
  });
});

describe('isUniqueViolation (shared)', () => {
  // Throwaway pattern mirroring the two real call-site forms: a named index and
  // a `table.column` form. Both production regexes share this shape.
  const PATTERN = /UNIQUE constraint failed.*(?:idx_x|tbl\.col)/;

  it('matches a top-level message (no cause)', () => {
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: tbl.col'), PATTERN)).toBe(true);
  });

  it('matches a nested cause.message independently of a generic top-level message', () => {
    const error = Object.assign(new Error('insert failed'), {
      cause: { message: 'UNIQUE constraint failed: idx_x' },
    });
    expect(isUniqueViolation(error, PATTERN)).toBe(true);
  });

  it('matches both the index-name form and the table.column form', () => {
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: idx_x'), PATTERN)).toBe(true);
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: tbl.col'), PATTERN)).toBe(true);
  });

  it('returns false for an unrelated SQLite error', () => {
    expect(isUniqueViolation(new Error('SQLITE_BUSY: database is locked'), PATTERN)).toBe(false);
  });

  it('returns false for a UNIQUE error on an unrelated table (no false positive)', () => {
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: other.field'), PATTERN)).toBe(
      false,
    );
  });

  it('returns false for non-Error input (string, object, null, undefined)', () => {
    expect(isUniqueViolation('UNIQUE constraint failed: tbl.col', PATTERN)).toBe(false);
    expect(isUniqueViolation({ message: 'UNIQUE constraint failed: tbl.col' }, PATTERN)).toBe(false);
    expect(isUniqueViolation(null, PATTERN)).toBe(false);
    expect(isUniqueViolation(undefined, PATTERN)).toBe(false);
  });

  it('does not throw when cause has no message, falls back to top-level message', () => {
    const objCause = Object.assign(new Error('UNIQUE constraint failed: idx_x'), { cause: {} });
    expect(isUniqueViolation(objCause, PATTERN)).toBe(true);

    const stringCause = Object.assign(new Error('UNIQUE constraint failed: idx_x'), {
      cause: 'oops',
    });
    expect(isUniqueViolation(stringCause, PATTERN)).toBe(true);
  });

  it('does not throw for an Error with no cause and a non-matching message', () => {
    expect(isUniqueViolation(new Error('plain error'), PATTERN)).toBe(false);
  });
});
