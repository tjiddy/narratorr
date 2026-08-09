import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, symlink, realpath, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { findCompanionEbookCandidates } from './companion-ebook-discovery.js';
import { isPersistableCompanionBasename } from './companion-ebook-observation.js';
import { openCompanionEbook } from './companion-ebook-open.js';
import { CAN_SYMLINK } from '../__tests__/windows-fs.js';

// Case-only names cannot coexist on case-insensitive filesystems.
const CASE_SENSITIVE_FS = process.platform !== 'win32';

// Use real temp entries; spy only readdir and lstat to inject filesystem failures.
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

/**
 * Match enumerable keys: ordinary matchers can read Error.message and falsely accept a raw Error,
 * which Pino would serialize without that non-enumerable detail.
 */
function expectSerializedError(logged: unknown, original: Error, expected: { code?: string }): void {
  expect(logged).not.toBe(original);
  expect(logged).not.toBeInstanceOf(Error);
  expect(Object.keys(logged as object).sort()).toEqual(
    expected.code === undefined ? ['message', 'stack', 'type'] : ['code', 'message', 'stack', 'type'],
  );
  expect(logged).toEqual({
    message: original.message,
    stack: expect.stringContaining(original.message),
    type: 'Error',
    ...(expected.code !== undefined && { code: expected.code }),
  });
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
    it.skipIf(!CASE_SENSITIVE_FS)('includes visible top-level regular .epub files, case-insensitively', async () => {
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

    it.skipIf(!CAN_SYMLINK)('excludes a symlinked .epub', async () => {
      await touch('real.epub');
      await symlink(join(bookPath, 'real.epub'), join(bookPath, 'linked.epub'));
      expect(await call()).toEqual({ outcome: 'ok', candidates: ['real.epub'] });
    });

    // "Temp name" means born-hidden only; there is no temp-suffix blocklist.
    it('includes a visible book.tmp.epub and book.part.epub', async () => {
      await touch('book.tmp.epub', 'book.part.epub');
      expect(await call()).toEqual({ outcome: 'ok', candidates: ['book.part.epub', 'book.tmp.epub'] });
    });

    it('returns ok with an empty list for a directory holding no candidates', async () => {
      await touch('cover.jpg');
      expect(await call()).toEqual({ outcome: 'ok', candidates: [] });
    });
  });

  // These legal POSIX basenames are only creatable where production runs, not on NTFS.
  describe.runIf(isLinux)('unpersistable basenames', () => {
    const unpersistable = ['sub\\book.epub', ' book.epub'];

    it('excludes them even though they are visible, .epub-suffixed regular files', async () => {
      await touch(...unpersistable, 'book.epub');
      expect(await call()).toEqual({ outcome: 'ok', candidates: ['book.epub'] });
    });

    it.each(unpersistable)('is rejected by filenameSchema and by the opener too: %j', async (name) => {
      await touch(name);
      expect(isPersistableCompanionBasename(name)).toBe(false);
      await expect(
        openCompanionEbook({ bookId: 7, bookPath, filename: name, libraryRoot: root }, logger.log),
      ).resolves.toEqual({ outcome: 'invalid_filename' });
    });

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
    it.skipIf(!CASE_SENSITIVE_FS)('is a total, locale-independent code-point sort', async () => {
      await touch('B.epub', 'a.epub', 'A.epub', '10.epub', '9.epub', 'é.epub');
      const result = await call();

      // localeCompare ties A/a and sorts 9 before 10.
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

      // Partial success could overwrite a complete prior observation.
      expect(await call()).toEqual({ outcome: 'undetermined' });
    });
  });

  describe('logging (AC13 — every catch logs before the error is erased)', () => {
    it('logs the readdir failure at debug, with the error serialized', async () => {
      const failure = errno('EACCES');
      vi.mocked(readdir).mockRejectedValueOnce(failure);
      await call();

      expect(logger.spies.debug).toHaveBeenCalledTimes(1);
      const [record] = logger.spies.debug.mock.calls[0] as [Record<string, unknown>, string];
      expect(record).toMatchObject({ bookId: 7, path: bookPath });
      // This log is the only surviving cause because the result union discards it.
      expectSerializedError(record.error, failure, { code: 'EACCES' });
    });

    it('logs a SKIPPED per-entry ENOENT, with the error serialized, even though the call still returns ok', async () => {
      await touch('a.epub', 'b.epub');
      const failure = errno('ENOENT');
      vi.mocked(lstat).mockRejectedValueOnce(failure);

      const result = await call();

      expect(result.outcome).toBe('ok');
      expect(logger.spies.debug).toHaveBeenCalledTimes(1);
      const [record] = logger.spies.debug.mock.calls[0] as [Record<string, unknown>, string];
      expect(record).toMatchObject({ bookId: 7, path: join(bookPath, 'a.epub') });
      expectSerializedError(record.error, failure, { code: 'ENOENT' });
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
