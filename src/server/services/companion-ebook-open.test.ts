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
import { READ_NO_FOLLOW } from '@core/utils/no-follow-open.js';

// Real temp dirs preserve symlink/parent-escape behavior; spies expose only syscall and errno boundaries.
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

function stringLeaves(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, acc);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringLeaves(v, acc);
  return acc;
}

// Enumerable keys distinguish serializeError output from raw Error properties that Pino would omit.
// objectContaining({ message }) is insufficient because it reads non-enumerable properties.
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
    // macOS resolves /var → /private/var, so canonicalize roots before containment tests.
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

    // Cover the pathname-check/open gap: flag use everywhere and real swap refusal where supported.
    it('opens with O_NOFOLLOW rather than a symlink-following read flag', async () => {
      await writeFile(join(bookPath, 'book.epub'), 'x');
      const result = await call('book.epub');

      expect(result.outcome).toBe('ok');
      expect(open).toHaveBeenCalledWith(join(bookPath, 'book.epub'), READ_NO_FOLLOW);
      if (result.outcome === 'ok') await result.handle.close();
    });

    // POSIX owns O_NOFOLLOW → ELOOP; this module must classify that errno as a refusal.
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

        // Swap after containment but before open to exercise the attacker-controlled window.
        const { open: actualOpen } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        vi.mocked(open).mockImplementationOnce(async (...args) => {
          await rm(path);
          await symlink(secret, path);
          return actualOpen(...(args as Parameters<typeof actualOpen>));
        });

        const result = await call('book.epub');

        // ELOOP is unreadable, not missing; no handle may expose secret bytes.
        expect(result.outcome).toBe('unreadable');
      },
    );
  });

  describe('not_regular_file', () => {
    it.skipIf(!CAN_SYMLINK)('rejects a symlink whose target is outside the root', async () => {
      await writeFile(join(outside, 'secret.epub'), 'secret');
      await symlink(join(outside, 'secret.epub'), join(bookPath, 'book.epub'));

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
      const externalBook = join(outside, 'Title');
      await mkdir(externalBook, { recursive: true });
      await writeFile(join(externalBook, 'book.epub'), 'outside bytes');
      await symlink(externalBook, join(root, 'escape'));

      // lstat sees a regular final component; only full-path canonicalization catches the parent escape.
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
    // Mirrors discovery exclusions; both paths must share one predicate.
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

    // The earlier case exits at lstat; this one reaches strict realpath ENOENT handling.
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

      // Only no-open distinguishes strict ENOENT propagation from the legacy swallowing guard.
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
      // A real Node EACCES necessarily embeds the path in its serialized message and stack.
      const eacces = Object.assign(new Error(`EACCES: permission denied, open '${filePath}'`), { code: 'EACCES' });
      vi.mocked(open).mockRejectedValueOnce(eacces);

      await call('book.epub');

      expect(logger.spies.debug).toHaveBeenCalledTimes(1);
      const [record] = logger.spies.debug.mock.calls[0] as [Record<string, unknown>, string];
      expect(record).toMatchObject({ bookId: 42, path: filePath });

      expectSerializedError(record.error, eacces, { code: 'EACCES' });

      // Path-free serializeError is impossible because Node embeds it in message and stack.
      expect(stringLeaves(record.error).join('\n')).toContain(filePath);
      expect(logger.spies.warn).not.toHaveBeenCalled();
      expect(logger.spies.error).not.toHaveBeenCalled();
    });

    // Never-throws includes cleanup: a rejecting close must still classify and log.
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
      await call('book.epub');
      await call('a/b.epub');
      expect(logger.spies.info).not.toHaveBeenCalled();
      expect(logger.spies.warn).not.toHaveBeenCalled();
      expect(logger.spies.error).not.toHaveBeenCalled();
    });
  });
});

// The resolver verifies real symlink/escape behavior without opening a descriptor.
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
      // Canonicalize only for containment; return the pathname stored by the book row.
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
    // A parent component can be swapped after the earlier directory-level eligibility guard.
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
      // A code-less "ENOENT" message must not trigger absence classification.
      vi.mocked(lstat).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(resolve('book.epub')).resolves.toEqual({ outcome: 'unreadable' });
      expectNoDescriptorOpened();
    });
  });

  // Debug records deliberately retain paths; redaction belongs at the route boundary.
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
      await resolve('book.epub');
      await resolve('a/b.epub');
      expect(logger.spies.info).not.toHaveBeenCalled();
      expect(logger.spies.warn).not.toHaveBeenCalled();
      expect(logger.spies.error).not.toHaveBeenCalled();
    });
  });
});
