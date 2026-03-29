import { describe, it, expect } from 'vitest';
import { isPathInsideLibrary, makeRelativePath } from './pathUtils.js';

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

  describe('dotdot (..) segment normalization', () => {
    it('returns false when scan path normalizes to outside library root via ..', () => {
      expect(isPathInsideLibrary('/audiobooks/../other', '/audiobooks')).toBe(false);
    });

    it('returns false when scan path normalizes to completely different root via multiple ..', () => {
      expect(isPathInsideLibrary('/audiobooks/sub/../../other', '/audiobooks')).toBe(false);
    });

    it('returns true when scan path normalizes to inside library root (.. resolves within library)', () => {
      expect(isPathInsideLibrary('/audiobooks/sub/../sub2', '/audiobooks')).toBe(true);
    });

    it('returns true when scan path normalizes to inside library root via leading ..', () => {
      expect(isPathInsideLibrary('/audiobooks/../audiobooks/sub', '/audiobooks')).toBe(true);
    });

    it('normalizes single dot segments in scan path', () => {
      expect(isPathInsideLibrary('/audiobooks/./sub', '/audiobooks')).toBe(true);
    });

    it('normalizes dotdot in library path itself', () => {
      expect(isPathInsideLibrary('/audiobooks/sub', '/lib/../audiobooks')).toBe(true);
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

describe('makeRelativePath', () => {
  describe('normal relative path computation', () => {
    it('returns relative path for direct subdirectory', () => {
      expect(makeRelativePath('/audiobooks/sub', '/audiobooks')).toBe('sub');
    });

    it('returns relative path without leading slash when root has no trailing slash', () => {
      expect(makeRelativePath('/audiobooks/sub', '/audiobooks')).toBe('sub');
    });

    it('returns relative path without leading slash when root has trailing slash', () => {
      expect(makeRelativePath('/audiobooks/sub', '/audiobooks/')).toBe('sub');
    });

    it('returns nested relative path with author/title structure', () => {
      expect(makeRelativePath('/audiobooks/Author Name/Book Title', '/audiobooks')).toBe('Author Name/Book Title');
    });
  });

  describe('non-ancestry cases return undefined', () => {
    it('returns undefined when path is a sibling of library root (shares prefix but diverges at segment boundary)', () => {
      expect(makeRelativePath('/audiobooks-old/sub', '/audiobooks')).toBeUndefined();
    });

    it('returns undefined when path is a parent of library root', () => {
      expect(makeRelativePath('/', '/audiobooks')).toBeUndefined();
    });

    it('returns undefined when path is completely unrelated to library root', () => {
      expect(makeRelativePath('/media/podcasts/ep1', '/audiobooks')).toBeUndefined();
    });

    it('returns undefined when path uses .. traversal to escape the library root', () => {
      expect(makeRelativePath('/audiobooks/../etc/passwd', '/audiobooks')).toBeUndefined();
    });
  });

  describe('root-equality edge case', () => {
    it('returns undefined when absolutePath exactly equals libraryPath (so ImportCard falls back to short-path display)', () => {
      expect(makeRelativePath('/audiobooks', '/audiobooks')).toBeUndefined();
    });
  });

  describe('empty and missing inputs', () => {
    it('returns undefined when absolutePath is empty string', () => {
      expect(makeRelativePath('', '/audiobooks')).toBeUndefined();
    });

    it('returns undefined when absolutePath is whitespace only', () => {
      expect(makeRelativePath('   ', '/audiobooks')).toBeUndefined();
    });

    it('returns undefined when libraryPath is empty string', () => {
      expect(makeRelativePath('/audiobooks/sub', '')).toBeUndefined();
    });

    it('returns undefined when libraryPath is whitespace only', () => {
      expect(makeRelativePath('/audiobooks/sub', '   ')).toBeUndefined();
    });
  });
});
