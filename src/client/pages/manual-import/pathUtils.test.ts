import { describe, it, expect } from 'vitest';
import { isPathInsideLibrary } from './pathUtils.js';

describe('isPathInsideLibrary', () => {
  describe('path containment detection', () => {
    it('returns true when scan path is a direct subdirectory of library root', () => {
      expect(isPathInsideLibrary('/audiobooks/sub', '/audiobooks')).toBe(true);
    });

    it('returns true when scan path is nested multiple levels under library root', () => {
      expect(isPathInsideLibrary('/audiobooks/author/title', '/audiobooks')).toBe(true);
    });

    it('returns true when scan path exactly equals library root (scanning root re-discovers managed books)', () => {
      expect(isPathInsideLibrary('/audiobooks', '/audiobooks')).toBe(true);
    });

    it('returns false when scan path is completely outside library root', () => {
      expect(isPathInsideLibrary('/media/podcasts', '/audiobooks')).toBe(false);
    });

    it('returns false when scan path shares a prefix but is not inside library root', () => {
      expect(isPathInsideLibrary('/audiobooks-old/sub', '/audiobooks')).toBe(false);
    });

    it('returns false when scan path shares a prefix but diverges at segment boundary', () => {
      expect(isPathInsideLibrary('/lib-old/sub', '/lib')).toBe(false);
    });
  });

  describe('trailing slash normalization', () => {
    it('returns true when library path has no trailing slash', () => {
      expect(isPathInsideLibrary('/lib/sub', '/lib')).toBe(true);
    });

    it('returns true when library path has a trailing slash', () => {
      expect(isPathInsideLibrary('/lib/sub', '/lib/')).toBe(true);
    });

    it('returns true when both paths have trailing slashes', () => {
      expect(isPathInsideLibrary('/lib/sub/', '/lib/')).toBe(true);
    });
  });

  describe('empty and missing paths', () => {
    it('returns false when scan path is empty string', () => {
      expect(isPathInsideLibrary('', '/audiobooks')).toBe(false);
    });

    it('returns false when library path is empty string', () => {
      expect(isPathInsideLibrary('/audiobooks/sub', '')).toBe(false);
    });

    it('returns false when library path is whitespace only', () => {
      expect(isPathInsideLibrary('/audiobooks/sub', '   ')).toBe(false);
    });

    it('returns false when scan path is whitespace only', () => {
      expect(isPathInsideLibrary('   ', '/audiobooks')).toBe(false);
    });
  });
});
