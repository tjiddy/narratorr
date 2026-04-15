import { describe, expect, it } from 'vitest';
import { mimeToExt, SUPPORTED_COVER_MIMES } from './mime.js';

describe('server mime re-export', () => {
  it('re-exports mimeToExt from shared module', () => {
    expect(mimeToExt('image/jpeg')).toBe('jpg');
    expect(mimeToExt(undefined)).toBeNull();
  });

  it('re-exports SUPPORTED_COVER_MIMES from shared module', () => {
    expect(SUPPORTED_COVER_MIMES).toEqual(new Set(['image/jpeg', 'image/png', 'image/webp']));
  });
});
