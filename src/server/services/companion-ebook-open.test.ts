import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, symlink, realpath, lstat, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import { openCompanionEbook, resolveCompanionEbookPath } from './companion-ebook-open.js';
import { CAN_SYMLINK } from '../__tests__/windows-fs.js';
import { READ_NO_FOLLOW } from '../../core/utils/no-follow-open.js';

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

    /**
     * Containment is verified against a PATHNAME, and the open below is a second resolution of
     * it. Both tests here defend the gap between those two steps; the first runs everywhere and
     * catches a regression to `'r'`, the second proves the flag actually refuses the swap.
     */
    it('opens with O_NOFOLLOW rather than a symlink-following read flag', async () => {
      await writeFile(join(bookPath, 'book.epub'), 'x');
      const result = await call('book.epub');

      expect(result.outcome).toBe('ok');
      expect(open).toHaveBeenCalledWith(join(bookPath, 'book.epub'), READ_NO_FOLLOW);
      if (result.outcome === 'ok') await result.handle.close();
    });

    /**
     * The half of the TOCTOU defence that is OURS to prove, and it runs on every platform.
     * `O_NOFOLLOW → ELOOP on a symlink` is POSIX's contract, not this module's; what this
     * module owes is that the resulting errno becomes a refusal rather than a served file.
     * The end-to-end case below needs a real symlink AND a real flag, so it can only run on
     * Linux — without this test, the classification would ship unproven on Todd's machine.
     */
    it('classifies an ELOOP from the open as unreadable, never as a served handle', async () => {
      await writeFile(join(bookPath, 'book.epub'), 'x');
      vi.mocked(open).mockRejectedValueOnce(
        Object.assign(new Error('ELOOP: too many symbolic links'), { code: 'ELOOP' }),
      );

      await expect(call('book.epub')).resolves.toEqual({ outcome: 'unreadable' });
    });

    it.skipIf(!CAN_SYMLINK || !constants.O_NOFOLLOW)(
      'refuses the open when the verified path becomes a symlink before it (TOCTOU, Linux only)',
      async () => {
        const secret = join(outside, 'secret.key');
        await writeFile(secret, 'SUPER-SECRET-KEY-MATERIAL');
        const path = join(bookPath, 'book.epub');
        await writeFile(path, 'a real epub at verification time');

        // The race, made deterministic: resolve() has already lstat'd a regular file and
        // realpath'd it inside the root. Swapping HERE — after the checks, before the open —
        // is exactly the window an attacker with write access to the book folder gets.
        const { open: actualOpen } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        vi.mocked(open).mockImplementationOnce(async (...args) => {
          await rm(path);
          await symlink(secret, path);
          return actualOpen(...(args as Parameters<typeof actualOpen>));
        });

        const result = await call('book.epub');

        // ELOOP is not definitive absence, so `classifyFailure` reports `unreadable` and the
        // route 404s. The bytes of `secret` must never reach a handle.
        expect(result.outcome).toBe('unreadable');
      },
    );
  });

  describe('not_regular_file', () => {
    it.skipIf(!CAN_SYMLINK)('rejects a symlink whose target is outside the root', async () => {
      await writeFile(join(outside, 'secret.epub'), 'secret');
      await symlink(join(outside, 'secret.epub'), join(bookPath, 'book.epub'));

      // The discriminator, NOT "the open throws" and NOT a dev/ino comparison.
      await expect(call('book.epub')).resolves.toEqual({ outcome: 'not_regular_file' });
    });

    it.skipIf(!CAN_SYMLINK)('rejects a symlink whose target is inside the root', async () => {
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
    it.skipIf(!CAN_SYMLINK)('rejects a parent-directory symlink escape', async () => {
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

/**
 * `resolveCompanionEbookPath` (#1976 AC1) — the verification prefix `openCompanionEbook` now
 * composes, and the sole path-construction site the two read routes and the selection
 * mutation all reach.
 *
 * Driven against the same real temp directories for the same reason: the symlink /
 * regular-file / parent-escape distinctions are the ones a mock erases. Every case asserts
 * `open` was never called — the resolver's whole point is that it verifies WITHOUT taking a
 * descriptor, so `inspectEpub` can open the archive by pathname itself (AC3).
 */
describe('resolveCompanionEbookPath', () => {
  let root: string;
  let bookPath: string;
  let outside: string;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    vi.mocked(lstat).mockClear();
    vi.mocked(open).mockClear();
    root = await realpath(mkdtempSync(join(tmpdir(), 'narratorr-1976-lib-')));
    outside = await realpath(mkdtempSync(join(tmpdir(), 'narratorr-1976-out-')));
    bookPath = join(root, 'Author', 'Title');
    await mkdir(bookPath, { recursive: true });
    logger = createMockLogger();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  function resolve(filename: string, overrides?: { bookPath?: string }) {
    return resolveCompanionEbookPath(
      { bookId: 42, bookPath: overrides?.bookPath ?? bookPath, filename, libraryRoot: root },
      logger.log,
    );
  }

  /**
   * The AC1 "no descriptor" invariant. The resolver issues `lstat` and `realpath` only, so a
   * regression that opened a handle to probe the file — and leaked it — shows up here as a
   * call to the spied `open`, which is the only observable a leaked descriptor has.
   */
  function expectNoDescriptorOpened(): void {
    expect(vi.mocked(open)).not.toHaveBeenCalled();
  }

  describe('ok', () => {
    it('returns the joined path for a regular .epub inside the root', async () => {
      await writeFile(join(bookPath, 'book.epub'), 'PK companion bytes');

      await expect(resolve('book.epub')).resolves.toEqual({
        outcome: 'ok',
        path: join(bookPath, 'book.epub'),
      });
      expectNoDescriptorOpened();
    });

    it('returns the path VERBATIM, not the canonicalised realpath', async () => {
      // Containment canonicalises to decide, but the returned path is the one the caller
      // built from `books.path` — so `inspectEpub` opens the same name the row names.
      await writeFile(join(bookPath, 'book.epub'), 'bytes');
      const result = await resolve('book.epub');

      expect(result.outcome).toBe('ok');
      if (result.outcome !== 'ok') return;
      expect(result.path.split('\\').join('/')).toContain('Author/Title/book.epub');
    });
  });

  describe('invalid_filename', () => {
    const rejected = ['', 'a/b.epub', 'a\\b.epub', ' book.epub', 'book.epub ', '.', '..'];

    it.each(rejected)('rejects %j before any syscall', async (filename) => {
      await expect(resolve(filename)).resolves.toEqual({ outcome: 'invalid_filename' });
      expect(vi.mocked(lstat)).not.toHaveBeenCalled();
      expectNoDescriptorOpened();
    });
  });

  describe('not_regular_file', () => {
    it.skipIf(!CAN_SYMLINK)('rejects a symlink whose target is outside the root', async () => {
      await writeFile(join(outside, 'secret.epub'), 'secret');
      await symlink(join(outside, 'secret.epub'), join(bookPath, 'book.epub'));

      await expect(resolve('book.epub')).resolves.toEqual({ outcome: 'not_regular_file' });
      expectNoDescriptorOpened();
    });

    it.skipIf(!CAN_SYMLINK)('rejects a symlink whose target is inside the root', async () => {
      await writeFile(join(bookPath, 'real.epub'), 'real');
      await symlink(join(bookPath, 'real.epub'), join(bookPath, 'book.epub'));

      await expect(resolve('book.epub')).resolves.toEqual({ outcome: 'not_regular_file' });
      expectNoDescriptorOpened();
    });

    it('rejects a directory', async () => {
      await mkdir(join(bookPath, 'book.epub'));
      await expect(resolve('book.epub')).resolves.toEqual({ outcome: 'not_regular_file' });
      expectNoDescriptorOpened();
    });

    it.runIf(isLinux)('rejects a FIFO', async () => {
      execFileSync('mkfifo', [join(bookPath, 'book.epub')]);
      await expect(resolve('book.epub')).resolves.toEqual({ outcome: 'not_regular_file' });
      expectNoDescriptorOpened();
    });
  });

  describe('outside_library', () => {
    // The PARENT-component escape, not merely a final-component one: this is the case
    // `isCompanionEbookEligible`'s directory-level guard cannot cover once a component is
    // swapped after it ran, and the only reason step 6 of the selection pass exists (AC28).
    it.skipIf(!CAN_SYMLINK)('rejects a parent-directory symlink escape whose final component is a real file', async () => {
      const externalBook = join(outside, 'Title');
      await mkdir(externalBook, { recursive: true });
      await writeFile(join(externalBook, 'book.epub'), 'outside bytes');
      await symlink(externalBook, join(root, 'escape'));

      const result = await resolve('book.epub', { bookPath: join(root, 'escape') });
      expect(result).toEqual({ outcome: 'outside_library' });
      expectNoDescriptorOpened();
    });

    it('rejects a book path lexically outside the root', async () => {
      await writeFile(join(outside, 'book.epub'), 'outside bytes');
      await expect(resolve('book.epub', { bookPath: outside })).resolves.toEqual({
        outcome: 'outside_library',
      });
      expectNoDescriptorOpened();
    });
  });

  describe('missing', () => {
    it('classifies an already-vanished file as missing at the lstat step (ENOENT)', async () => {
      await expect(resolve('book.epub')).resolves.toEqual({ outcome: 'missing' });
      expectNoDescriptorOpened();
    });

    it('classifies a book path that is not a directory as missing (ENOTDIR)', async () => {
      const filePath = join(bookPath, 'notadir');
      await writeFile(filePath, 'x');
      await expect(resolve('book.epub', { bookPath: filePath })).resolves.toEqual({
        outcome: 'missing',
      });
      expectNoDescriptorOpened();
    });

    it('classifies a file that vanishes between lstat and containment as missing', async () => {
      const filePath = join(bookPath, 'book.epub');
      await writeFile(filePath, 'bytes');
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(lstat).mockImplementationOnce((async (target: string) => {
        const stats = await actual.lstat(target);
        await actual.rm(target);
        return stats;
      }) as unknown as typeof lstat);

      await expect(resolve('book.epub')).resolves.toEqual({ outcome: 'missing' });
      expectNoDescriptorOpened();
    });
  });

  describe('unreadable', () => {
    it('classifies EACCES from lstat as unreadable', async () => {
      const filePath = join(bookPath, 'book.epub');
      await writeFile(filePath, 'bytes');
      vi.mocked(lstat).mockRejectedValueOnce(
        Object.assign(new Error(`EACCES: permission denied, lstat '${filePath}'`), { code: 'EACCES' }),
      );

      await expect(resolve('book.epub')).resolves.toEqual({ outcome: 'unreadable' });
      expectNoDescriptorOpened();
    });

    it('classifies a code-less throw as unreadable, never missing', async () => {
      await writeFile(join(bookPath, 'book.epub'), 'bytes');
      // The message SAYS ENOENT and there is no `code`: only the shared #1955 discriminator
      // gets this right, a hand-rolled message match does not.
      vi.mocked(lstat).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(resolve('book.epub')).resolves.toEqual({ outcome: 'unreadable' });
      expectNoDescriptorOpened();
    });
  });

  // AC2/AC6 boundary: the resolver's `debug` records carry the path DELIBERATELY. The
  // path-free rule is the route boundary's, and #1974 settled that a path-free
  // `serializeError` is not expressible.
  describe('logging', () => {
    it('logs a caught lstat error at debug with the path preserved in the serialized error', async () => {
      const filePath = join(bookPath, 'book.epub');
      await writeFile(filePath, 'bytes');
      const eacces = Object.assign(new Error(`EACCES: permission denied, lstat '${filePath}'`), {
        code: 'EACCES',
      });
      vi.mocked(lstat).mockRejectedValueOnce(eacces);

      await resolve('book.epub');

      expect(logger.spies.debug).toHaveBeenCalledTimes(1);
      const [record] = logger.spies.debug.mock.calls[0] as [Record<string, unknown>, string];
      expect(record).toMatchObject({ bookId: 42, path: filePath });
      expectSerializedError(record.error, eacces, { code: 'EACCES' });
      expect(stringLeaves(record.error).join('\n')).toContain(filePath);
    });

    it('logs the containment rejection WITHOUT an error key — it is control flow, not a failure', async () => {
      await writeFile(join(outside, 'book.epub'), 'outside bytes');

      await resolve('book.epub', { bookPath: outside });

      const [record] = logger.spies.debug.mock.calls[0] as [Record<string, unknown>, string];
      expect(Object.keys(record).sort()).toEqual(['bookId', 'path']);
    });

    it('never logs above debug', async () => {
      await resolve('book.epub'); // missing
      await resolve('a/b.epub');  // invalid_filename
      expect(logger.spies.info).not.toHaveBeenCalled();
      expect(logger.spies.warn).not.toHaveBeenCalled();
      expect(logger.spies.error).not.toHaveBeenCalled();
    });
  });
});
