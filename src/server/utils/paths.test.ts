import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Dirent } from 'node:fs';
import { basename } from 'node:path';
import { renameFilesWithTemplate, assertPathInsideLibrary, PathOutsideLibraryError } from './paths.js';
import type { RenameableBook } from './paths.js';

vi.mock('node:fs/promises', async () => ({
  ...(await vi.importActual('node:fs/promises')),
  readdir: vi.fn(),
  rename: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn(),
}));

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'info', silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function makeDirent(name: string, isFile: boolean): Dirent {
  return { name, isFile: () => isFile, isDirectory: () => !isFile } as Dirent;
}

const book: RenameableBook = {
  title: 'Test Book',
  seriesName: null,
  seriesPosition: null,
  narrators: [{ name: 'Jane Narrator' }],
  publishedDate: '2024-01-15',
};

describe('assertPathInsideLibrary', () => {
  it('returns void for in-library descendant path', () => {
    expect(() => assertPathInsideLibrary('/library/Author/Title', '/library')).not.toThrow();
  });

  it('throws PathOutsideLibraryError for path outside library', () => {
    expect(() => assertPathInsideLibrary('/tmp/external', '/library')).toThrow(PathOutsideLibraryError);
  });

  it('throws when bookPath equals libraryRoot', () => {
    expect(() => assertPathInsideLibrary('/library', '/library')).toThrow(PathOutsideLibraryError);
  });

  it('throws when bookPath equals libraryRoot with trailing slash', () => {
    expect(() => assertPathInsideLibrary('/library/', '/library')).toThrow(PathOutsideLibraryError);
  });

  it('throws on `..` escape', () => {
    expect(() => assertPathInsideLibrary('/library/../etc/passwd', '/library')).toThrow(PathOutsideLibraryError);
  });

  it('throws on sibling-prefix attack (/library2 vs /library)', () => {
    expect(() => assertPathInsideLibrary('/library2/Author/Title', '/library')).toThrow(PathOutsideLibraryError);
  });

  it('attaches stable name, code, and properties to the error', () => {
    let caught: unknown;
    try {
      assertPathInsideLibrary('/tmp/external', '/library');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(PathOutsideLibraryError);
    expect((caught as PathOutsideLibraryError).name).toBe('PathOutsideLibraryError');
    expect((caught as PathOutsideLibraryError).code).toBe('PATH_OUTSIDE_LIBRARY');
    expect((caught as PathOutsideLibraryError).bookPath).toBe('/tmp/external');
    expect((caught as PathOutsideLibraryError).libraryRoot).toBe('/library');
    expect((caught as PathOutsideLibraryError).message).toBe('Path "/tmp/external" is not inside library root "/library"');
  });
});

describe('renameFilesWithTemplate', () => {
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    log = createMockLogger();
  });

  describe('onProgress callback', () => {
    it('calls onProgress after each successful rename with (current, total)', async () => {
      const { readdir, rename } = await import('node:fs/promises');
      vi.mocked(readdir).mockResolvedValue([
        makeDirent('track1.mp3', true),
        makeDirent('track2.mp3', true),
        makeDirent('track3.mp3', true),
      ] as never);
      vi.mocked(rename).mockResolvedValue(undefined);

      const onProgress = vi.fn();
      await renameFilesWithTemplate('/target', '{title}', book, 'Author', log, undefined, onProgress);

      // 3 audio files with format '{title}' and trackNumber tokens → 3 renames
      expect(onProgress).toHaveBeenCalledTimes(3);
      expect(onProgress).toHaveBeenNthCalledWith(1, 1, 3);
      expect(onProgress).toHaveBeenNthCalledWith(2, 2, 3);
      expect(onProgress).toHaveBeenNthCalledWith(3, 3, 3);
    });

    it('calls onProgress with monotonically increasing current and constant total', async () => {
      const { readdir, rename } = await import('node:fs/promises');
      vi.mocked(readdir).mockResolvedValue([
        makeDirent('a.mp3', true),
        makeDirent('b.mp3', true),
        makeDirent('c.mp3', true),
        makeDirent('d.mp3', true),
      ] as never);
      vi.mocked(rename).mockResolvedValue(undefined);

      const calls: [number, number][] = [];
      const onProgress = vi.fn((current: number, total: number) => {
        calls.push([current, total]);
      });

      await renameFilesWithTemplate('/target', '{title}', book, 'Author', log, undefined, onProgress);

      // Verify monotonically increasing current
      for (let i = 1; i < calls.length; i++) {
        expect(calls[i][0]).toBeGreaterThan(calls[i - 1][0]);
      }
      // Verify constant total
      const totals = calls.map(c => c[1]);
      expect(new Set(totals).size).toBe(1);
    });

    it('works identically when onProgress is omitted (backward compat)', async () => {
      const { readdir, rename } = await import('node:fs/promises');
      vi.mocked(readdir).mockResolvedValue([
        makeDirent('old.mp3', true),
      ] as never);
      vi.mocked(rename).mockResolvedValue(undefined);

      // Should not throw when onProgress is omitted
      const result = await renameFilesWithTemplate('/target', '{title}', book, 'Author', log);
      expect(result).toBe(1);
      expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);
    });

    it('does not call onProgress during rollback after a failure', async () => {
      const { readdir, rename } = await import('node:fs/promises');
      vi.mocked(readdir).mockResolvedValue([
        makeDirent('a.mp3', true),
        makeDirent('b.mp3', true),
        makeDirent('c.mp3', true),
      ] as never);

      let callCount = 0;
      vi.mocked(rename).mockImplementation(async () => {
        callCount++;
        if (callCount === 3) throw new Error('ENOSPC');
      });

      const onProgress = vi.fn();

      await expect(
        renameFilesWithTemplate('/target', '{title}', book, 'Author', log, undefined, onProgress),
      ).rejects.toThrow('ENOSPC');

      // onProgress called for the 2 successful renames, NOT during rollback
      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenNthCalledWith(1, 1, 3);
      expect(onProgress).toHaveBeenNthCalledWith(2, 2, 3);
    });

    it('does not invoke onProgress when the target directory contains no audio files', async () => {
      // Proves the early-return at paths.ts:72 — when readdir yields nothing
      // recognized as an audio file, the helper resolves 0 without touching the callback.
      const { readdir, rename } = await import('node:fs/promises');
      vi.mocked(readdir).mockResolvedValue([
        makeDirent('cover.jpg', true),
        makeDirent('notes.txt', true),
      ] as never);

      const onProgress = vi.fn();
      const renamedCount = await renameFilesWithTemplate('/target', '{title}', book, 'Author', log, undefined, onProgress);

      expect(renamedCount).toBe(0);
      expect(onProgress).not.toHaveBeenCalled();
      expect(vi.mocked(rename)).not.toHaveBeenCalled();
    });

    it('swallows errors thrown inside onProgress and continues renaming', async () => {
      // Callback failures (e.g. SSE broadcaster throwing) must never trigger a
      // rollback of successfully-renamed files. The rename loop catches the
      // callback throw, logs a warning, and keeps going.
      const { readdir, rename } = await import('node:fs/promises');
      vi.mocked(readdir).mockResolvedValue([
        makeDirent('a.mp3', true),
        makeDirent('b.mp3', true),
      ] as never);
      vi.mocked(rename).mockResolvedValue(undefined);

      const onProgress = vi.fn().mockImplementation(() => {
        throw new Error('callback error');
      });

      // Should resolve successfully, not reject
      const renamedCount = await renameFilesWithTemplate('/target', '{title}', book, 'Author', log, undefined, onProgress);
      expect(renamedCount).toBe(2);

      // onProgress called for every rename even after throwing
      expect(onProgress).toHaveBeenCalledTimes(2);

      // Warning logged for each swallowed callback error
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.anything() }),
        expect.stringMatching(/onProgress callback threw/),
      );
    });
  });

  describe('rollback', () => {
    it('undoes completed renames in reverse order when a mid-sequence rename fails', async () => {
      const { readdir, rename } = await import('node:fs/promises');
      vi.mocked(readdir).mockResolvedValue([
        makeDirent('a.mp3', true),
        makeDirent('b.mp3', true),
        makeDirent('c.mp3', true),
      ] as never);

      const forwardError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      let callCount = 0;
      vi.mocked(rename).mockImplementation(async () => {
        callCount++;
        if (callCount === 3) throw forwardError;
      });

      await expect(
        renameFilesWithTemplate('/target', '{title}', book, 'Author', log),
      ).rejects.toBe(forwardError);

      // 3 forward attempts (last one throws) + 2 rollback calls for the 2 completed renames
      const calls = vi.mocked(rename).mock.calls;
      expect(calls).toHaveLength(5);

      // The forward calls map the original filenames to template-rendered names.
      // Capture the actual (from, to) the production code emitted so the rollback
      // assertions don't have to re-derive the template.
      const forward1 = { from: calls[0][0] as string, to: calls[0][1] as string };
      const forward2 = { from: calls[1][0] as string, to: calls[1][1] as string };

      // Rollback calls swap from/to of the completed renames, in reverse order.
      // Completed-rename #2 is undone first, then #1.
      expect(calls[3][0]).toBe(forward2.to);
      expect(calls[3][1]).toBe(forward2.from);
      expect(calls[4][0]).toBe(forward1.to);
      expect(calls[4][1]).toBe(forward1.from);
    });

    it('continues rolling back remaining completed renames when one rollback rejects', async () => {
      const { readdir, rename } = await import('node:fs/promises');
      vi.mocked(readdir).mockResolvedValue([
        makeDirent('a.mp3', true),
        makeDirent('b.mp3', true),
        makeDirent('c.mp3', true),
      ] as never);

      const forwardError = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      const rollbackError = new Error('rollback failed');

      // Forward calls 1 & 2 succeed, forward call 3 throws (forwardError).
      // Then rollback runs in reverse: rollback for completed #2 (call 4) throws,
      // rollback for completed #1 (call 5) succeeds. The loop must NOT short-circuit
      // after the first rollback throw.
      let callCount = 0;
      vi.mocked(rename).mockImplementation(async () => {
        callCount++;
        if (callCount === 3) throw forwardError;
        if (callCount === 4) throw rollbackError;
      });

      await expect(
        renameFilesWithTemplate('/target', '{title}', book, 'Author', log),
      ).rejects.toBe(forwardError);

      // Both rollback attempts must have run
      expect(vi.mocked(rename)).toHaveBeenCalledTimes(5);

      // log.error called for the forward failure (serialized) and the rollback failure (raw)
      const errorCalls = vi.mocked(log.error).mock.calls;
      const forwardLog = errorCalls.find(c => {
        const arg = c[0] as Record<string, unknown> | undefined;
        return arg !== undefined && 'completed' in arg && 'total' in arg;
      });
      const rollbackLog = errorCalls.find(c => {
        const arg = c[0] as Record<string, unknown> | undefined;
        return arg !== undefined && 'rollbackError' in arg;
      });

      expect(forwardLog).toBeDefined();
      expect(forwardLog![0]).toMatchObject({
        error: expect.objectContaining({ message: 'ENOSPC', type: 'Error' }),
        completed: 2,
        total: 3,
      });

      expect(rollbackLog).toBeDefined();
      // Rollback log uses the raw `{ rollbackError, file }` shape per paths.ts:137.
      // `file` is the basename of the rendered name from completed-rename #2 — the
      // rollback that failed. Derive it from the corresponding forward call (#2)
      // so the assertion stays correct if the template render changes.
      const completedTwoRenderedFile = basename(vi.mocked(rename).mock.calls[1][1] as string);
      expect(rollbackLog![0]).toMatchObject({
        rollbackError,
        file: completedTwoRenderedFile,
      });
    });
  });
});
