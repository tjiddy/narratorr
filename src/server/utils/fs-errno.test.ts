import { describe, expect, it } from 'vitest';
import { DEFINITIVE_ABSENCE_CODES, errnoCode, isDefinitiveAbsence } from './fs-errno.js';

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('DEFINITIVE_ABSENCE_CODES', () => {
  it('contains exactly ENOENT and ENOTDIR', () => {
    expect([...DEFINITIVE_ABSENCE_CODES].sort()).toEqual(['ENOENT', 'ENOTDIR']);
  });
});

describe('isDefinitiveAbsence', () => {
  it.each(['ENOENT', 'ENOTDIR'])('treats %s as a definitive absence', (code) => {
    expect(isDefinitiveAbsence(coded(code))).toBe(true);
  });

  // Every other probe failure must retain the path.
  it.each(['EACCES', 'EIO', 'ESTALE', 'EPERM', 'ELOOP', 'EMFILE', 'ENFILE'])(
    'treats %s as undetermined',
    (code) => {
      expect(isDefinitiveAbsence(coded(code))).toBe(false);
    },
  );

  it('ignores the message — a codeless Error("ENOENT") is undetermined', () => {
    expect(isDefinitiveAbsence(new Error('ENOENT'))).toBe(false);
  });

  it.each([
    ['a bare string', 'ENOENT'],
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {}],
    ['a number', 2],
  ])('returns false without throwing for %s', (_label, value) => {
    expect(isDefinitiveAbsence(value)).toBe(false);
  });

  it('requires the code to be a string', () => {
    expect(isDefinitiveAbsence({ code: 2 })).toBe(false);
  });

  it('accepts a plain object carrying a definitive code (non-Error throws)', () => {
    expect(isDefinitiveAbsence({ code: 'ENOENT' })).toBe(true);
  });
});

describe('errnoCode', () => {
  it('reads a string code off an Error', () => {
    expect(errnoCode(coded('EACCES'))).toBe('EACCES');
  });

  it('reads a string code off a plain object', () => {
    expect(errnoCode({ code: 'EIO' })).toBe('EIO');
  });

  it.each([
    ['a codeless Error', new Error('boom')],
    ['a non-string code', { code: 2 }],
    ['a bare string', 'EACCES'],
    ['undefined', undefined],
    ['null', null],
  ])('returns undefined for %s', (_label, value) => {
    expect(errnoCode(value)).toBeUndefined();
  });
});
