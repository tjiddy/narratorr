import { describe, it, expect } from 'vitest';
import {
  normalizeArchivePath,
  decodeEntryName,
  findDuplicateEntry,
  resolveHref,
} from './paths.js';

describe('normalizeArchivePath', () => {
  const rejected: Array<[label: string, raw: string]> = [
    ['POSIX-absolute', '/abs'],
    ['drive-absolute with forward slash', 'C:/abs'],
    ['drive-absolute with backslash', 'C:\\abs'],
    ['UNC', '\\\\host\\share\\x'],
    ['leading traversal', '../x'],
    ['escaping traversal', 'a/../../b'],
    // The collapsible case: `path.posix.normalize('a/../b')` is `'b'`, so a
    // normalise-then-scan implementation would silently accept this.
    ['collapsible traversal', 'a/../b'],
    ['interior backslash', 'a\\b'],
    ['NUL byte', 'a\x00b'],
    ['C0 control', 'a\x1fb'],
    ['normalises to empty', './'],
    ['bare dot', '.'],
    ['empty string', ''],
  ];

  it.each(rejected)('rejects %s', (_label, raw) => {
    expect(normalizeArchivePath(raw)).toEqual({ kind: 'rejected', reason: 'unsafe_entry_path' });
  });

  const accepted: Array<[raw: string, name: string]> = [
    ['OEBPS/ch1.xhtml', 'OEBPS/ch1.xhtml'],
    ['./OEBPS/ch1.xhtml', 'OEBPS/ch1.xhtml'],
    ['OEBPS//ch1.xhtml', 'OEBPS/ch1.xhtml'],
    ['a/./b', 'a/b'],
  ];

  it.each(accepted)('accepts %s as %s', (raw, name) => {
    expect(normalizeArchivePath(raw)).toEqual({ kind: 'entry', name });
  });

  it('accepts a member literally named `unsafe_entry_path`', () => {
    // The rejection literal is itself a legal relative archive member name. A
    // `string`-returning implementation cannot pass this alongside the
    // rejection rows above.
    expect(normalizeArchivePath('unsafe_entry_path')).toEqual({
      kind: 'entry',
      name: 'unsafe_entry_path',
    });
  });

  it('returns a POSIX archive key with no backslash, asserted on the raw value', () => {
    // Deliberately NOT `.split('\\').join('/')` — this function's contract is a
    // platform-independent POSIX archive key, so a backslash in its output is
    // the defect under test, not a platform artefact. Laundering the actual
    // value would make a buggy implementation pass on Windows.
    const result = normalizeArchivePath('OEBPS/ch1.xhtml');
    expect(result.kind).toBe('entry');
    if (result.kind !== 'entry') return;
    expect(result.name).toBe('OEBPS/ch1.xhtml');
    expect(result.name).not.toContain('\\');
  });
});

describe('decodeEntryName', () => {
  const MALFORMED = Buffer.from([0x61, 0xff, 0xfe, 0x62]);

  it('rejects malformed UTF-8', () => {
    expect(decodeEntryName(MALFORMED)).toEqual({
      kind: 'rejected',
      reason: 'unsafe_entry_path',
    });
  });

  it('is why the fatal decoder exists — the non-fatal path silently substitutes U+FFFD', () => {
    // unzipper's own `File.path` is produced by exactly this non-fatal call, so
    // it would index and duplicate-check a name the OCF spec means to reject.
    expect(MALFORMED.toString('utf8')).toContain('\uFFFD');
  });

  it('round-trips a valid multi-byte name', () => {
    expect(decodeEntryName(Buffer.from('Chapitre-é.xhtml', 'utf8'))).toEqual({
      kind: 'entry',
      name: 'Chapitre-é.xhtml',
    });
  });

  it('decodes bytes spelling `unsafe_entry_path` successfully', () => {
    // The companion to the normaliser's collision case: the discriminant, not
    // the string value, carries the outcome.
    expect(decodeEntryName(Buffer.from('unsafe_entry_path', 'utf8'))).toEqual({
      kind: 'entry',
      name: 'unsafe_entry_path',
    });
  });
});

describe('findDuplicateEntry', () => {
  it('reports the clean case', () => {
    expect(findDuplicateEntry(['a.xhtml', 'b.xhtml', 'OEBPS/c.xhtml'])).toEqual({ kind: 'unique' });
  });

  it('reports an empty list as clean', () => {
    expect(findDuplicateEntry([])).toEqual({ kind: 'unique' });
  });

  it('fires on two exactly-identical normalised names', () => {
    expect(findDuplicateEntry(['a.xhtml', 'b.xhtml', 'a.xhtml'])).toEqual({
      kind: 'duplicate',
      reason: 'duplicate_entry',
      name: 'a.xhtml',
    });
  });

  it('does not case-fold', () => {
    // Nothing in Phase 1 writes an archive member to disk, so a case collision
    // is harmless and folding would reject legitimate archives.
    expect(findDuplicateEntry(['A.xhtml', 'a.xhtml'])).toEqual({ kind: 'unique' });
  });
});

