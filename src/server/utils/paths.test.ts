import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Dirent } from 'node:fs';
import { basename } from 'node:path';
import { realpath } from 'node:fs/promises';
import { renameFilesWithTemplate, planFileRenames, padWidth, assertPathInsideLibrary, assertRealPathInsideLibrary, PathOutsideLibraryError } from './paths.js';
import type { RenameableBook } from './paths.js';

vi.mock('node:fs/promises', async () => ({
  ...(await vi.importActual('node:fs/promises')),
  readdir: vi.fn(),
  rename: vi.fn().mockResolvedValue(undefined),
  rmdir: vi.fn(),
  realpath: vi.fn(),
}));

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

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

describe('assertRealPathInsideLibrary', () => {
  beforeEach(() => {
    vi.mocked(realpath).mockReset();
  });

  // Lexical containment runs first and unconditionally — the canonical (realpath)
  // pass is never reached for these, even if realpath would ENOENT.
  it('rejects a path outside the root', async () => {
    await expect(assertRealPathInsideLibrary('/tmp/external', '/library')).rejects.toThrow(PathOutsideLibraryError);
  });

  it('rejects equality with the library root', async () => {
    await expect(assertRealPathInsideLibrary('/library', '/library')).rejects.toThrow(PathOutsideLibraryError);
  });

  it('rejects a `..` escape', async () => {
    await expect(assertRealPathInsideLibrary('/library/../etc/passwd', '/library')).rejects.toThrow(PathOutsideLibraryError);
  });

  it('rejects a sibling-prefix path (/library2 vs /library)', async () => {
    await expect(assertRealPathInsideLibrary('/library2/Author/Title', '/library')).rejects.toThrow(PathOutsideLibraryError);
  });

  it('rejects a lexical escape even when realpath would ENOENT', async () => {
    vi.mocked(realpath).mockRejectedValue(enoent());
    await expect(assertRealPathInsideLibrary('/tmp/external', '/library')).rejects.toThrow(PathOutsideLibraryError);
  });

  it('rejects an in-library symlink whose realpath canonicalizes outside the root', async () => {
    vi.mocked(realpath)
      .mockResolvedValueOnce('/library')        // realpath(libraryRoot)
      .mockResolvedValueOnce('/etc/passwd');    // realpath(bookPath) escapes
    await expect(assertRealPathInsideLibrary('/library/link', '/library')).rejects.toThrow(PathOutsideLibraryError);
  });

  it('swallows ENOENT for an in-library path missing on disk (no throw)', async () => {
    vi.mocked(realpath).mockRejectedValue(enoent());
    await expect(assertRealPathInsideLibrary('/library/Author/Missing', '/library')).resolves.toBeUndefined();
  });

  it('passes an in-library path whose realpath stays inside the root', async () => {
    vi.mocked(realpath)
      .mockResolvedValueOnce('/library')
      .mockResolvedValueOnce('/library/Author/Title');
    await expect(assertRealPathInsideLibrary('/library/Author/Title', '/library')).resolves.toBeUndefined();
  });

  it('propagates a non-ENOENT realpath error', async () => {
    vi.mocked(realpath).mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(assertRealPathInsideLibrary('/library/Author/Title', '/library')).rejects.toThrow('EACCES');
  });

  it('attaches PathOutsideLibraryError properties on a symlink escape', async () => {
    vi.mocked(realpath)
      .mockResolvedValueOnce('/library')
      .mockResolvedValueOnce('/etc');
    let caught: unknown;
    try {
      await assertRealPathInsideLibrary('/library/link', '/library');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PathOutsideLibraryError);
    expect((caught as PathOutsideLibraryError).name).toBe('PathOutsideLibraryError');
    expect((caught as PathOutsideLibraryError).code).toBe('PATH_OUTSIDE_LIBRARY');
    expect((caught as PathOutsideLibraryError).bookPath).toBe('/library/link');
    expect((caught as PathOutsideLibraryError).libraryRoot).toBe('/library');
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
        expect(calls[i]![0]).toBeGreaterThan(calls[i - 1]![0]);
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
      const forward1 = { from: calls[0]![0] as string, to: calls[0]![1] as string };
      const forward2 = { from: calls[1]![0] as string, to: calls[1]![1] as string };

      // Rollback calls swap from/to of the completed renames, in reverse order.
      // Completed-rename #2 is undone first, then #1.
      expect(calls[3]![0]).toBe(forward2.to);
      expect(calls[3]![1]).toBe(forward2.from);
      expect(calls[4]![0]).toBe(forward1.to);
      expect(calls[4]![1]).toBe(forward1.from);
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
      const completedTwoRenderedFile = basename(vi.mocked(rename).mock.calls[1]![1] as string);
      expect(rollbackLog![0]).toMatchObject({
        rollbackError,
        file: completedTwoRenderedFile,
      });
    });
  });
});

