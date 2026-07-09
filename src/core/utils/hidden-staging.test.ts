import { describe, it, expect } from 'vitest';
import { basename, join } from 'node:path';
import { dotPrefixBasename } from './hidden-staging.js';

describe('dotPrefixBasename (#1852)', () => {
  // dotPrefixBasename composes `join`, which emits backslashes on Windows; normalize the actual
  // to POSIX before comparing to a POSIX literal (repo cross-platform test rule).
  const norm = (p: string): string => p.split('\\').join('/');

  it('dot-prefixes the final segment, leaving the parent untouched (same filesystem)', () => {
    expect(norm(dotPrefixBasename(join('/lib/Author', 'Book.merge-tmp')))).toBe('/lib/Author/.Book.merge-tmp');
    expect(norm(dotPrefixBasename(join('/lib/Author', 'Book.convert-tmp')))).toBe('/lib/Author/.Book.convert-tmp');
    expect(norm(dotPrefixBasename(join('/lib/Book', '002.tmp.mp3')))).toBe('/lib/Book/.002.tmp.mp3');
  });

  it('is idempotent for an already-hidden basename', () => {
    expect(dotPrefixBasename('/lib/.Book.merge-tmp')).toBe('/lib/.Book.merge-tmp');
  });

  it('handles a bare basename with no directory component', () => {
    expect(dotPrefixBasename('Book.merge-tmp')).toBe('.Book.merge-tmp');
  });

  it('the produced basename is always born hidden', () => {
    for (const p of ['/lib/A/Book.merge-tmp', '/lib/A/Book.convert-tmp', '/lib/A/Book/x_tmp.m4b']) {
      expect(basename(dotPrefixBasename(p)).startsWith('.')).toBe(true);
    }
  });
});

describe('ABS-parity: every v1 staging entry name is ignored by Audiobookshelf (#1852)', () => {
  // Mirror of ABS `shouldIgnoreFile` (server/utils/fileUtils.js): a path is ignored when its
  // basename is dot-led OR any path component is dot-led. Every born-hidden staging entry we
  // create has a dot-led basename, so ABS folds none of them into a book.
  const absShouldIgnore = (relPath: string): boolean =>
    relPath.split('/').some((seg) => seg.startsWith('.'));

  const stagingEntryNames = [
    basename(dotPrefixBasename('/lib/Book.merge-tmp')),        // AC11 merge staging dir
    basename(dotPrefixBasename('/lib/Book.convert-tmp')),      // AC10 bulk-convert staging dir
    basename(dotPrefixBasename('/lib/Book/Chapter 01.tmp.m4b')), // AC9 tagging temp file
    basename(dotPrefixBasename('/lib/Book/Chapter 01_tmp.m4b')),  // AC12 per-file convert temp
  ];

  it('ignores each v1 staging basename', () => {
    for (const name of stagingEntryNames) {
      expect(name.startsWith('.')).toBe(true);
      expect(absShouldIgnore(name)).toBe(true);
      // ...and its whole subtree: any file INSIDE a `.merge-tmp/` is also invisible (dotpath rule).
      expect(absShouldIgnore(`${name}/track.mp3`)).toBe(true);
    }
  });
});
