import { describe, it, expect } from 'vitest';
import { normalizeLanguage } from './language-codes.js';

describe('normalizeLanguage', () => {
  it('converts ISO 639 three-letter code to lowercase full name', () => {
    expect(normalizeLanguage('eng')).toBe('english');
    expect(normalizeLanguage('ger')).toBe('german');
    expect(normalizeLanguage('fre')).toBe('french');
    expect(normalizeLanguage('spa')).toBe('spanish');
    expect(normalizeLanguage('ita')).toBe('italian');
    expect(normalizeLanguage('jpn')).toBe('japanese');
    expect(normalizeLanguage('por')).toBe('portuguese');
    expect(normalizeLanguage('rus')).toBe('russian');
    expect(normalizeLanguage('zho')).toBe('chinese');
    expect(normalizeLanguage('kor')).toBe('korean');
    expect(normalizeLanguage('ara')).toBe('arabic');
    expect(normalizeLanguage('hin')).toBe('hindi');
    expect(normalizeLanguage('dut')).toBe('dutch');
    expect(normalizeLanguage('swe')).toBe('swedish');
    expect(normalizeLanguage('nor')).toBe('norwegian');
    expect(normalizeLanguage('dan')).toBe('danish');
    expect(normalizeLanguage('fin')).toBe('finnish');
    expect(normalizeLanguage('pol')).toBe('polish');
    expect(normalizeLanguage('tur')).toBe('turkish');
    expect(normalizeLanguage('heb')).toBe('hebrew');
  });

  it('is case-insensitive (handles uppercase MAM codes like ENG)', () => {
    expect(normalizeLanguage('ENG')).toBe('english');
    expect(normalizeLanguage('GER')).toBe('german');
    expect(normalizeLanguage('FRE')).toBe('french');
  });

  it('handles mixed case', () => {
    expect(normalizeLanguage('Eng')).toBe('english');
  });

  it('returns unknown codes as-is in lowercase', () => {
    expect(normalizeLanguage('xyz')).toBe('xyz');
    expect(normalizeLanguage('XYZ')).toBe('xyz');
  });

  it('handles full language names passed through (already normalized)', () => {
    expect(normalizeLanguage('english')).toBe('english');
    expect(normalizeLanguage('English')).toBe('english');
    expect(normalizeLanguage('ENGLISH')).toBe('english');
  });

  it('handles two-letter ISO 639-1 codes', () => {
    expect(normalizeLanguage('en')).toBe('english');
    expect(normalizeLanguage('de')).toBe('german');
    expect(normalizeLanguage('fr')).toBe('french');
    expect(normalizeLanguage('es')).toBe('spanish');
    expect(normalizeLanguage('ja')).toBe('japanese');
  });

  it('returns undefined for empty/whitespace input', () => {
    expect(normalizeLanguage('')).toBeUndefined();
    expect(normalizeLanguage('  ')).toBeUndefined();
  });

  it('returns undefined for undefined/null input', () => {
    expect(normalizeLanguage(undefined)).toBeUndefined();
    expect(normalizeLanguage(null as unknown as string)).toBeUndefined();
  });
});
