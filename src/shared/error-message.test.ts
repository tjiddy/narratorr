import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { getErrorMessage, isUniqueViolation } from './error-message.js';
import { describeDbError } from './db-error.js';
import { ASIN_UNIQUE_VIOLATION } from '../server/services/book-dedup.js';
import {
  LEAKY_DOWNLOAD_URL,
  expectNoLeak,
  makeLeakyDrizzleError,
} from '../server/__tests__/drizzle-error.fixture.js';

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

  it('matches a top-level message independently of a present, nonmatching cause.message', () => {
    const error = Object.assign(new Error('UNIQUE constraint failed: tbl.col'), {
      cause: { message: 'SQLITE_BUSY: database is locked' },
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

describe('getErrorMessage refuses to render a DB error raw (T36, AC6)', () => {
  it('summarizes a drizzle query error instead of returning its message', () => {
    const raw = makeLeakyDrizzleError();
    const rendered = getErrorMessage(raw);

    expect(rendered).toBe(describeDbError(raw));
    expectNoLeak(rendered);
    expect(rendered).toContain('FOREIGN KEY constraint failed');
    expect(rendered).toContain('downloads');
  });

  // AC13: the arm must be inert everywhere else, at all 161 call sites.
  it.each([
    ['a plain Error', new Error('No download client'), 'No download client'],
    ['an Error carrying a URL', new Error('fetch failed for https://idx.test/api?k=1'), 'fetch failed for https://idx.test/api?k=1'],
    ['a TypeError', new TypeError('x is not a function'), 'x is not a function'],
    ['a string', 'plain string', 'plain string'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['a plain object', { message: 'sneaky' }, '[object Object]'],
  ])('is a no-op for %s', (_label, input, expected) => {
    expect(getErrorMessage(input)).toBe(expected);
  });

  // The describer sits under a chokepoint called from inside other people's catch blocks.
  it('never throws, even for a hostile shape', () => {
    const hostile = new Proxy(new Error('ordinary failure'), {
      getOwnPropertyDescriptor() {
        throw new Error('trap detonated');
      },
    });
    expect(() => getErrorMessage(hostile)).not.toThrow();
    expect(getErrorMessage(hostile)).toBe('ordinary failure');
  });
});

describe('isUniqueViolation is unaffected by the AC6 arm (T37, AC12)', () => {
  it('still matches a UNIQUE cause wrapped in a drizzle error', () => {
    const err = new DrizzleQueryError(
      'insert into "books" ("asin") values (?)',
      ['B01LEAK'],
      new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: books.asin'),
    );

    // The two functions are independent by construction: one renders, the other reads the object.
    expect(isUniqueViolation(err, ASIN_UNIQUE_VIOLATION)).toBe(true);
    expect(getErrorMessage(err)).not.toBe(err.message);
  });

  it('reads the original throwable, not the rendered summary', () => {
    // The tempting wrong fix — rewrapping in `new Error(summary)` — loses `.cause` and reds here.
    const err = makeLeakyDrizzleError({
      query: 'insert into "books" ("asin", "download_url") values (?, ?)',
      cause: new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: idx_books_asin_unique'),
    });
    expect(err.message).toContain(LEAKY_DOWNLOAD_URL);
    expect(isUniqueViolation(err, ASIN_UNIQUE_VIOLATION)).toBe(true);
  });
});
