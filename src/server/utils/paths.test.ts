import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Dirent } from 'node:fs';
import { renameFilesWithTemplate } from './paths.js';
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

    it('propagates errors thrown inside onProgress callback', async () => {
      const { readdir, rename } = await import('node:fs/promises');
      vi.mocked(readdir).mockResolvedValue([
        makeDirent('a.mp3', true),
        makeDirent('b.mp3', true),
      ] as never);
      vi.mocked(rename).mockResolvedValue(undefined);

      const onProgress = vi.fn().mockImplementation(() => {
        throw new Error('callback error');
      });

      await expect(
        renameFilesWithTemplate('/target', '{title}', book, 'Author', log, undefined, onProgress),
      ).rejects.toThrow('callback error');
    });
  });
});
