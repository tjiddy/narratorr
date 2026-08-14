import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockLogger, createMockDb, mockDbChain, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { RenameService, RenameError } from './rename.service.js';
import { renameFilesWithTemplate, PathOutsideLibraryError } from '../utils/paths.js';
import { recoverInterruptedCommit } from '../utils/recover-interrupted-commit.js';
import { claimLockKey } from '../utils/claim-lock.js';
import { hasPendingPathWrite } from '../utils/path-write-lock.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { rename, readdir, mkdir, stat, lstat, rmdir, rm, cp, realpath } from 'node:fs/promises';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    rename: vi.fn(),
    readdir: vi.fn(),
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    rm: vi.fn(),
    cp: vi.fn(),
    realpath: vi.fn(),
  };
});

// Mocked fs short-circuits marker recovery; real-disk coverage lives in rename.service.marker.test.ts.
vi.mock('../utils/recover-interrupted-commit.js', () => ({
  recoverInterruptedCommit: vi.fn().mockResolvedValue(undefined),
}));

const mockAuthor = createMockDbAuthor();
const mockBook = {
  ...createMockDbBook({
    path: '/library/Brandon Sanderson/The Way of Kings',
    status: 'imported',
    seriesName: 'The Stormlight Archive',
    seriesPosition: 1,
  }),
  authors: [mockAuthor],
};

const libraryOverrides = {
  library: {
    path: '/library',
    folderFormat: '{author}/{title}',
    fileFormat: '{author} - {title}',
  },
};

function createService() {
  const db = createMockDb();
  const bookService = {
    getById: vi.fn(),
    getAll: vi.fn(),
    update: vi.fn(),
  };
  const settingsService = createMockSettingsService(libraryOverrides);
  const log = createMockLogger();
  const connector = { notifyRefresh: vi.fn().mockResolvedValue(undefined) };

  const service = new RenameService(
    inject<Db>(db),
    inject<BookService>(bookService),
    inject<SettingsService>(settingsService),
    inject<FastifyBaseLogger>(log),
    undefined,
    inject<never>(connector),
  );

  return { service, db, bookService, settingsService, log, connector };
}

