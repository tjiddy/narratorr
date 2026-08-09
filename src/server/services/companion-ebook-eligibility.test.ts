import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  realpath: vi.fn(),
}));

import { stat, realpath } from 'node:fs/promises';
import { isCompanionEbookEligible } from './companion-ebook-eligibility.js';
import { CAN_SYMLINK } from '../__tests__/windows-fs.js';
import type { BookStatus } from '@shared/schemas/book.js';
import type { FastifyBaseLogger } from 'fastify';

const mockStat = stat as unknown as ReturnType<typeof vi.fn>;
const mockRealpath = realpath as unknown as ReturnType<typeof vi.fn>;

function makeLog() {
  const debug = vi.fn();
  const log = { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
  return { log, debug };
}

const ROOT = join('/', 'library');
const BOOK_PATH = join(ROOT, 'Author', 'Title');

function directory() {
  return { isDirectory: () => true };
}
function file() {
  return { isDirectory: () => false };
}

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`fs failed: ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function input(overrides: {
  enabled?: boolean;
  status?: BookStatus;
  path?: string | null;
  libraryRoot?: string;
} = {}) {
  return {
    enabled: overrides.enabled ?? true,
    book: {
      id: 42,
      status: overrides.status ?? ('imported' as BookStatus),
      path: overrides.path === undefined ? BOOK_PATH : overrides.path,
    },
    libraryRoot: overrides.libraryRoot ?? ROOT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStat.mockResolvedValue(directory());
});

describe('isCompanionEbookEligible', () => {
  it('is true for an enabled feature, an imported book, and a real directory inside the root', async () => {
    const { log } = makeLog();
    await expect(isCompanionEbookEligible(input(), log)).resolves.toBe(true);
    expect(mockStat).toHaveBeenCalledTimes(1);
    // Call count alone would not catch probing libraryRoot instead.
    expect(mockStat).toHaveBeenCalledWith(BOOK_PATH);
  });

  it("is false when the stored path is a file rather than a directory", async () => {
    // Argument-sensitive so probing libraryRoot makes this case fail.
    mockStat.mockImplementation((p: string) => Promise.resolve(p === BOOK_PATH ? file() : directory()));
    const { log } = makeLog();
    await expect(isCompanionEbookEligible(input(), log)).resolves.toBe(false);
    expect(mockStat).toHaveBeenCalledWith(BOOK_PATH);
  });

  const NON_IMPORTED: BookStatus[] = ['wanted', 'downloading', 'importing', 'missing', 'failed', 'searching'];
  for (const status of NON_IMPORTED) {
    it(`is false for a '${status}' book`, async () => {
      const { log } = makeLog();
      await expect(isCompanionEbookEligible(input({ status }), log)).resolves.toBe(false);
    });
  }

  describe('gate ordering — every gate before the stat returns without touching the filesystem', () => {
    it('feature disabled', async () => {
      const { log } = makeLog();
      await expect(isCompanionEbookEligible(input({ enabled: false }), log)).resolves.toBe(false);
      expect(mockStat).not.toHaveBeenCalled();
    });

    it('non-imported status', async () => {
      const { log } = makeLog();
      await expect(isCompanionEbookEligible(input({ status: 'wanted' }), log)).resolves.toBe(false);
      expect(mockStat).not.toHaveBeenCalled();
    });

    it('null path', async () => {
      const { log } = makeLog();
      await expect(isCompanionEbookEligible(input({ path: null }), log)).resolves.toBe(false);
      expect(mockStat).not.toHaveBeenCalled();
    });

    it('empty path', async () => {
      const { log } = makeLog();
      await expect(isCompanionEbookEligible(input({ path: '' }), log)).resolves.toBe(false);
      expect(mockStat).not.toHaveBeenCalled();
    });

    it('whitespace-only path', async () => {
      const { log } = makeLog();
      await expect(isCompanionEbookEligible(input({ path: '   ' }), log)).resolves.toBe(false);
      expect(mockStat).not.toHaveBeenCalled();
    });

    it('empty library root', async () => {
      const { log } = makeLog();
      await expect(isCompanionEbookEligible(input({ libraryRoot: '' }), log)).resolves.toBe(false);
      expect(mockStat).not.toHaveBeenCalled();
    });

    it('whitespace-only library root', async () => {
      const { log } = makeLog();
      await expect(isCompanionEbookEligible(input({ libraryRoot: '   ' }), log)).resolves.toBe(false);
      expect(mockStat).not.toHaveBeenCalled();
    });

    it('path outside the root', async () => {
      const { log } = makeLog();
      await expect(
        isCompanionEbookEligible(input({ path: join('/', 'elsewhere', 'book') }), log),
      ).resolves.toBe(false);
      expect(mockStat).not.toHaveBeenCalled();
    });
  });

  describe('containment', () => {
    it("rejects the sibling-prefix case a raw startsWith would wrongly admit ('/library-2/book' vs '/library')", async () => {
      const { log } = makeLog();
      await expect(
        isCompanionEbookEligible(input({ path: join('/', 'library-2', 'book'), libraryRoot: ROOT }), log),
      ).resolves.toBe(false);
      expect(mockStat).not.toHaveBeenCalled();
    });

    it("rejects an upward escape ('/library/../etc/book')", async () => {
      const { log } = makeLog();
      await expect(
        isCompanionEbookEligible(input({ path: join(ROOT, '..', 'etc', 'book') }), log),
      ).resolves.toBe(false);
    });

    it('rejects a path exactly equal to the root', async () => {
      const { log } = makeLog();
      await expect(isCompanionEbookEligible(input({ path: ROOT }), log)).resolves.toBe(false);
    });

    it('rejects a cross-drive Windows path (D:\\books\\x against C:\\library)', async () => {
      const { log } = makeLog();
      await expect(
        isCompanionEbookEligible(input({ path: 'D:\\books\\x', libraryRoot: 'C:\\library' }), log),
      ).resolves.toBe(false);
    });

    it('logs the expected containment rejection once at debug, with no error key', async () => {
      const { log, debug } = makeLog();
      await isCompanionEbookEligible(input({ path: join('/', 'elsewhere', 'book') }), log);
      expect(debug).toHaveBeenCalledTimes(1);
      const [payload] = debug.mock.calls[0]!;
      expect(payload).toMatchObject({ bookId: 42 });
      expect(String((payload as { path: string }).path).split('\\').join('/')).toContain('elsewhere/book');
      // Expected miss, not a filesystem failure.
      expect(payload).not.toHaveProperty('error');
      expect(mockStat).not.toHaveBeenCalled();
    });
  });

  // Containment is deliberately lexical; serve-time checks secure files under operator-created symlinks.
  it.skipIf(!CAN_SYMLINK)('accepts a real in-root symlink whose target lies outside the root, and never consults realpath', async () => {
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const os = await import('node:os');
    const dir = await realFs.mkdtemp(join(os.tmpdir(), 'companion-eligibility-'));
    const root = join(dir, 'library');
    const outside = join(dir, 'outside', 'Author', 'Title');
    const linked = join(root, 'Author', 'Title');
    await realFs.mkdir(outside, { recursive: true });
    await realFs.mkdir(join(root, 'Author'), { recursive: true });
    await realFs.symlink(outside, linked, 'dir');

    mockStat.mockImplementation((p: string) => realFs.stat(p));

    const { log } = makeLog();
    try {
      await expect(
        isCompanionEbookEligible(input({ path: linked, libraryRoot: root }), log),
      ).resolves.toBe(true);
      expect(mockRealpath).not.toHaveBeenCalled();
      expect(mockStat).toHaveBeenCalledWith(linked);
    } finally {
      await realFs.rm(dir, { recursive: true, force: true });
    }
  });

  describe('fails closed on every stat rejection and logs it', () => {
    for (const code of ['ENOENT', 'EACCES', 'ENOTDIR', 'EIO', 'ESTALE']) {
      it(`${code} → false, logged once at debug with a serialized error`, async () => {
        mockStat.mockRejectedValue(errno(code));
        const { log, debug } = makeLog();
        await expect(isCompanionEbookEligible(input(), log)).resolves.toBe(false);
        expect(debug).toHaveBeenCalledTimes(1);
        const [payload] = debug.mock.calls[0]!;
        expect(payload).toMatchObject({ bookId: 42 });
        expect((payload as { error: { code?: string } }).error).toMatchObject({ code });
        expect(String((payload as { path: string }).path).split('\\').join('/')).toContain('Author/Title');
      });
    }

    it('a throw with no code → false, logged once at debug with a serialized error', async () => {
      mockStat.mockRejectedValue(new Error('nope'));
      const { log, debug } = makeLog();
      await expect(isCompanionEbookEligible(input(), log)).resolves.toBe(false);
      expect(debug).toHaveBeenCalledTimes(1);
      const [payload] = debug.mock.calls[0]!;
      expect((payload as { error: { message: string } }).error).toMatchObject({ message: 'nope' });
    });

    it('nothing propagates out of the guard for any of the named errnos', async () => {
      const { log } = makeLog();
      for (const code of ['ENOENT', 'EACCES', 'ENOTDIR', 'EIO', 'ESTALE']) {
        mockStat.mockRejectedValue(errno(code));
        await expect(isCompanionEbookEligible(input(), log)).resolves.toBe(false);
      }
    });
  });
});
