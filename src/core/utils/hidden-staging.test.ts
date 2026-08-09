import { describe, it, expect } from 'vitest';
import { basename, join } from 'node:path';
import { dotPrefixBasename } from './hidden-staging.js';
import { deriveImportSiblings } from '../../server/utils/import-sibling-paths.js';

describe('dotPrefixBasename (#1852)', () => {
  // `join` uses Windows separators here; normalize before comparing to POSIX fixtures.
  const norm = (p: string): string => p.split('\\').join('/');

  it('dot-prefixes the final segment, leaving the parent untouched (same filesystem)', () => {
    expect(norm(dotPrefixBasename(join('/lib/Author', 'Book.merge-tmp')))).toBe('/lib/Author/.Book.merge-tmp');
    expect(norm(dotPrefixBasename(join('/lib/Author', 'Book.import-staging')))).toBe('/lib/Author/.Book.import-staging');
    expect(norm(dotPrefixBasename(join('/lib/Book', '002.tmp.mp3')))).toBe('/lib/Book/.002.tmp.mp3');
  });

  it('is idempotent for an already-hidden basename', () => {
    expect(dotPrefixBasename('/lib/.Book.merge-tmp')).toBe('/lib/.Book.merge-tmp');
  });

  it('handles a bare basename with no directory component', () => {
    expect(dotPrefixBasename('Book.merge-tmp')).toBe('.Book.merge-tmp');
  });

  it('the produced basename is always born hidden', () => {
    for (const p of ['/lib/A/Book.merge-tmp', '/lib/A/Book.import-staging', '/lib/A/Book/x.tmp.m4b']) {
      expect(basename(dotPrefixBasename(p)).startsWith('.')).toBe(true);
    }
  });
});

describe('ABS-parity: every v1 staging entry name is ignored by Audiobookshelf (#1852)', () => {
  // Audiobookshelf ignores any dot-led path component; staging names must preserve that contract.
  const absShouldIgnore = (relPath: string): boolean =>
    relPath.split('/').some((seg) => seg.startsWith('.'));

  const stagingEntryNames = [
    basename(dotPrefixBasename('/lib/Book.merge-tmp')),
    basename(dotPrefixBasename('/lib/Book/Chapter 01.tmp.m4b')),
  ];

  it('ignores each v1 staging basename', () => {
    for (const name of stagingEntryNames) {
      expect(name.startsWith('.')).toBe(true);
      expect(absShouldIgnore(name)).toBe(true);
      expect(absShouldIgnore(`${name}/track.mp3`)).toBe(true);
    }
  });

  it('AC2/AC14: the active import staging + backup basenames (and files inside) are ABS-ignored', () => {
    const { stagingPath, backupPath } = deriveImportSiblings('/lib/Author/Title');
    for (const name of [basename(stagingPath), basename(backupPath)]) {
      expect(name.startsWith('.')).toBe(true);
      expect(absShouldIgnore(name)).toBe(true);
      expect(absShouldIgnore(`${name}/06 - Royal Assassin.mp3`)).toBe(true);
    }
    // A hidden target intentionally produces a double-dot scratch basename.
    const hidden = deriveImportSiblings('/lib/Author/.Title');
    expect(basename(hidden.stagingPath)).toBe('..Title.import-staging');
    expect(absShouldIgnore(basename(hidden.stagingPath))).toBe(true);
  });
});
