import { describe, expect, it } from 'vitest';
import { toShortErrorText } from './short-error-text.js';
import { RenameError } from '../services/rename.service.js';
import { RetagError } from '../services/tagging.service.js';

function makeEnoent(): NodeJS.ErrnoException {
  return Object.assign(
    new Error("ENOENT: no such file or directory, open '/audiobooks/Jim Butcher/Codex Alera/04 - Captain's Fury/metadata.opf'"),
    { code: 'ENOENT' },
  );
}

describe('toShortErrorText (#2159)', () => {
  describe('AC13 step 3 — composition', () => {
    it('uses the message alone when it already begins with the code (no doubled ENOENT prefix)', () => {
      const text = toShortErrorText(makeEnoent());
      expect(text).toBe("ENOENT: no such file or directory, open '/audiobooks/Jim Butcher/Codex Alera/04 - Captain's Fury/metadata.opf'");
      expect(text).toContain('ENOENT');
      expect(text).not.toContain('ENOENT: ENOENT');
    });

    it('uses the message alone when it is exactly the code', () => {
      expect(toShortErrorText(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))).toBe('ENOENT');
    });

    it('still prefixes when the message merely starts with the code as a longer word', () => {
      expect(toShortErrorText(Object.assign(new Error('ENOENTX blew up'), { code: 'ENOENT' })))
        .toBe('ENOENT: ENOENTX blew up');
    });

    it('prefixes a RenameError with its code', () => {
      expect(toShortErrorText(new RenameError('Target folder already exists', 'CONFLICT')))
        .toBe('CONFLICT: Target folder already exists');
    });

    it.each(['TARGET_OCCUPIED', 'STALE_PATH'] as const)('prefixes the %s RenameError code the same way', (code) => {
      expect(toShortErrorText(new RenameError('Target path "/library/Y" is a non-empty directory', code)))
        .toBe(`${code}: Target path "/library/Y" is a non-empty directory`);
    });

    it('prefixes a RetagError with its code', () => {
      expect(toShortErrorText(new RetagError('PATH_MISSING', 'Book folder no longer exists on disk')))
        .toBe('PATH_MISSING: Book folder no longer exists on disk');
    });

    it('returns the code alone when there is no message', () => {
      expect(toShortErrorText(Object.assign(new Error(''), { code: 'EACCES' }))).toBe('EACCES');
    });

    it("falls back to 'Unknown error' when code and message are both empty", () => {
      expect(toShortErrorText(Object.assign(new Error(''), { code: '' }))).toBe('Unknown error');
    });

    it("falls back to 'Unknown error' when code and message are whitespace-only", () => {
      expect(toShortErrorText(Object.assign(new Error('   '), { code: '  ' }))).toBe('Unknown error');
    });

    it('trims the composed fields so no output has leading or trailing whitespace', () => {
      const text = toShortErrorText(Object.assign(new Error('  spaced out  '), { code: '  EBUSY ' }));
      expect(text).toBe('EBUSY: spaced out');
    });
  });

  describe('AC13 step 2 — one-level, field-wise cause preference', () => {
    it('prefers the undici cause over the generic top-level `fetch failed`', () => {
      const cause = Object.assign(new Error('getaddrinfo ENOTFOUND host'), { code: 'ENOTFOUND' });
      expect(toShortErrorText(new TypeError('fetch failed', { cause })))
        .toBe('ENOTFOUND: getaddrinfo ENOTFOUND host');
    });

    it('keeps the top-level message when the cause carries only a code', () => {
      const cause = Object.assign(new Error(''), { code: 'EACCES' });
      const outer = new Error('Could not write metadata.opf for book 226', { cause });
      expect(toShortErrorText(outer)).toBe('EACCES: Could not write metadata.opf for book 226');
    });

    it('keeps the top-level code when the cause carries only a message', () => {
      const outer = Object.assign(new Error('outer message', { cause: new Error('deeper detail') }), { code: 'EPIPE' });
      expect(toShortErrorText(outer)).toBe('EPIPE: deeper detail');
    });
  });

  describe('AC13 step 4 — redact the composed string, then bound it', () => {
    it('redacts a secret reachable only through the code (serializeError copies code verbatim)', () => {
      const err = Object.assign(new Error('boom'), { code: 'https://host/x?apikey=SECRET' });
      const text = toShortErrorText(err);
      expect(text).not.toContain('SECRET');
      expect(text).not.toContain('apikey');
    });

    it('redacts a URL embedded in the message while retaining the surrounding prose', () => {
      const text = toShortErrorText(new Error('Failed to fetch https://covers.example.com/c.jpg?apikey=SECRET while reconciling'));
      expect(text).not.toContain('SECRET');
      expect(text).toContain('Failed to fetch');
      expect(text).toContain('while reconciling');
      expect(text).toContain('https://covers.example.com/c.jpg');
    });

    it('truncates a 201-character result to exactly 200 characters ending in an ellipsis', () => {
      const text = toShortErrorText('a'.repeat(201));
      expect(text).toHaveLength(200);
      expect(text.endsWith('…')).toBe(true);
      expect(text.slice(0, 199)).toBe('a'.repeat(199));
    });

    it('returns a 200-character result unchanged', () => {
      const text = toShortErrorText('b'.repeat(200));
      expect(text).toHaveLength(200);
      expect(text).toBe('b'.repeat(200));
    });

    it('bounds the composed string, not the message alone (code prefix counts toward the limit)', () => {
      const err = Object.assign(new Error('c'.repeat(200)), { code: 'EBADF' });
      const text = toShortErrorText(err);
      expect(text).toHaveLength(200);
      expect(text.startsWith('EBADF: ')).toBe(true);
      expect(text.endsWith('…')).toBe(true);
    });
  });

  describe('AC13 — the stack is never read', () => {
    it('omits stack frames entirely', () => {
      const err = new Error('boom');
      err.stack = 'Error: boom\n    at zzzDistinctiveFrameMarker (/app/src/server/utils/short-error-text.ts:1:1)';
      const text = toShortErrorText(err);
      expect(text).toBe('boom');
      expect(text).not.toContain('zzzDistinctiveFrameMarker');
      expect(text).not.toContain('    at ');
      expect(text).not.toContain('\n');
    });
  });

  describe('non-Error inputs', () => {
    it('passes a plain string through with no code prefix (the composed AC11 sidecar reason)', () => {
      expect(toShortErrorText('OPF write failed; Cover download failed')).toBe('OPF write failed; Cover download failed');
    });

    it('redacts a URL embedded in a plain string', () => {
      const text = toShortErrorText('Remote cover download returned non-OK status 403 for https://host/c.jpg?apikey=SECRET');
      expect(text).not.toContain('SECRET');
      expect(text).toContain('non-OK status 403');
    });

    it("returns 'Unknown error' for an empty string", () => {
      expect(toShortErrorText('')).toBe('Unknown error');
    });

    it('stringifies other primitives', () => {
      expect(toShortErrorText(42)).toBe('42');
      expect(toShortErrorText(null)).toBe('null');
    });
  });
});
