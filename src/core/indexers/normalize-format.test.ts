import { describe, it, expect } from 'vitest';
import { normalizeFormat } from './normalize-format.js';

describe('normalizeFormat', () => {
  it('lowercases so two indexers reporting the same container agree', () => {
    expect(normalizeFormat('M4B')).toBe('m4b');
    expect(normalizeFormat('m4b')).toBe('m4b');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeFormat('  MP3 ')).toBe('mp3');
  });

  it.each([undefined, null, '', '   '])('folds %o to absence rather than a default', (raw) => {
    expect(normalizeFormat(raw)).toBeUndefined();
  });
});