describe('padWidth', () => {
  it('returns digit count for sequential-ordinal zero padding', () => {
    expect(padWidth(99)).toBe(2);
    expect(padWidth(100)).toBe(3);
    expect(padWidth(999)).toBe(3);
    expect(padWidth(1000)).toBe(4);
  });
});

describe('planFileRenames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function mockFiles(names: string[]): Promise<void> {
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue(names.map(n => makeDirent(n, true)) as never);
  }

  describe('colliding format → number all', () => {
    it('numbers every file including the first, zero-padded, with no bare file', async () => {
      await mockFiles(['x.mp3', 'y.mp3', 'z.mp3']);

      const renames = await planFileRenames('/t', '{author} - {title}', book, 'Author');

      const tos = renames.map(r => r.to);
      expect(tos).toEqual([
        'Author - Test Book (1).mp3',
        'Author - Test Book (2).mp3',
        'Author - Test Book (3).mp3',
      ]);
      // No bare/unnumbered file, all unique
      expect(tos.every(t => /\(\d+\)\.mp3$/.test(t))).toBe(true);
      expect(new Set(tos).size).toBe(3);
    });

    it('renames a 100-file colliding book to 3-digit padded ordinals (001…100)', async () => {
      const sources = Array.from({ length: 100 }, (_, i) => `Track${i + 1}.mp3`);
      await mockFiles(sources);

      const renames = await planFileRenames('/t', '{author} - {title}', book, 'Author');

      expect(renames).toHaveLength(100);
      // Numeric sort: Track1…Track100 → ordinals 001…100, consistent 3-digit width
      expect(renames[0]!.to).toBe('Author - Test Book (001).mp3');
      expect(renames[99]!.to).toBe('Author - Test Book (100).mp3');
      expect(renames.every(r => /\(\d{3}\)\.mp3$/.test(r.to))).toBe(true);
    });

    it('numbers the bare file first, before its (N) duplicate copies', async () => {
      // Windows/download duplicate convention: bare `Title.mp3` IS part 1, `(2)` is part 2.
      // Pre-fix the bare file sorted LAST and got the highest ordinal — chapter 1 at the end.
      await mockFiles(['Title.mp3', 'Title (10).mp3', 'Title (2).mp3']);

      const renames = await planFileRenames('/t', '{author} - {title}', book, 'Author');

      const byFrom = Object.fromEntries(renames.map(r => [r.from, r.to]));
      expect(byFrom['Title.mp3']).toBe('Author - Test Book (1).mp3');
      expect(byFrom['Title (2).mp3']).toBe('Author - Test Book (2).mp3');
      expect(byFrom['Title (10).mp3']).toBe('Author - Test Book (3).mp3');
    });

    it('orders already-suffixed (N) stems numerically, not lexicographically', async () => {
      // Lexicographic sort would order (10) < (100) < (2) because ')' < '0'.
      // Numeric sort must order (2) < (10) < (100), so re-numbering follows play order.
      await mockFiles(['Title (100).mp3', 'Title (2).mp3', 'Title (10).mp3']);

      const renames = await planFileRenames('/t', '{author} - {title}', book, 'Author');

      const byFrom = Object.fromEntries(renames.map(r => [r.from, r.to]));
      expect(byFrom['Title (2).mp3']).toBe('Author - Test Book (1).mp3');
      expect(byFrom['Title (10).mp3']).toBe('Author - Test Book (2).mp3');
      expect(byFrom['Title (100).mp3']).toBe('Author - Test Book (3).mp3');
    });
  });

  describe('already-unique format → untouched', () => {
    it('leaves {partName} stems untouched — no forced ordinal appended', async () => {
      const sources = Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(3, '0')}.mp3`);
      await mockFiles(sources);

      const renames = await planFileRenames('/t', '{title} - {partName}', book, 'Author');

      expect(renames[0]!.to).toBe('Test Book - 001.mp3');
      expect(renames[9]!.to).toBe('Test Book - 010.mp3');
      // No file gets a forced " (NN)" ordinal appended
      expect(renames.every(r => !/ \(\d+\)\.mp3$/.test(r.to))).toBe(true);
    });

    it('renders {trackNumber:000} as the post-sort play-order position, no double ordinal', async () => {
      const sources = Array.from({ length: 100 }, (_, i) => `Track${i + 1}.mp3`);
      await mockFiles(sources);

      const renames = await planFileRenames('/t', '{trackNumber:000}', book, 'Author');

      const byFrom = Object.fromEntries(renames.map(r => [r.from, r.to]));
      expect(byFrom['Track1.mp3']).toBe('001.mp3');
      expect(byFrom['Track10.mp3']).toBe('010.mp3');
      expect(byFrom['Track100.mp3']).toBe('100.mp3');
      // Token path renders unique stems → no appended " (NN)" ordinal
      expect(renames.every(r => !/\(\d+\)\.mp3$/.test(r.to))).toBe(true);
    });
  });

  describe('idempotence & ordering', () => {
    it('returns no renames when files are already correctly named ({trackNumber:000})', async () => {
      const correct = Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(3, '0')}.mp3`);
      await mockFiles(correct);

      const renames = await planFileRenames('/t', '{trackNumber:000}', book, 'Author');

      expect(renames).toHaveLength(0);
    });

    it('keeps track 1 at position 1 when re-running after a colliding pass', async () => {
      // After a colliding pass the files are "<stem> (001)…(254)"; re-rendering with
      // {trackNumber:000} must keep play order (001 first), not reorder lexicographically.
      const afterCollision = Array.from({ length: 254 }, (_, i) => `Author - Test Book (${String(i + 1).padStart(3, '0')}).mp3`);
      await mockFiles(afterCollision);

      const renames = await planFileRenames('/t', '{trackNumber:000}', book, 'Author');
      const byFrom = Object.fromEntries(renames.map(r => [r.from, r.to]));
      expect(byFrom['Author - Test Book (001).mp3']).toBe('001.mp3');
      expect(byFrom['Author - Test Book (254).mp3']).toBe('254.mp3');
    });
  });

  describe('254-track multi-disc regression', () => {
    it('renames padded 001…254 to sequential play order on the colliding format', async () => {
      const sources = Array.from({ length: 254 }, (_, i) => `${String(i + 1).padStart(3, '0')}.mp3`);
      await mockFiles(sources);

      const renames = await planFileRenames('/t', '{author} - {title}', book, 'Author');

      const byFrom = Object.fromEntries(renames.map(r => [r.from, r.to]));
      // Real track 1 stays at position 1, padded to 3 digits
      expect(byFrom['001.mp3']).toBe('Author - Test Book (001).mp3');
      expect(byFrom['254.mp3']).toBe('Author - Test Book (254).mp3');
      expect(new Set(renames.map(r => r.to)).size).toBe(254);
    });

    it('renames unpadded sources to sequential 001…254 on the token format', async () => {
      const sources = Array.from({ length: 254 }, (_, i) => `Track${i + 1}.mp3`);
      await mockFiles(sources);

      const renames = await planFileRenames('/t', '{trackNumber:000}', book, 'Author');

      const byFrom = Object.fromEntries(renames.map(r => [r.from, r.to]));
      expect(byFrom['Track1.mp3']).toBe('001.mp3');
      expect(byFrom['Track254.mp3']).toBe('254.mp3');
    });
  });

  describe('single-file books', () => {
    it('does not force a track ordinal on a single-file book', async () => {
      await mockFiles(['audiobook.mp3']);

      const renames = await planFileRenames('/t', '{author} - {title}', book, 'Author');

      expect(renames).toEqual([{ from: 'audiobook.mp3', to: 'Author - Test Book.mp3' }]);
    });
  });

  describe('{edition} file token (#1712)', () => {
    it('renders book.editionLabel via the {edition} token', async () => {
      await mockFiles(['audiobook.mp3']);
      const renames = await planFileRenames('/t', '{title} ({edition})', { ...book, editionLabel: 'Full Cast' }, 'Author');
      expect(renames).toEqual([{ from: 'audiobook.mp3', to: 'Test Book (Full Cast).mp3' }]);
    });

    it('renders empty (no stray brackets) when editionLabel is null', async () => {
      await mockFiles(['audiobook.mp3']);
      const renames = await planFileRenames('/t', '{title} ({edition})', { ...book, editionLabel: null }, 'Author');
      expect(renames).toEqual([{ from: 'audiobook.mp3', to: 'Test Book.mp3' }]);
    });
  });

  describe('ordering source', () => {
    it('does not import metadata/tag readers on the rename path (filenames only, no ID3)', async () => {
      const { readFile } = await import('node:fs/promises');
      const source = await readFile(new URL('./paths.ts', import.meta.url), 'utf-8');
      expect(source).not.toMatch(/music-metadata/);
      expect(source).not.toMatch(/retag-plan/);
      expect(source).not.toMatch(/audio-scanner/);
      expect(source).not.toMatch(/chapter-resolver/);
    });
  });
});
