import { describe, expect, it } from 'vitest';
import { normalizeInfoHash } from './normalize-info-hash.js';
import { base32ToHex } from './base32.js';

const KNOWN_BASE32_HASH = 'CZTQQ3JBFHCAACQ43HMZJGA3DFGE2UCR';
const KNOWN_HEX_HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

describe('normalizeInfoHash', () => {
  it('converts 32-char base32 hash to 40-char lowercase hex', () => {
    const result = normalizeInfoHash(KNOWN_BASE32_HASH);
    expect(result).toBe(base32ToHex(KNOWN_BASE32_HASH).toLowerCase());
    expect(result).toHaveLength(40);
  });

  it('lowercases 40-char hex hash without base32 conversion', () => {
    const upper = KNOWN_HEX_HASH.toUpperCase();
    expect(normalizeInfoHash(upper)).toBe(KNOWN_HEX_HASH);
  });

  it('returns lowercase for mixed-case hex input', () => {
    expect(normalizeInfoHash('A1B2C3d4e5F6a7b8c9D0e1f2a3b4c5d6e7F8a9b0'))
      .toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
  });

  it('silently skips invalid base32 characters in 32-char string', () => {
    const withInvalid = 'CZTQQ3JBFHCAACQ4311ZJGA3DFGE2UCR';
    const result = normalizeInfoHash(withInvalid);
    expect(result).toBe(base32ToHex(withInvalid).toLowerCase());
  });
});
