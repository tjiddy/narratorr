import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, symlink, realpath, lstat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import { openCompanionEbook } from './companion-ebook-open.js';

/**
 * Driven against a REAL temp directory, never an `fs` mock: the symlink / regular-file /
 * parent-escape distinctions this helper exists to make are exactly the ones a mock erases.
 * `lstat` and `open` are wrapped in spies that delegate to the real implementations, so the
 * "no syscall issued" and forced-errno cases are expressible without faking the filesystem.
 */
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

function createMockLogger() {
  const log = {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'debug', silent: vi.fn(),
  };
  return { log: log as unknown as FastifyBaseLogger, spies: log };
}

/** Recursively collect every string leaf of a log record. */
function stringLeaves(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, acc);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringLeaves(v, acc);
  return acc;
}

/**
 * Assert a logged `error` value is the output of `serializeError`, not the caught `Error`.
 *
 * The own-ENUMERABLE key set is what makes this discriminating. On a real `Error`, `message`
 * and `stack` are non-enumerable, so `Object.keys(rawError)` yields only the assigned `code`;
 * a `toMatchObject`/`objectContaining({ message })` matcher reads through to the non-enumerable
 * property and passes on a raw `Error` too, which is exactly the hole this closes. Pino
 * serializes own-enumerable properties only, so the key set is also what actually reaches the
 * log line. Mirrors the repository precedent at `indexer-search.service.test.ts:715-724`.
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

describe('openCompanionEbook', () => {
  let root: string;
  let bookPath: string;
  let outside: string;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    vi.mocked(lstat).mockClear();
    vi.mocked(open).mockClear();
    // `realpath` the temp roots up front: macOS resolves /var → /private/var, which would
    // otherwise make every containment check fail for the wrong reason.
    root = await realpath(mkdtempSync(join(tmpdir(), 'narratorr-1974-lib-')));
    outside = await realpath(mkdtempSync(join(tmpdir(), 'narratorr-1974-out-')));
    bookPath = join(root, 'Author', 'Title');
    await mkdir(bookPath, { recursive: true });
    logger = createMockLogger();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  function call(filename: string, overrides?: { bookPath?: string }) {
    return openCompanionEbook(
      { bookId: 42, bookPath: overrides?.bookPath ?? bookPath, filename, libraryRoot: root },
      logger.log,
    );
  }

  describe('ok', () => {
    it('opens a regular .epub inside the root and reports the real size', async () => {
      const bytes = 'PK companion bytes';
      await writeFile(join(bookPath, 'book.epub'), bytes);
      const result = await call('book.epub');

      expect(result.outcome).toBe('ok');
      if (result.outcome !== 'ok') return;
      expect(result.sizeBytes).toBe(Buffer.byteLength(bytes));
      await result.handle.close();
    });
  });

  describe('not_regular_file', () => {
    it('rejects a symlink whose target is outside the root', async () => {
      await writeFile(join(outside, 'secret.epub'), 'secret');
      await symlink(join(outside, 'secret.epub'), join(bookPath, 'book.epub'));

      // The discriminator, NOT "the open throws" and NOT a dev/ino comparison.
      await expect(call('book.epub')).resolves.toEqual({ outcome: 'not_regular_file' });
    });

    it('rejects a symlink whose target is inside the root', async () => {
      await writeFile(join(bookPath, 'real.epub'), 'real');
      await symlink(join(bookPath, 'real.epub'), join(bookPath, 'book.epub'));

      await expect(call('book.epub')).resolves.toEqual({ outcome: 'not_regular_file' });
    });

    it('rejects a directory', async () => {
      await mkdir(join(bookPath, 'book.epub'));
      await expect(call('book.epub')).resolves.toEqual({ outcome: 'not_regular_file' });
    });

    it.runIf(isLinux)('rejects a FIFO', async () => {
      execFileSync('mkfifo', [join(bookPath, 'book.epub')]);
      await expect(call('book.epub')).resolves.toEqual({ outcome: 'not_regular_file' });
    });
  });

  describe('outside_library', () => {
    it('rejects a parent-directory symlink escape', async () => {
      // <root>/escape is a symlink to a real folder outside the root holding a real book.epub.
      const externalBook = join(outside, 'Title');
      await mkdir(externalBook, { recursive: true });
      await writeFile(join(externalBook, 'book.epub'), 'outside bytes');
      await symlink(externalBook, join(root, 'escape'));

      // The final component IS a regular file; only canonicalising the full path catches this.
      const result = await call('book.epub', { bookPath: join(root, 'escape') });
      expect(result).toEqual({ outcome: 'outside_library' });
    });

    it('rejects a book path lexically outside the root', async () => {
      await writeFile(join(outside, 'book.epub'), 'outside bytes');
      const result = await call('book.epub', { bookPath: outside });
      expect(result).toEqual({ outcome: 'outside_library' });
    });
  });

  describe('invalid_filename', () => {
    // Same set as the discovery exclusions — AC3 and AC10 term 3 call one predicate.
    const rejected = ['', 'a/b.epub', 'a\\b.epub', ' book.epub', 'book.epub ', '.', '..'];

    it.each(rejected)('rejects %j with no syscall issued', async (filename) => {
      await expect(call(filename)).resolves.toEqual({ outcome: 'invalid_filename' });
      expect(vi.mocked(lstat)).not.toHaveBeenCalled();
      expect(vi.mocked(open)).not.toHaveBeenCalled();
    });
  });

  describe('missing', () => {
    it('classifies an already-vanished file as missing at the lstat step', async () => {
      await expect(call('book.epub')).resolves.toEqual({ outcome: 'missing' });
    });

    // The case that actually exercises the ENOENT-REJECTING containment variant. The test
    // above exits at `lstat` and never reaches it, so on its own it cannot tell the strict
    // guard from the legacy swallow-on-ENOENT sibling.
    it('rejects a file that disappears between a successful lstat and the containment check', async () => {
      const filePath = join(bookPath, 'book.epub');
      await writeFile(filePath, 'bytes');
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(lstat).mockImplementationOnce((async (target: string) => {
        const stats = await actual.lstat(target);
        await actual.rm(target); // vanishes before containment canonicalises the path
        return stats;
      }) as unknown as typeof lstat);

      await expect(call('book.epub')).resolves.toEqual({ outcome: 'missing' });

      // THE discriminator. `assertRealPathInsideLibraryStrict` propagates the realpath ENOENT,
      // so the helper classifies and returns without ever opening. Swap in the legacy
      // `assertRealPathInsideLibrary` and the ENOENT is swallowed, containment "passes", and
      // `open` runs — same `missing` outcome, so only this assertion catches the regression.
      expect(vi.mocked(open)).not.toHaveBeenCalled();
    });

    it('classifies a book path that is not a directory as missing (ENOTDIR)', async () => {
      const filePath = join(bookPath, 'notadir');
      await writeFile(filePath, 'x');
      await expect(call('book.epub', { bookPath: filePath })).resolves.toEqual({ outcome: 'missing' });
    });
  });

  describe('unreadable', () => {
    it('classifies EACCES as unreadable', async () => {
      await writeFile(join(bookPath, 'book.epub'), 'bytes');
      const eacces = Object.assign(new Error(`EACCES: permission denied, open '${join(bookPath, 'book.epub')}'`), {
        code: 'EACCES',
      });
      vi.mocked(open).mockRejectedValueOnce(eacces);

      await expect(call('book.epub')).resolves.toEqual({ outcome: 'unreadable' });
    });

    it('classifies a code-less throw as unreadable, never missing', async () => {
      await writeFile(join(bookPath, 'book.epub'), 'bytes');
      vi.mocked(open).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(call('book.epub')).resolves.toEqual({ outcome: 'unreadable' });
    });
  });

  describe('descriptor ownership', () => {
    it('leaves no open descriptor on a post-open failure', async () => {
      const filePath = join(bookPath, 'book.epub');
      await writeFile(filePath, 'bytes');

      const closeSpy = vi.fn();
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        const originalClose = handle.close.bind(handle);
        handle.close = async () => { closeSpy(); return originalClose(); };
        handle.stat = (() =>
          Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }))) as typeof handle.stat;
        return handle;
      });

      await expect(call('book.epub')).resolves.toEqual({ outcome: 'unreadable' });
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('hands the caller an open, readable handle on ok', async () => {
      await writeFile(join(bookPath, 'book.epub'), 'companion bytes');
      const result = await call('book.epub');
      expect(result.outcome).toBe('ok');
      if (result.outcome !== 'ok') return;
      const buffer = await result.handle.readFile();
      expect(buffer.toString()).toBe('companion bytes');
      await result.handle.close();
    });
  });

  describe('logging (AC7, helper half)', () => {
    it('logs a caught error at debug in the sibling shape, with the path preserved', async () => {
      const filePath = join(bookPath, 'book.epub');
      await writeFile(filePath, 'bytes');
      // A REAL Node-shaped EACCES whose message and stack embed the path: the record must
      // still serialize. A path-free `serializeError` is not expressible (F16).
      const eacces = Object.assign(new Error(`EACCES: permission denied, open '${filePath}'`), { code: 'EACCES' });
      vi.mocked(open).mockRejectedValueOnce(eacces);

      await call('book.epub');

      expect(logger.spies.debug).toHaveBeenCalledTimes(1);
      const [record] = logger.spies.debug.mock.calls[0] as [Record<string, unknown>, string];
      expect(record).toMatchObject({ bookId: 42, path: filePath });

      // The load-bearing half: `error` is the SERIALIZED plain object, not the caught Error.
      expectSerializedError(record.error, eacces, { code: 'EACCES' });

      // …and the serialized record still carries the path verbatim in both message and stack,
      // which is the point F16 settled: a path-free `serializeError` is not expressible.
      expect(stringLeaves(record.error).join('\n')).toContain(filePath);
      expect(logger.spies.warn).not.toHaveBeenCalled();
      expect(logger.spies.error).not.toHaveBeenCalled();
    });

    // AC2's never-throws guarantee reaches the cleanup path too: abandoning a handle whose
    // own `close()` rejects must still resolve to the classified outcome and still log.
    it('absorbs and serializes a rejection from closing an abandoned handle', async () => {
      const filePath = join(bookPath, 'book.epub');
      await writeFile(filePath, 'bytes');
      const closeError = Object.assign(new Error('EBADF: bad file descriptor, close'), { code: 'EBADF' });
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        await handle.close(); // release the real descriptor; the test drives the failure below
        handle.stat = (() =>
          Promise.reject(Object.assign(new Error('EIO: i/o error, fstat'), { code: 'EIO' }))) as typeof handle.stat;
        handle.close = () => Promise.reject(closeError);
        return handle;
      });

      // Never throws — the close rejection does not escape as an unhandled reason.
      await expect(call('book.epub')).resolves.toEqual({ outcome: 'unreadable' });

      const closeRecord = logger.spies.debug.mock.calls.find(
        ([, message]) => typeof message === 'string' && message.includes('handle close failed'),
      ) as [Record<string, unknown>, string] | undefined;
      expect(closeRecord).toBeDefined();
      expect(closeRecord![0]).toMatchObject({ bookId: 42, path: filePath });
      expectSerializedError(closeRecord![0].error, closeError, { code: 'EBADF' });
      expect(logger.spies.warn).not.toHaveBeenCalled();
      expect(logger.spies.error).not.toHaveBeenCalled();
    });

    it('never logs above debug', async () => {
      await call('book.epub'); // missing
      await call('a/b.epub');  // invalid_filename
      expect(logger.spies.info).not.toHaveBeenCalled();
      expect(logger.spies.warn).not.toHaveBeenCalled();
      expect(logger.spies.error).not.toHaveBeenCalled();
    });
  });
});