describe('RenameService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (stat as Mock).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // The occupancy classifier calls lstat, not stat; leaving it unmocked would silently exercise
    // the real filesystem, and a blanket resolve would make every synthetic target read as
    // occupied (the mocked readdir is armed per test).
    (lstat as Mock).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    (readdir as Mock).mockResolvedValue([]);
    (rename as Mock).mockResolvedValue(undefined);
    (mkdir as Mock).mockResolvedValue(undefined);
    (rm as Mock).mockResolvedValue(undefined);
    // Synthetic paths default to ENOENT; containment tests override realpath as needed.
    (realpath as Mock).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  describe('planRename', () => {
    it('returns both folderMove and fileRenames when book is misplaced and files mismatch', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/Wrong Author/Old Title' };
      bookService.getById.mockResolvedValue(book);
      (readdir as Mock).mockResolvedValue([
        { name: 'foo.m4b', isFile: () => true },
      ]);

      const plan = await service.planRename(1);

      expect(plan.folderMove).toEqual({
        from: 'Wrong Author/Old Title',
        to: 'Brandon Sanderson/The Way of Kings',
      });
      expect(plan.fileRenames).toHaveLength(1);
      expect(plan.fileRenames[0]).toEqual({
        from: 'foo.m4b',
        to: 'Brandon Sanderson - The Way of Kings.m4b',
      });
    });

    it('returns folderMove: null when book is already at its target folder', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);
      (readdir as Mock).mockResolvedValue([
        { name: 'foo.m4b', isFile: () => true },
      ]);

      const plan = await service.planRename(1);

      expect(plan.folderMove).toBeNull();
    });

    it('returns fileRenames: [] when librarySettings.fileFormat is empty', async () => {
      const { service, bookService, settingsService } = createService();
      (settingsService.get as Mock).mockResolvedValue({ ...libraryOverrides.library, fileFormat: '' });
      const book = { ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);

      const plan = await service.planRename(1);

      expect(plan.fileRenames).toEqual([]);
    });

    it('returns fileRenames: [] when the book directory has no audio files', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);
      (readdir as Mock).mockResolvedValue([]);

      const plan = await service.planRename(1);

      expect(plan.fileRenames).toEqual([]);
    });

    it('returns a fully-empty plan when nothing would change', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);
      (readdir as Mock).mockResolvedValue([
        { name: 'Brandon Sanderson - The Way of Kings.m4b', isFile: () => true },
      ]);

      const plan = await service.planRename(1);

      expect(plan.folderMove).toBeNull();
      expect(plan.fileRenames).toEqual([]);
    });

    it('throws CONFLICT with structured details when target folder is occupied', async () => {
      const { service, db, bookService } = createService();
      const book = { ...mockBook, id: 1, path: '/library/wrong/path' };
      bookService.getById.mockResolvedValue(book);
      db.select.mockReturnValue(mockDbChain([
        { id: 2, title: 'The Way of Kings', path: '/library/Brandon Sanderson/The Way of Kings' },
      ]));
      (stat as Mock).mockResolvedValue({ isFile: () => false, isDirectory: () => true });

      await expect(service.planRename(1)).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { conflictingBook: { id: 2, title: 'The Way of Kings' } },
      });
    });

    it('throws NOT_FOUND for an unknown bookId', async () => {
      const { service, bookService } = createService();
      bookService.getById.mockResolvedValue(null);

      await expect(service.planRename(999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws NO_PATH when the book row has no path', async () => {
      const { service, bookService } = createService();
      bookService.getById.mockResolvedValue({ ...mockBook, path: null });

      await expect(service.planRename(1)).rejects.toMatchObject({ code: 'NO_PATH' });
    });

    it('returns library-root-relative folder paths and bare filenames', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/Wrong Author/Old Title' };
      bookService.getById.mockResolvedValue(book);
      (readdir as Mock).mockResolvedValue([
        { name: 'foo.m4b', isFile: () => true },
      ]);

      const plan = await service.planRename(1);

      expect(plan.folderMove?.from.startsWith('/')).toBe(false);
      expect(plan.folderMove?.to.startsWith('/')).toBe(false);
      expect(plan.libraryRoot).toBe('/library');
      for (const r of plan.fileRenames) {
        expect(r.from).not.toContain('/');
        expect(r.to).not.toContain('/');
      }
    });

    it('parity (no folder move): planRename and renameBook produce identical fileRenames', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);
      bookService.update.mockResolvedValue(book);
      (readdir as Mock).mockResolvedValue([
        { name: 'a.m4b', isFile: () => true },
        { name: 'b.m4b', isFile: () => true },
      ]);

      const plan = await service.planRename(1);

      (rename as Mock).mockClear();
      await service.renameBook(1);

      const applyPairs = (rename as Mock).mock.calls.map((args: unknown[]) => {
        const from = (args[0] as string).split(/[/\\]/).pop()!;
        const to = (args[1] as string).split(/[/\\]/).pop()!;
        return { from, to };
      });

      expect(applyPairs).toEqual(plan.fileRenames);
    });

    it('parity (folder move + file renames): planRename and renameBook produce identical fileRenames', async () => {
      const { service, bookService } = createService();
      const oldPath = '/library/Wrong Author/Old Title';
      const targetPath = '/library/Brandon Sanderson/The Way of Kings';
      const book = { ...mockBook, path: oldPath };
      bookService.getById.mockResolvedValue(book);
      bookService.update.mockResolvedValue({ ...book, path: targetPath });
      // Preview and apply see the same file set because the folder move preserves its contents.
      (readdir as Mock).mockResolvedValue([
        { name: 'a.m4b', isFile: () => true },
        { name: 'b.m4b', isFile: () => true },
      ]);

      const plan = await service.planRename(1);

      expect(plan.folderMove).not.toBeNull();
      expect(plan.fileRenames.length).toBeGreaterThan(0);

      (rename as Mock).mockClear();
      await service.renameBook(1);

      const renameCalls = (rename as Mock).mock.calls;
      expect(renameCalls.length).toBe(1 + plan.fileRenames.length);
      const folderMoveCall = renameCalls[0]!;
      expect((folderMoveCall[0] as string).split('\\').join('/')).toBe(oldPath);
      expect((folderMoveCall[1] as string).split('\\').join('/')).toBe(targetPath);

      const applyPairs = renameCalls.slice(1).map((args: unknown[]) => {
        const from = (args[0] as string).split(/[/\\]/).pop()!;
        const to = (args[1] as string).split(/[/\\]/).pop()!;
        return { from, to };
      });
      expect(applyPairs).toEqual(plan.fileRenames);
    });

    it('purity: planRename does not call fs.rename / mkdir / cp / rm or bookService.update', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/Wrong Author/Old Title' };
      bookService.getById.mockResolvedValue(book);
      (readdir as Mock).mockResolvedValue([
        { name: 'foo.m4b', isFile: () => true },
      ]);

      await service.planRename(1);

      expect(rename).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(cp).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      expect(bookService.update).not.toHaveBeenCalled();
    });
  });

  describe('renameBook', () => {
    it('returns 200 with new path when rename succeeds', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/Wrong Author/Old Title' };
      bookService.getById.mockResolvedValue(book);
      bookService.getAll.mockResolvedValue({ data: [book], total: 1 });
      bookService.update.mockResolvedValue({ ...book, path: '/library/Brandon Sanderson/The Way of Kings' });

      const result = await service.renameBook(1);

      expect(result.oldPath).toBe('/library/Wrong Author/Old Title');
      expect(result.newPath).toContain('Brandon Sanderson');
      expect(result.newPath).toContain('The Way of Kings');
      expect(bookService.update).toHaveBeenCalledWith(1, expect.objectContaining({ path: expect.any(String) }));
    });

    it('builds correct target path from folder format template + book metadata', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/old-path' };
      bookService.getById.mockResolvedValue(book);
      bookService.getAll.mockResolvedValue({ data: [book], total: 1 });
      bookService.update.mockResolvedValue(book);

      const result = await service.renameBook(1);

      expect(result.newPath).toMatch(/Brandon Sanderson/);
      expect(result.newPath).toMatch(/The Way of Kings/);
    });

    it('moves files via fs.rename()', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/wrong/path' };
      bookService.getById.mockResolvedValue(book);
      bookService.getAll.mockResolvedValue({ data: [book], total: 1 });
      bookService.update.mockResolvedValue(book);

      await service.renameBook(1);

      expect(rename).toHaveBeenCalled();
    });

    it('returns no-op when target path matches current path and no files to rename', async () => {
      const { service, bookService, settingsService } = createService();
      (settingsService.get as Mock).mockResolvedValue({ ...libraryOverrides.library, fileFormat: '' });
      const book = { ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);

      const result = await service.renameBook(1);

      expect(result.message).toBe('Already organized');
      expect(result.filesRenamed).toBe(0);
      expect(bookService.update).not.toHaveBeenCalled();
    });

    it('throws NOT_FOUND when book does not exist', async () => {
      const { service, bookService } = createService();
      bookService.getById.mockResolvedValue(null);

      await expect(service.renameBook(999)).rejects.toThrow(RenameError);
      await expect(service.renameBook(999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws NO_PATH when book has no path', async () => {
      const { service, bookService } = createService();
      bookService.getById.mockResolvedValue({ ...mockBook, path: null });

      await expect(service.renameBook(1)).rejects.toThrow(RenameError);
      await expect(service.renameBook(1)).rejects.toMatchObject({ code: 'NO_PATH' });
    });

    it('throws CONFLICT when target path belongs to a different book', async () => {
      const { service, db, bookService } = createService();
      const book = { ...mockBook, id: 1, path: '/library/wrong/path' };
      const otherBook = { ...mockBook, id: 2, title: 'The Way of Kings', path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);
      db.select.mockReturnValue(mockDbChain([otherBook]));
      (stat as Mock).mockResolvedValue({ isFile: () => false, isDirectory: () => true });

      await expect(service.renameBook(1)).rejects.toThrow(RenameError);
      await expect(service.renameBook(1)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('same-book target path is a no-op, not an error', async () => {
      const { service, bookService, settingsService } = createService();
      (settingsService.get as Mock).mockResolvedValue({ ...libraryOverrides.library, fileFormat: '' });
      const book = { ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);

      const result = await service.renameBook(1);

      expect(result.message).toBe('Already organized');
    });

    it('updates DB path before file rename so partial failure does not leave stale path', async () => {
      const { service, bookService, settingsService } = createService();
      (settingsService.get as Mock).mockResolvedValue({ ...libraryOverrides.library, fileFormat: '{title}' });
      const book = { ...mockBook, path: '/library/Wrong Author/Old Title' };
      bookService.getById.mockResolvedValue(book);
      bookService.getAll.mockResolvedValue({ data: [book], total: 1 });
      bookService.update.mockResolvedValue({ ...book, path: '/library/Brandon Sanderson/The Way of Kings' });

      (readdir as Mock).mockResolvedValue([
        { name: 'file1.m4b', isFile: () => true },
      ]);
      (rename as Mock)
        .mockResolvedValueOnce(undefined)  // folder move
        .mockRejectedValueOnce(new Error('EACCES'));  // file rename

      await expect(service.renameBook(1)).rejects.toThrow('EACCES');

      expect(bookService.update).toHaveBeenCalledWith(1, expect.objectContaining({ path: expect.any(String) }));
    });

    it('handles cross-volume move with copy+delete fallback (EXDEV)', async () => {
      const { service, bookService } = createService();
      // EXDEV can occur across bind mounts without leaving the library root.
      const book = { ...mockBook, path: '/library/Wrong Author/Old Title' };
      bookService.getById.mockResolvedValue(book);
      bookService.getAll.mockResolvedValue({ data: [book], total: 1 });
      bookService.update.mockResolvedValue(book);

      (rename as Mock).mockRejectedValueOnce(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));

      await service.renameBook(1);

      expect(cp).toHaveBeenCalled();
      expect(rm).toHaveBeenCalled();
    });

    it('converges the commit-pending marker on oldPath before moving the folder', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/Wrong Author/Old Title' };
      bookService.getById.mockResolvedValue(book);
      bookService.update.mockResolvedValue(book);
      (readdir as Mock).mockResolvedValue([{ name: 'foo.m4b', isFile: () => true }]);

      await service.renameBook(1);

      expect(recoverInterruptedCommit).toHaveBeenCalledWith(
        '/library/Wrong Author/Old Title',
        '/library',
        expect.anything(),
      );
      const recoverOrder = (recoverInterruptedCommit as Mock).mock.invocationCallOrder[0]!;
      const renameOrder = (rename as Mock).mock.invocationCallOrder[0]!;
      expect(recoverOrder).toBeLessThan(renameOrder);
    });

    it('converges the marker even when pathChanged is false (file-template rename only)', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);
      (readdir as Mock).mockResolvedValue([{ name: 'old-name.m4b', isFile: () => true }]);

      await service.renameBook(1);

      expect(recoverInterruptedCommit).toHaveBeenCalledWith(
        '/library/Brandon Sanderson/The Way of Kings',
        '/library',
        expect.anything(),
      );
    });

    it('aborts the rename when recovery throws, leaving DB and disk untouched', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/Wrong Author/Old Title' };
      bookService.getById.mockResolvedValue(book);
      (recoverInterruptedCommit as Mock).mockRejectedValueOnce(new Error('recovery failed'));

      await expect(service.renameBook(1)).rejects.toThrow('recovery failed');

      expect(rename).not.toHaveBeenCalled();
      expect(bookService.update).not.toHaveBeenCalled();
    });

    describe('library-root containment guard (#1550)', () => {
      it('rejects an outside-root book.path before recovery, move, or DB update (folder-move branch)', async () => {
        const { service, bookService } = createService();
        bookService.getById.mockResolvedValue({ ...mockBook, path: '/etc' });

        await expect(service.renameBook(1)).rejects.toThrow(PathOutsideLibraryError);

        expect(recoverInterruptedCommit).not.toHaveBeenCalled();
        expect(rename).not.toHaveBeenCalled();
        expect(cp).not.toHaveBeenCalled();
        expect(rm).not.toHaveBeenCalled();
        expect(bookService.update).not.toHaveBeenCalled();
      });

      it('rejects a sibling-prefix book.path (/library2 vs /library)', async () => {
        const { service, bookService } = createService();
        bookService.getById.mockResolvedValue({ ...mockBook, path: '/library2/Author/Title' });

        await expect(service.renameBook(1)).rejects.toThrow(PathOutsideLibraryError);
        expect(recoverInterruptedCommit).not.toHaveBeenCalled();
        expect(rename).not.toHaveBeenCalled();
      });

      it('rejects a `..`-escaping book.path', async () => {
        const { service, bookService } = createService();
        bookService.getById.mockResolvedValue({ ...mockBook, path: '/library/../etc/passwd' });

        await expect(service.renameBook(1)).rejects.toThrow(PathOutsideLibraryError);
        expect(rename).not.toHaveBeenCalled();
      });

      it('rejects an in-library symlink whose realpath escapes the root', async () => {
        const { service, bookService } = createService();
        bookService.getById.mockResolvedValue({ ...mockBook, path: '/library/escape-link' });
        (realpath as Mock)
          .mockResolvedValueOnce('/library')        // realpath(libraryRoot)
          .mockResolvedValueOnce('/etc/secret');    // realpath(oldPath) escapes

        await expect(service.renameBook(1)).rejects.toThrow(PathOutsideLibraryError);
        expect(recoverInterruptedCommit).not.toHaveBeenCalled();
        expect(rename).not.toHaveBeenCalled();
      });

      it('rejects on the !pathChanged branch before in-place file renames (symlink escape)', async () => {
        const { service, bookService } = createService();
        bookService.getById.mockResolvedValue({ ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' });
        (readdir as Mock).mockResolvedValue([{ name: 'foo.m4b', isFile: () => true }]);
        (realpath as Mock)
          .mockResolvedValueOnce('/library')
          .mockResolvedValueOnce('/etc/escaped');

        await expect(service.renameBook(1)).rejects.toThrow(PathOutsideLibraryError);
        expect(recoverInterruptedCommit).not.toHaveBeenCalled();
        expect(rename).not.toHaveBeenCalled();
      });

      it('swallows ENOENT for an in-library path missing on disk — no spurious rejection', async () => {
        const { service, bookService } = createService();
        const book = { ...mockBook, path: '/library/Wrong Author/Old Title' };
        bookService.getById.mockResolvedValue(book);
        bookService.update.mockResolvedValue(book);
        await service.renameBook(1);

        expect(recoverInterruptedCommit).toHaveBeenCalled();
        expect(rename).toHaveBeenCalled();
      });

      it('allows an in-library path whose realpath stays inside the root', async () => {
        const { service, bookService } = createService();
        const book = { ...mockBook, path: '/library/Wrong Author/Old Title' };
        bookService.getById.mockResolvedValue(book);
        bookService.update.mockResolvedValue(book);
        (realpath as Mock)
          .mockResolvedValueOnce('/library')
          .mockResolvedValueOnce('/library/Wrong Author/Old Title');

        const result = await service.renameBook(1);

        expect(result.newPath).toContain('Brandon Sanderson');
        expect(rename).toHaveBeenCalled();
      });
    });
  });

  describe('ownership fence', () => {
    const otherOwner = [{ id: 2, title: 'Someone Else', path: '/library/Brandon Sanderson/The Way of Kings' }];

    it('uses a targeted DB query instead of bookService.getAll()', async () => {
      const { service, db, bookService } = createService();
      const book = { ...mockBook, id: 1, path: '/library/wrong/path' };
      bookService.getById.mockResolvedValue(book);
      bookService.update.mockResolvedValue({ ...book, path: '/library/Brandon Sanderson/The Way of Kings' });
      db.select.mockReturnValue(mockDbChain([]));

      await service.renameBook(1);

      expect(bookService.getAll).not.toHaveBeenCalled();
      expect(db.select).toHaveBeenCalled();
    });

    // The inversion of the test that pinned the defect: the ownership lookup used to be gated on
    // the target existing on disk, so a path another row owned but that was absent from disk was
    // never checked at all.
    it('queries the DB even when the target is absent from disk', async () => {
      const { service, db, bookService } = createService();
      const book = { ...mockBook, id: 1, path: '/library/wrong/path' };
      bookService.getById.mockResolvedValue(book);
      bookService.update.mockResolvedValue(book);
      db.select.mockReturnValue(mockDbChain([]));

      await service.renameBook(1);

      expect(bookService.getAll).not.toHaveBeenCalled();
      expect(db.select).toHaveBeenCalled();
    });

    it('refuses a target owned by another row with nothing at that path on disk, mutating nothing', async () => {
      const { service, db, bookService } = createService();
      const book = { ...mockBook, id: 1, path: '/library/Wrong/Old' };
      bookService.getById.mockResolvedValue(book);
      db.select.mockReturnValue(mockDbChain(otherOwner));

      const error = await service.renameBook(1).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RenameError);
      expect((error as RenameError).code).toBe('CONFLICT');
      expect((error as RenameError).details).toEqual({ conflictingBook: { id: 2, title: 'Someone Else' } });
      expect(rename).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(cp).not.toHaveBeenCalled();
      expect(bookService.update).not.toHaveBeenCalled();
    });

    it('surfaces the same absent-on-disk conflict through planRename with structured details', async () => {
      const { service, db, bookService } = createService();
      bookService.getById.mockResolvedValue({ ...mockBook, id: 1, path: '/library/Wrong/Old' });
      db.select.mockReturnValue(mockDbChain(otherOwner));

      const error = await service.planRename(1).catch((e: unknown) => e);

      expect((error as RenameError).code).toBe('CONFLICT');
      expect((error as RenameError).details).toEqual({ conflictingBook: { id: 2, title: 'Someone Else' } });
    });

    it.each([
      ['/library/Brandon Sanderson/The Way of Kings/', 'trailing separator'],
      ['/library/Brandon Sanderson//The Way of Kings', 'repeated separator'],
      ['/library/Brandon Sanderson/./The Way of Kings', 'dot segment'],
      ['/library/Brandon Sanderson/X/../The Way of Kings', 'parent segment'],
      ['/library\\Brandon Sanderson\\X\\..\\The Way of Kings', 'backslashes plus a parent segment'],
    ])('recognises a legacy spelling stored as %s (%s) as the same claim', async (storedPath) => {
      const { service, db, bookService } = createService();
      bookService.getById.mockResolvedValue({ ...mockBook, id: 1, path: '/library/Wrong/Old' });
      db.select.mockReturnValue(mockDbChain([{ id: 2, title: 'Someone Else', path: storedPath }]));

      const error = await service.renameBook(1).catch((e: unknown) => e);

      expect((error as RenameError).code).toBe('CONFLICT');
      expect(rename).not.toHaveBeenCalled();
    });

    it.each(['/library/Brandon Sanderson/The Way of Kings 2', '/library/Brandon Sanderson/The Way of Kings/sub', '/library/Brandon Sanderson/The Way of KingsX'])(
      'does not conflict against a merely adjacent path %s',
      async (storedPath) => {
        const { service, db, bookService } = createService();
        const book = { ...mockBook, id: 1, path: '/library/Wrong/Old' };
        bookService.getById.mockResolvedValue(book);
        bookService.update.mockResolvedValue(book);
        db.select.mockReturnValue(mockDbChain([{ id: 2, title: 'Someone Else', path: storedPath }]));

        await expect(service.renameBook(1)).resolves.toMatchObject({ filesRenamed: expect.any(Number) });
        expect(rename).toHaveBeenCalled();
      },
    );

    it('names the lowest-id owner when a pre-existing duplicate-path pair both match', async () => {
      const { service, db, bookService } = createService();
      bookService.getById.mockResolvedValue({ ...mockBook, id: 1, path: '/library/Wrong/Old' });
      db.select.mockReturnValue(mockDbChain([
        { id: 9, title: 'Higher Id Owner', path: '/library/Brandon Sanderson/The Way of Kings/' },
        { id: 4, title: 'Lower Id Owner', path: '/library/Brandon Sanderson/X/../The Way of Kings' },
      ]));

      const applyError = await service.renameBook(1).catch((e: unknown) => e);
      const previewError = await service.planRename(1).catch((e: unknown) => e);

      // Both surfaces must name the same row, or the conflict banner changes between preview and
      // apply. The rows are handed back highest-id first so "first match" cannot pass this.
      expect((applyError as RenameError).details).toEqual({ conflictingBook: { id: 4, title: 'Lower Id Owner' } });
      expect((previewError as RenameError).details).toEqual({ conflictingBook: { id: 4, title: 'Lower Id Owner' } });
    });

    it('rewrites no other row while refusing — this issue reads stored paths, it does not repair them', async () => {
      const { service, db, bookService } = createService();
      bookService.getById.mockResolvedValue({ ...mockBook, id: 1, path: '/library/Wrong/Old' });
      db.select.mockReturnValue(mockDbChain(otherOwner));

      await service.renameBook(1).catch(() => undefined);

      expect(db.update).not.toHaveBeenCalled();
      expect(bookService.update).not.toHaveBeenCalled();
    });

    it('takes only the source claim key and runs no ownership query when the path is unchanged', async () => {
      const { service, db, bookService } = createService();
      const book = { ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);
      (readdir as Mock).mockResolvedValue([{ name: 'old.m4b', isFile: () => true }]);

      const result = await service.renameBook(1);

      expect(db.select).not.toHaveBeenCalled();
      expect(result.filesRenamed).toBe(1);
      expect(hasPendingPathWrite(claimLockKey('/library/Brandon Sanderson/The Way of Kings'))).toBe(false);
    });
  });

  describe('target occupancy', () => {
    const seedMisplacedBook = (bookService: { getById: Mock; update: Mock }) => {
      const book = { ...mockBook, id: 1, path: '/library/Wrong/Old' };
      bookService.getById.mockResolvedValue(book);
      bookService.update.mockResolvedValue(book);
      return book;
    };

    it('proceeds when the target is absent from disk', async () => {
      const { service, bookService } = createService();
      seedMisplacedBook(bookService);

      await service.renameBook(1);

      expect(rename).toHaveBeenCalled();
      // cleanEmptyParents legitimately rmdirs vacated parents; nothing touches the target itself.
      expect(rmdir).not.toHaveBeenCalledWith(expect.stringContaining('The Way of Kings'));
    });

    it('refuses an unowned directory holding an entry, moving nothing and leaving books.path alone', async () => {
      const { service, bookService } = createService();
      seedMisplacedBook(bookService);
      (lstat as Mock).mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false });
      (readdir as Mock).mockResolvedValue(['stranger.m4b']);

      const error = await service.renameBook(1).catch((e: unknown) => e);

      expect((error as RenameError).code).toBe('TARGET_OCCUPIED');
      expect((error as Error).message).toContain('The Way of Kings');
      expect(rename).not.toHaveBeenCalled();
      expect(bookService.update).not.toHaveBeenCalled();
    });

    it('refuses a regular file at the target without letting ENOTDIR escape', async () => {
      const { service, bookService } = createService();
      seedMisplacedBook(bookService);
      (lstat as Mock).mockResolvedValue({ isDirectory: () => false, isSymbolicLink: () => false });

      const error = await service.renameBook(1).catch((e: unknown) => e);

      expect((error as RenameError).code).toBe('TARGET_OCCUPIED');
      expect((error as Error).message).not.toContain('ENOTDIR');
      expect(rename).not.toHaveBeenCalled();
    });

    it('refuses a symlink at the target even when it points at an empty directory', async () => {
      const { service, bookService } = createService();
      seedMisplacedBook(bookService);
      (lstat as Mock).mockResolvedValue({ isDirectory: () => false, isSymbolicLink: () => true });
      (readdir as Mock).mockResolvedValue([]);

      const error = await service.renameBook(1).catch((e: unknown) => e);

      expect((error as RenameError).code).toBe('TARGET_OCCUPIED');
      expect(rename).not.toHaveBeenCalled();
    });

    it('removes a verified-empty target before the move rather than relying on POSIX rename(2)', async () => {
      const { service, bookService } = createService();
      seedMisplacedBook(bookService);
      (lstat as Mock).mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false });
      (readdir as Mock).mockResolvedValue([]);
      (rmdir as Mock).mockResolvedValue(undefined);

      await service.renameBook(1);

      expect(rmdir).toHaveBeenCalledWith(expect.stringContaining('The Way of Kings'));
      const rmdirOrder = (rmdir as Mock).mock.invocationCallOrder[0]!;
      const renameOrder = (rename as Mock).mock.invocationCallOrder[0]!;
      expect(rmdirOrder).toBeLessThan(renameOrder);
    });

    it('refuses when the verified-empty target gained an entry before the move', async () => {
      const { service, bookService } = createService();
      seedMisplacedBook(bookService);
      (lstat as Mock).mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false });
      (readdir as Mock).mockResolvedValue([]);
      (rmdir as Mock).mockRejectedValue(Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' }));

      const error = await service.renameBook(1).catch((e: unknown) => e);

      expect((error as RenameError).code).toBe('TARGET_OCCUPIED');
      expect(rename).not.toHaveBeenCalled();
      expect(bookService.update).not.toHaveBeenCalled();
    });

    it('classifies before the ownership question is settled only — an owned target still reports CONFLICT', async () => {
      const { service, db, bookService } = createService();
      seedMisplacedBook(bookService);
      (lstat as Mock).mockResolvedValue({ isDirectory: () => false, isSymbolicLink: () => false });
      db.select.mockReturnValue(mockDbChain([{ id: 2, title: 'Someone Else', path: '/library/Brandon Sanderson/The Way of Kings' }]));

      const error = await service.renameBook(1).catch((e: unknown) => e);

      expect((error as RenameError).code).toBe('CONFLICT');
    });

    it('surfaces an occupied unowned target through planRename too', async () => {
      const { service, bookService } = createService();
      bookService.getById.mockResolvedValue({ ...mockBook, id: 1, path: '/library/Wrong/Old' });
      (lstat as Mock).mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false });
      (readdir as Mock).mockResolvedValue(['stranger.m4b']);

      const error = await service.planRename(1).catch((e: unknown) => e);

      expect((error as RenameError).code).toBe('TARGET_OCCUPIED');
      expect((error as RenameError).details).toBeUndefined();
    });
  });

  describe('post-lock re-verification', () => {
    /** Gate the settings read, which happens after the pre-lock row read and before the lock. */
    const raceRow = (bookService: { getById: Mock }, planned: unknown, fresh: unknown) => {
      bookService.getById.mockResolvedValueOnce(planned).mockResolvedValue(fresh);
    };

    const assertNothingMutated = (bookService: { update: Mock }) => {
      expect(rename).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(cp).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      expect(bookService.update).not.toHaveBeenCalled();
    };

    it('reports NOT_FOUND when the row vanished inside the lock', async () => {
      const { service, bookService } = createService();
      raceRow(bookService, { ...mockBook, id: 1, path: '/library/Wrong/Old' }, null);

      const error = await service.renameBook(1).catch((e: unknown) => e);

      expect((error as RenameError).code).toBe('NOT_FOUND');
      assertNothingMutated(bookService);
    });

    it('reports NO_PATH when the row lost its path inside the lock', async () => {
      const { service, bookService } = createService();
      raceRow(bookService, { ...mockBook, id: 1, path: '/library/Wrong/Old' }, { ...mockBook, id: 1, path: null });

      const error = await service.renameBook(1).catch((e: unknown) => e);

      expect((error as RenameError).code).toBe('NO_PATH');
      assertNothingMutated(bookService);
    });

    it('reports STALE_PATH when the row moved inside the lock', async () => {
      const { service, bookService } = createService();
      raceRow(bookService, { ...mockBook, id: 1, path: '/library/Wrong/Old' }, { ...mockBook, id: 1, path: '/library/Wrong/Moved' });

      const error = await service.renameBook(1).catch((e: unknown) => e);

      expect((error as RenameError).code).toBe('STALE_PATH');
      expect((error as Error).message).toContain('/library/Wrong/Moved');
      assertNothingMutated(bookService);
    });

    it('proceeds when the fresh path differs only in spelling', async () => {
      const { service, bookService } = createService();
      raceRow(bookService, { ...mockBook, id: 1, path: '/library/Wrong/Old' }, { ...mockBook, id: 1, path: '/library/Wrong/X/../Old' });
      bookService.update.mockResolvedValue(undefined);

      await expect(service.renameBook(1)).resolves.toMatchObject({ oldPath: '/library/Wrong/Old' });
      expect(rename).toHaveBeenCalled();
    });
  });

  describe('renameFilesWithTemplate', () => {
    it('renames files using file format template', async () => {
      const { log } = createService();
      (readdir as Mock).mockResolvedValue([
        { name: 'old-name.m4b', isFile: () => true },
      ]);

      const count = await renameFilesWithTemplate(
        '/library/test',
        '{author} - {title}',
        mockBook,
        'Brandon Sanderson',
        inject<FastifyBaseLogger>(log),
      );

      expect(count).toBe(1);
      expect(rename).toHaveBeenCalled();
    });

    it('returns 0 when no files need renaming', async () => {
      const { log } = createService();
      (readdir as Mock).mockResolvedValue([
        { name: 'Brandon Sanderson - The Way of Kings.m4b', isFile: () => true },
      ]);

      const count = await renameFilesWithTemplate(
        '/library/test',
        '{author} - {title}',
        mockBook,
        'Brandon Sanderson',
        inject<FastifyBaseLogger>(log),
      );

      expect(count).toBe(0);
    });

    it('attempts rollback when rename fails mid-operation', async () => {
      const { log } = createService();
      (readdir as Mock).mockResolvedValue([
        { name: 'file1.m4b', isFile: () => true },
        { name: 'file2.m4b', isFile: () => true },
      ]);
      (rename as Mock)
        .mockResolvedValueOnce(undefined)  // first file succeeds
        .mockRejectedValueOnce(new Error('EACCES'));  // second file fails

      await expect(
        renameFilesWithTemplate('/library/test', '{title}', mockBook, 'Brandon Sanderson', inject<FastifyBaseLogger>(log)),
      ).rejects.toThrow('EACCES');

      expect(rename).toHaveBeenCalledTimes(3); // Two attempts plus one rollback.
    });

    it('continues rollback when one rollback fails', async () => {
      const { log } = createService();
      (readdir as Mock).mockResolvedValue([
        { name: 'file1.m4b', isFile: () => true },
        { name: 'file2.m4b', isFile: () => true },
        { name: 'file3.m4b', isFile: () => true },
      ]);
      (rename as Mock)
        .mockResolvedValueOnce(undefined)  // file1 rename succeeds
        .mockResolvedValueOnce(undefined)  // file2 rename succeeds
        .mockRejectedValueOnce(new Error('EACCES'))  // file3 rename fails → triggers rollback
        .mockRejectedValueOnce(new Error('EACCES'))  // rollback file2 fails
        .mockResolvedValueOnce(undefined);  // rollback file1 still attempted and succeeds

      await expect(
        renameFilesWithTemplate('/library/test', '{title}', mockBook, 'Brandon Sanderson', inject<FastifyBaseLogger>(log)),
      ).rejects.toThrow('EACCES');

      // Three forward attempts plus two reverse attempts.
      expect(rename).toHaveBeenCalledTimes(5);
    });

    it('logs error for each failed rollback when multiple rollbacks fail', async () => {
      const { log } = createService();
      (readdir as Mock).mockResolvedValue([
        { name: 'file1.m4b', isFile: () => true },
        { name: 'file2.m4b', isFile: () => true },
        { name: 'file3.m4b', isFile: () => true },
      ]);
      (rename as Mock)
        .mockResolvedValueOnce(undefined)       // file1 rename succeeds
        .mockResolvedValueOnce(undefined)       // file2 rename succeeds
        .mockRejectedValueOnce(new Error('EACCES'))  // file3 rename fails → triggers rollback
        .mockRejectedValueOnce(new Error('EBUSY'))   // rollback file2 fails
        .mockRejectedValueOnce(new Error('EPERM'));   // rollback file1 also fails

      await expect(
        renameFilesWithTemplate('/library/test', '{title}', mockBook, 'Brandon Sanderson', inject<FastifyBaseLogger>(log)),
      ).rejects.toThrow('EACCES');

      expect(rename).toHaveBeenCalledTimes(5);
      const errorCalls = (log.error as ReturnType<typeof vi.fn>).mock.calls;
      const rollbackErrors = errorCalls.filter(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('Rollback failed'),
      );
      expect(rollbackErrors).toHaveLength(2);
    });

    it('does not log rollback error when single rollback succeeds', async () => {
      const { log } = createService();
      (readdir as Mock).mockResolvedValue([
        { name: 'file1.m4b', isFile: () => true },
        { name: 'file2.m4b', isFile: () => true },
      ]);
      (rename as Mock)
        .mockResolvedValueOnce(undefined)       // file1 rename succeeds
        .mockRejectedValueOnce(new Error('EACCES'))  // file2 rename fails → triggers rollback
        .mockResolvedValueOnce(undefined);       // rollback file1 succeeds

      await expect(
        renameFilesWithTemplate('/library/test', '{title}', mockBook, 'Brandon Sanderson', inject<FastifyBaseLogger>(log)),
      ).rejects.toThrow('EACCES');

      expect(rename).toHaveBeenCalledTimes(3);
      const errorCalls = (log.error as ReturnType<typeof vi.fn>).mock.calls;
      const rollbackErrors = errorCalls.filter(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('Rollback failed'),
      );
      expect(rollbackErrors).toHaveLength(0);
    });

    it('deduplicates colliding filenames', async () => {
      const { log } = createService();
      (readdir as Mock).mockResolvedValue([
        { name: 'a.m4b', isFile: () => true },
        { name: 'b.m4b', isFile: () => true },
      ]);

      await renameFilesWithTemplate(
        '/library/test',
        '{title}',
        mockBook,
        'Brandon Sanderson',
        inject<FastifyBaseLogger>(log),
      );

      const renameCalls = (rename as Mock).mock.calls;
      const newNames = renameCalls.map((call: unknown[]) => call[1] as string);
      expect(newNames).toHaveLength(2);
      expect(new Set(newNames).size).toBe(2);
    });

    it('forwards naming options to renderFilename for file renaming', async () => {
      const { log } = createService();
      (readdir as Mock).mockResolvedValue([
        { name: 'old-name.m4b', isFile: () => true },
      ]);

      await renameFilesWithTemplate(
        '/library/test',
        '{author} - {title}',
        mockBook,
        'Brandon Sanderson',
        inject<FastifyBaseLogger>(log),
        { separator: 'period', case: 'upper' },
      );

      expect(rename).toHaveBeenCalled();
      const newPath = (rename as Mock).mock.calls[0]![1] as string;
      expect(newPath).toContain('BRANDON.SANDERSON');
    });

    describe('single-file track token omission', () => {
      it('omits trackNumber, trackTotal, and partName from token map when audioFiles.length === 1', async () => {
        const { log } = createService();
        (readdir as Mock).mockResolvedValue([
          { name: 'audiobook.m4b', isFile: () => true },
        ]);

        await renameFilesWithTemplate(
          '/library/test',
          '{title} {trackNumber}',
          mockBook,
          'Brandon Sanderson',
          inject<FastifyBaseLogger>(log),
        );

        const newPath = (rename as Mock).mock.calls[0]![1] as string;
        expect(newPath).not.toContain('1');
        expect(newPath).toContain('The Way of Kings.m4b');
      });

      it('includes trackNumber, trackTotal, and partName in token map when audioFiles.length > 1', async () => {
        const { log } = createService();
        (readdir as Mock).mockResolvedValue([
          { name: 'ch1.m4b', isFile: () => true },
          { name: 'ch2.m4b', isFile: () => true },
          { name: 'ch3.m4b', isFile: () => true },
        ]);

        await renameFilesWithTemplate(
          '/library/test',
          '{trackNumber} - {title}',
          mockBook,
          'Brandon Sanderson',
          inject<FastifyBaseLogger>(log),
        );

        const renameCalls = (rename as Mock).mock.calls;
        expect(renameCalls).toHaveLength(3);
        expect((renameCalls[0]![1] as string)).toContain('1 - The Way of Kings');
        expect((renameCalls[1]![1] as string)).toContain('2 - The Way of Kings');
        expect((renameCalls[2]![1] as string)).toContain('3 - The Way of Kings');
      });

      it('renders single-file book with Plex preset without track suffix', async () => {
        const { log } = createService();
        (readdir as Mock).mockResolvedValue([
          { name: 'audiobook.m4b', isFile: () => true },
        ]);

        await renameFilesWithTemplate(
          '/library/test',
          '{title}{ - pt?trackNumber:00}',
          mockBook,
          'Brandon Sanderson',
          inject<FastifyBaseLogger>(log),
        );

        const newPath = ((rename as Mock).mock.calls[0]![1] as string).split('\\').join('/');
        expect(newPath).toBe('/library/test/The Way of Kings.m4b');
      });

      it('renders multi-file book with Plex preset with track suffixes', async () => {
        const { log } = createService();
        (readdir as Mock).mockResolvedValue([
          { name: 'ch1.m4b', isFile: () => true },
          { name: 'ch2.m4b', isFile: () => true },
        ]);

        await renameFilesWithTemplate(
          '/library/test',
          '{title}{ - pt?trackNumber:00}',
          mockBook,
          'Brandon Sanderson',
          inject<FastifyBaseLogger>(log),
        );

        const renameCalls = (rename as Mock).mock.calls;
        expect(renameCalls).toHaveLength(2);
        expect((renameCalls[0]![1] as string).split('\\').join('/')).toBe('/library/test/The Way of Kings - pt01.m4b');
        expect((renameCalls[1]![1] as string).split('\\').join('/')).toBe('/library/test/The Way of Kings - pt02.m4b');
      });

      it('includes track tokens for 2-file boundary case', async () => {
        const { log } = createService();
        (readdir as Mock).mockResolvedValue([
          { name: 'part1.m4b', isFile: () => true },
          { name: 'part2.m4b', isFile: () => true },
        ]);

        await renameFilesWithTemplate(
          '/library/test',
          '{title} {trackNumber} of {trackTotal}',
          mockBook,
          'Brandon Sanderson',
          inject<FastifyBaseLogger>(log),
        );

        const renameCalls = (rename as Mock).mock.calls;
        expect(renameCalls).toHaveLength(2);
        expect((renameCalls[0]![1] as string)).toContain('1 of 2');
        expect((renameCalls[1]![1] as string)).toContain('2 of 2');
      });

      it('produces identical output for single-file and multi-file when template has no track tokens', async () => {
        const { log } = createService();
        (readdir as Mock).mockResolvedValue([
          { name: 'audiobook.m4b', isFile: () => true },
        ]);

        await renameFilesWithTemplate(
          '/library/test',
          '{author} - {title}',
          mockBook,
          'Brandon Sanderson',
          inject<FastifyBaseLogger>(log),
        );

        const newPath = ((rename as Mock).mock.calls[0]![1] as string).split('\\').join('/');
        expect(newPath).toBe('/library/test/Brandon Sanderson - The Way of Kings.m4b');
      });

      it('omits conditional prefix separator when partName is absent for single-file book', async () => {
        const { log } = createService();
        (readdir as Mock).mockResolvedValue([
          { name: 'audiobook.m4b', isFile: () => true },
        ]);

        await renameFilesWithTemplate(
          '/library/test',
          '{title}{ - ?partName}',
          mockBook,
          'Brandon Sanderson',
          inject<FastifyBaseLogger>(log),
        );

        const newPath = ((rename as Mock).mock.calls[0]![1] as string).split('\\').join('/');
        expect(newPath).toBe('/library/test/The Way of Kings.m4b');
      });

      it('omits trackTotal from token map for single-file book', async () => {
        const { log } = createService();
        (readdir as Mock).mockResolvedValue([
          { name: 'audiobook.m4b', isFile: () => true },
        ]);

        await renameFilesWithTemplate(
          '/library/test',
          '{title}{ of ?trackTotal}',
          mockBook,
          'Brandon Sanderson',
          inject<FastifyBaseLogger>(log),
        );

        const newPath = ((rename as Mock).mock.calls[0]![1] as string).split('\\').join('/');
        expect(newPath).toBe('/library/test/The Way of Kings.m4b');
      });

      it('includes partName in token map for multi-file book', async () => {
        const { log } = createService();
        (readdir as Mock).mockResolvedValue([
          { name: 'ch1.m4b', isFile: () => true },
          { name: 'ch2.m4b', isFile: () => true },
        ]);

        await renameFilesWithTemplate(
          '/library/test',
          '{trackNumber} - {partName}',
          mockBook,
          'Brandon Sanderson',
          inject<FastifyBaseLogger>(log),
        );

        const renameCalls = (rename as Mock).mock.calls;
        expect(renameCalls).toHaveLength(2);
        expect((renameCalls[0]![1] as string).split('\\').join('/')).toBe('/library/test/1 - ch1.m4b');
        expect((renameCalls[1]![1] as string).split('\\').join('/')).toBe('/library/test/2 - ch2.m4b');
      });

      it('omits conditional suffix when trackNumber is absent for single-file book', async () => {
        const { log } = createService();
        (readdir as Mock).mockResolvedValue([
          { name: 'audiobook.m4b', isFile: () => true },
        ]);

        await renameFilesWithTemplate(
          '/library/test',
          '{title}{trackNumber:00?. }',
          mockBook,
          'Brandon Sanderson',
          inject<FastifyBaseLogger>(log),
        );

        const newPath = ((rename as Mock).mock.calls[0]![1] as string).split('\\').join('/');
        expect(newPath).toBe('/library/test/The Way of Kings.m4b');
      });
    });
  });

  describe('event history producers', () => {
    it('records renamed event on successful rename', async () => {
      const db = createMockDb();
      const eventHistory = { create: vi.fn().mockResolvedValue({ id: 1 }) };
      const bookService = {
        getById: vi.fn().mockResolvedValue(mockBook),
        getAll: vi.fn(),
        update: vi.fn(),
      };
      // Use a different folder format so the target path changes.
      const settingsService = createMockSettingsService({
        library: { ...libraryOverrides.library, folderFormat: '{author}/{series}/{title}' },
      });
      const log = createMockLogger();

      const service = new RenameService(
        inject<Db>(db),
        inject<BookService>(bookService),
        inject<SettingsService>(settingsService),
        inject<FastifyBaseLogger>(log),
        inject<EventHistoryService>(eventHistory),
      );

      (stat as Mock).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      (rename as Mock).mockResolvedValue(undefined);
      (readdir as Mock).mockResolvedValue([]);
      (mkdir as Mock).mockResolvedValue(undefined);

      await service.renameBook(1);

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 1,
          bookTitle: 'The Way of Kings',
          eventType: 'renamed',
          source: 'manual',
        }),
      );
    });

    it('emits comma-joined authorName for multi-author books', async () => {
      const db = createMockDb();
      const eventHistory = { create: vi.fn().mockResolvedValue({ id: 1 }) };
      const multiAuthorBook = {
        ...createMockDbBook({
          path: '/library/Author A/Multi Author Book',
          status: 'imported',
        }),
        authors: [
          createMockDbAuthor({ id: 1, name: 'Author A' }),
          createMockDbAuthor({ id: 2, name: 'Author B' }),
        ],
      };
      const bookService = {
        getById: vi.fn().mockResolvedValue(multiAuthorBook),
        getAll: vi.fn(),
        update: vi.fn(),
      };
      const settingsService = createMockSettingsService({
        library: { ...libraryOverrides.library, folderFormat: '{author}/{series}/{title}' },
      });
      const log = createMockLogger();

      const service = new RenameService(
        inject<Db>(db),
        inject<BookService>(bookService),
        inject<SettingsService>(settingsService),
        inject<FastifyBaseLogger>(log),
        inject<EventHistoryService>(eventHistory),
      );

      (stat as Mock).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      (rename as Mock).mockResolvedValue(undefined);
      (readdir as Mock).mockResolvedValue([]);
      (mkdir as Mock).mockResolvedValue(undefined);

      await service.renameBook(1);

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 1,
          bookTitle: multiAuthorBook.title,
          authorName: 'Author A, Author B',
          eventType: 'renamed',
        }),
      );
    });
  });

  describe('logging improvements (#229)', () => {
    it('already organized skip logged at debug with { bookId }', async () => {
      const { service, bookService, settingsService, log } = createService();
      (settingsService.get as Mock).mockResolvedValue({ ...libraryOverrides.library, fileFormat: '' });
      const book = { ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);

      await service.renameBook(1);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1 }),
        'Book already organized — skipping rename',
      );
    });
  });

  describe('connector refresh hook', () => {
    it('enqueues a rename refresh when files were renamed (no path change)', async () => {
      const { service, bookService, connector } = createService();
      const book = { ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);
      bookService.update.mockResolvedValue(book);
      (readdir as Mock).mockResolvedValue([{ name: 'a.m4b', isFile: () => true }]);

      await service.renameBook(1);

      expect(connector.notifyRefresh).toHaveBeenCalledWith('rename', [
        expect.objectContaining({ bookId: 1, title: book.title, libraryPath: book.path }),
      ]);
    });

    it('does NOT enqueue for a metadata-only edit (already organized, no path/file change)', async () => {
      const { service, bookService, settingsService, connector } = createService();
      (settingsService.get as Mock).mockResolvedValue({ ...libraryOverrides.library, fileFormat: '' });
      const book = { ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);

      await service.renameBook(1);

      expect(connector.notifyRefresh).not.toHaveBeenCalled();
    });
  });
});
