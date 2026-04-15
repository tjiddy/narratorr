import { describe, expect, it } from 'vitest';
import { MIME_TO_EXT, SUPPORTED_COVER_MIMES, SUPPORTED_COVER_ACCEPT, mimeToExt } from './mime.js';

describe('shared/mime', () => {
  describe('MIME_TO_EXT', () => {
    it('maps image/jpeg to jpg', () => {
      expect(MIME_TO_EXT['image/jpeg']).toBe('jpg');
    });

    it('maps image/png to png', () => {
      expect(MIME_TO_EXT['image/png']).toBe('png');
    });

    it('maps image/webp to webp', () => {
      expect(MIME_TO_EXT['image/webp']).toBe('webp');
    });
  });

  describe('SUPPORTED_COVER_MIMES', () => {
    it('contains exactly jpeg, png, and webp MIME types', () => {
      expect(SUPPORTED_COVER_MIMES).toEqual(new Set(['image/jpeg', 'image/png', 'image/webp']));
      expect(SUPPORTED_COVER_MIMES.size).toBe(3);
    });
  });

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
    });

    it('returns null for undefined input', () => {
      expect(mimeToExt(undefined)).toBeNull();
    });
  });

  describe('SUPPORTED_COVER_ACCEPT', () => {
    it('is a comma-separated string of all supported MIME types', () => {
      expect(SUPPORTED_COVER_ACCEPT).toBe('image/jpeg,image/png,image/webp');
    });
  });
});
