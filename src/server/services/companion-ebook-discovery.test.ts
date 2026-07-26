import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, symlink, realpath, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { findCompanionEbookCandidates } from './companion-ebook-discovery.js';
import { isPersistableCompanionBasename } from './companion-ebook-observation.js';
import { openCompanionEbook } from './companion-ebook-open.js';

/**
 * Real temp directories throughout — the dotfile / subdirectory / symlink / unpersistable-name
 * distinctions are the point. `readdir` and `lstat` are spies delegating to the real
 * implementations so the failure contract can be driven with genuine errnos.
 */
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readdir: vi.fn(actual.readdir), lstat: vi.fn(actual.lstat) };
});

function createMockLogger() {
  const log = {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'debug', silent: vi.fn(),
  };
  return { log: log as unknown as FastifyBaseLogger, spies: log };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: forced by test`), { code });
}

const isLinux = process.platform === 'linux';

describe('findCompanionEbookCandidates', () => {
  let root: string;
  let bookPath: string;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    vi.mocked(readdir).mockClear();
    vi.mocked(lstat).mockClear();
    root = await realpath(mkdtempSync(join(tmpdir(), 'narratorr-1974-disc-')));
    bookPath = join(root, 'Author', 'Title');
    await mkdir(bookPath, { recursive: true });
    logger = createMockLogger();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function call(overrides?: { bookPath?: string }) {
    return findCompanionEbookCandidates(
      { bookId: 7, bookPath: overrides?.bookPath ?? bookPath },
      logger.log,
    );
  }

  async function touch(...names: string[]) {
    for (const name of names) await writeFile(join(bookPath, name), 'x');
  }

  describe('membership', () => {
    it('includes visible top-level regular .epub files, case-insensitively', async () => {
      await touch('book.epub', 'Book.EPUB', 'other.Epub');
      const result = await call();
      expect(result).toEqual({ outcome: 'ok', candidates: ['Book.EPUB', 'book.epub', 'other.Epub'] });
    });

    it('excludes a dotfile', async () => {
      await touch('.book.epub', 'book.epub');
      expect(await call()).toEqual({ outcome: 'ok', candidates: ['book.epub'] });
    });

    it('excludes a non-.epub extension', async () => {
      await touch('book.epub.part', 'cover.jpg', 'book.epub');
      expect(await call()).toEqual({ outcome: 'ok', candidates: ['book.epub'] });
    });

    it('never recurses into a subdirectory', async () => {
      await mkdir(join(bookPath, 'Disc 1'));
      await writeFile(join(bookPath, 'Disc 1', 'other.epub'), 'x');
      await touch('book.epub');
      expect(await call()).toEqual({ outcome: 'ok', candidates: ['book.epub'] });
    });

    it('excludes a directory named x.epub', async () => {
      await mkdir(join(bookPath, 'x.epub'));
      await touch('book.epub');
      expect(await call()).toEqual({ outcome: 'ok', candidates: ['book.epub'] });
    });

    it('excludes a symlinked .epub', async () => {
      await touch('real.epub');
      await symlink(join(bookPath, 'real.epub'), join(bookPath, 'linked.epub'));
      expect(await call()).toEqual({ outcome: 'ok', candidates: ['real.epub'] });
    });

    // AC11 — "temp name" means born-hidden and nothing more. No temp-suffix blocklist.
    it('includes a visible book.tmp.epub and book.part.epub', async () => {
      await touch('book.tmp.epub', 'book.part.epub');
      expect(await call()).toEqual({ outcome: 'ok', candidates: ['book.part.epub', 'book.tmp.epub'] });
    });

    it('returns ok with an empty list for a directory holding no candidates', async () => {
      await touch('cover.jpg');
      expect(await call()).toEqual({ outcome: 'ok', candidates: [] });
    });
  });

  // AC10 term 3 — only creatable on POSIX, which is where production runs (Alpine).
  describe.runIf(isLinux)('unpersistable basenames', () => {
    const unpersistable = ['sub\\book.epub', ' book.epub'];

    it('excludes them even though they are visible, .epub-suffixed regular files', async () => {
      await touch(...unpersistable, 'book.epub');
      expect(await call()).toEqual({ outcome: 'ok', candidates: ['book.epub'] });
    });

    // One domain, three sites: the write boundary, discovery (above), and the opener.
    it.each(unpersistable)('is rejected by filenameSchema and by the opener too: %j', async (name) => {
      await touch(name);
      expect(isPersistableCompanionBasename(name)).toBe(false);
      await expect(
        openCompanionEbook({ bookId: 7, bookPath, filename: name, libraryRoot: root }, logger.log),
      ).resolves.toEqual({ outcome: 'invalid_filename' });
    });

    // F31 — the skip branch an operator cannot diagnose from the panel.
    it('logs exactly one debug record per skipped entry, with no error key', async () => {
      await touch(' book.epub', 'book.epub');
      const result = await call();

      expect(result).toEqual({ outcome: 'ok', candidates: ['book.epub'] });
      expect(logger.spies.debug).toHaveBeenCalledTimes(1);
      const [record] = logger.spies.debug.mock.calls[0] as [Record<string, unknown>, string];
      expect(record).toEqual({ bookId: 7, path: bookPath, filename: ' book.epub' });
      expect(record).not.toHaveProperty('error');
    });
  });

  describe('ordering', () => {
    it('is a total, locale-independent code-point sort', async () => {
      await touch('B.epub', 'a.epub', 'A.epub', '10.epub', '9.epub', 'é.epub');
      const result = await call();

      // The exact case `localeCompare` gets wrong: it ties A/a and orders 9 before 10.
      expect(result).toEqual({
        outcome: 'ok',
        candidates: ['10.epub', '9.epub', 'A.epub', 'B.epub', 'a.epub', 'é.epub'],
      });
    });

    it('is stable across two consecutive calls', async () => {
      await touch('B.epub', 'a.epub', 'A.epub');
      expect(await call()).toEqual(await call());
    });
  });

  describe('failure contract', () => {
    it.each(['ENOENT', 'ENOTDIR'])('maps a readdir %s to gone', async (code) => {
      vi.mocked(readdir).mockRejectedValueOnce(errno(code));
      expect(await call()).toEqual({ outcome: 'gone' });
    });

    it.each(['EACCES', 'EIO'])('maps a readdir %s to undetermined', async (code) => {
      vi.mocked(readdir).mockRejectedValueOnce(errno(code));
      expect(await call()).toEqual({ outcome: 'undetermined' });
    });

    it('maps a code-less readdir throw to undetermined, never gone', async () => {
      vi.mocked(readdir).mockRejectedValueOnce(new Error('ENOENT'));
      expect(await call()).toEqual({ outcome: 'undetermined' });
    });

    it('skips an entry whose lstat ENOENTs and returns ok for the rest', async () => {
      await touch('a.epub', 'b.epub');
      vi.mocked(lstat).mockRejectedValueOnce(errno('ENOENT'));

      expect(await call()).toEqual({ outcome: 'ok', candidates: ['b.epub'] });
    });

    it('makes the WHOLE call undetermined when a per-entry lstat EACCESes', async () => {
      await touch('a.epub', 'b.epub');
      vi.mocked(lstat).mockRejectedValueOnce(errno('EACCES'));

      // Not a partial `ok` list — that is exactly how the reconciler would overwrite a good
      // observation with one that silently dropped an unreadable candidate.
      expect(await call()).toEqual({ outcome: 'undetermined' });
    });
  });

  describe('logging (AC13 — every catch logs before the error is erased)', () => {
    it('logs the readdir failure at debug in the helper shape', async () => {
      vi.mocked(readdir).mockRejectedValueOnce(errno('EACCES'));
      await call();

      expect(logger.spies.debug).toHaveBeenCalledTimes(1);
      const [record] = logger.spies.debug.mock.calls[0] as [Record<string, unknown>, string];
      expect(record).toMatchObject({
        bookId: 7,
        path: bookPath,
        error: expect.objectContaining({ message: expect.stringContaining('EACCES') }),
      });
    });

    it('logs a SKIPPED per-entry ENOENT even though the call still returns ok', async () => {
      await touch('a.epub', 'b.epub');
      vi.mocked(lstat).mockRejectedValueOnce(errno('ENOENT'));

      const result = await call();

      // The branch a "log only on failure" implementation silently drops.
      expect(result.outcome).toBe('ok');
      expect(logger.spies.debug).toHaveBeenCalledTimes(1);
      const [record] = logger.spies.debug.mock.calls[0] as [Record<string, unknown>, string];
      expect(record).toMatchObject({
        bookId: 7,
        path: join(bookPath, 'a.epub'),
        error: expect.objectContaining({ message: expect.stringContaining('ENOENT') }),
      });
    });

    it('never logs above debug', async () => {
      vi.mocked(readdir).mockRejectedValueOnce(errno('EIO'));
      await call();
      expect(logger.spies.info).not.toHaveBeenCalled();
      expect(logger.spies.warn).not.toHaveBeenCalled();
      expect(logger.spies.error).not.toHaveBeenCalled();
    });
  });
});