describe('resolveHref — base joining and decoding', () => {
  it('resolves against a package directory', () => {
    expect(resolveHref('OEBPS', 'Images/cover.png')).toEqual({
      kind: 'entry',
      name: 'OEBPS/Images/cover.png',
    });
  });

  it('resolves against the container root', () => {
    expect(resolveHref('', 'OEBPS/content.opf')).toEqual({
      kind: 'entry',
      name: 'OEBPS/content.opf',
    });
  });

  it('collapses an interior traversal that stays inside the root', () => {
    expect(resolveHref('OEBPS/Text', '../Images/c.png')).toEqual({
      kind: 'entry',
      name: 'OEBPS/Images/c.png',
    });
  });

  it('accepts a traversal that lands inside the container root — containment is against the root, not the base', () => {
    // `path.posix.join('OEBPS', '../secret')` is `'secret'`, which is inside the
    // archive. Reading `..` as automatically unsafe is reading baseDir
    // containment where the contract says root containment.
    expect(resolveHref('OEBPS', '../secret')).toEqual({ kind: 'entry', name: 'secret' });
  });

  it('percent-decodes once', () => {
    expect(resolveHref('OEBPS', 'Text/My%20Chapter.xhtml')).toEqual({
      kind: 'entry',
      name: 'OEBPS/Text/My Chapter.xhtml',
    });
    expect(resolveHref('OEBPS', '%C3%A9.xhtml')).toEqual({ kind: 'entry', name: 'OEBPS/é.xhtml' });
  });

  it('strips the fragment and the query', () => {
    expect(resolveHref('OEBPS', 'ch1.xhtml#s2')).toEqual({ kind: 'entry', name: 'OEBPS/ch1.xhtml' });
    expect(resolveHref('OEBPS', 'ch1.xhtml?v=2')).toEqual({ kind: 'entry', name: 'OEBPS/ch1.xhtml' });
  });

  it('rejects a value that is empty after stripping', () => {
    expect(resolveHref('OEBPS', '#frag')).toEqual({ kind: 'rejected', reason: 'unsafe_entry_path' });
  });
});

describe('resolveHref — remote values', () => {
  const remote = ['https://x/a.png', '//x/a.png', 'data:image/png;base64,AAAA', 'ws://x/a', 'mailto:a@b'];

  it.each(remote)('treats %s as remote', (raw) => {
    expect(resolveHref('OEBPS', raw)).toEqual({ kind: 'remote' });
  });
});

describe('resolveHref — the step-4 absolute matrix', () => {
  // Each absolute form must reject under BOTH bases. The non-empty-base rows are
  // the ones that fail a step-4-less implementation: `path.posix.join('OEBPS',
  // 'C:/a')` is `'OEBPS/C:/a'` and `path.posix.join('OEBPS', '/a')` is
  // `'OEBPS/a'`, both of which normalizeArchivePath accepts.
  const absolute = ['C:/a', 'C:%2Fa', 'C:\\a', 'C:', '/a', 'x:chapter.xhtml'];
  const bases = ['', 'OEBPS'];
  const matrix = bases.flatMap((base) => absolute.map((raw): [string, string] => [base, raw]));

  it.each(matrix)('rejects base %j href %j', (base, raw) => {
    expect(resolveHref(base, raw)).toEqual({ kind: 'rejected', reason: 'unsafe_entry_path' });
  });

  it('never lets the [A-Za-z]: family become an archive key', () => {
    // The governing invariant. Both non-entry arms are safe — `remote` means
    // "not in this archive", `rejected` means "not usable" — so the security
    // property does not depend on which arm a given spelling lands in.
    const family = ['C:/a', 'C:%2Fa', 'C:\\a', 'C:', 'x:chapter.xhtml', 'X:/a'];
    const kinds = bases.flatMap((base) => family.map((raw) => resolveHref(base, raw).kind));
    expect(kinds).not.toContain('entry');
  });
});

describe('resolveHref — containment rejections', () => {
  it('rejects a decoded traversal from the container root', () => {
    // Proves decode-before-normalise: a normalise-first implementation sees no
    // `..` and admits the literal encoded name.
    expect(resolveHref('', '%2e%2e/secret')).toEqual({
      kind: 'rejected',
      reason: 'unsafe_entry_path',
    });
    expect(resolveHref('', '%2e%2e%2fsecret')).toEqual({
      kind: 'rejected',
      reason: 'unsafe_entry_path',
    });
  });

  it('rejects a raw traversal that escapes the container root', () => {
    expect(resolveHref('', '../../outside')).toEqual({
      kind: 'rejected',
      reason: 'unsafe_entry_path',
    });
  });

  it('rejects a malformed percent escape', () => {
    expect(resolveHref('', '%ZZ')).toEqual({ kind: 'rejected', reason: 'unsafe_entry_path' });
  });

  it('rejects a decoded backslash', () => {
    expect(resolveHref('OEBPS', 'Text%5C..%5Cx')).toEqual({
      kind: 'rejected',
      reason: 'unsafe_entry_path',
    });
  });
});
