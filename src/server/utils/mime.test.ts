import { describe, expect, it } from 'vitest';
import { mimeToExt, SUPPORTED_COVER_MIMES } from './mime.js';

describe('mimeToExt', () => {
  it('returns jpg for image/jpeg', () => {
    expect(mimeToExt('image/jpeg')).toBe('jpg');
  });

  it('returns png for image/png', () => {
    expect(mimeToExt('image/png')).toBe('png');
  });

  it('returns webp for image/webp', () => {
    expect(mimeToExt('image/webp')).toBe('webp');
  });

  it('returns null for unknown MIME type', () => {
    expect(mimeToExt('image/gif')).toBeNull();
    expect(mimeToExt('text/plain')).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(mimeToExt(undefined)).toBeNull();
  });

  it('returns null for case-mismatched MIME (image/PNG)', () => {
    expect(mimeToExt('image/PNG')).toBeNull();
    expect(mimeToExt('IMAGE/JPEG')).toBeNull();
  });
});

describe('SUPPORTED_COVER_MIMES', () => {
  it('contains exactly jpeg, png, and webp', () => {
    expect(SUPPORTED_COVER_MIMES).toEqual(new Set(['image/jpeg', 'image/png', 'image/webp']));
    expect(SUPPORTED_COVER_MIMES.size).toBe(3);
  });
});
