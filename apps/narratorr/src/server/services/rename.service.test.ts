import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { RenameService, RenameError } from './rename.service.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { FastifyBaseLogger } from 'fastify';
import { rename, readdir, mkdir, rmdir, stat, rm, cp } from 'node:fs/promises';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    rename: vi.fn(),
    readdir: vi.fn(),
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    stat: vi.fn(),
    rm: vi.fn(),
    cp: vi.fn(),
  };
});

const mockAuthor = createMockDbAuthor();
const mockBook = {
  ...createMockDbBook({
    path: '/library/Brandon Sanderson/The Way of Kings',
    status: 'imported',
    seriesName: 'The Stormlight Archive',
    seriesPosition: 1,
  }),
  author: mockAuthor,
};

const librarySettings = {
  path: '/library',
  folderFormat: '{author}/{title}',
  fileFormat: '{author} - {title}',
};

function createService() {
  const bookService = {
    getById: vi.fn(),
    getAll: vi.fn(),
    update: vi.fn(),
  };
  const settingsService = {
    get: vi.fn().mockResolvedValue(librarySettings),
  };
  const log = createMockLogger();

  const service = new RenameService(
    inject<BookService>(bookService),
    inject<SettingsService>(settingsService),
    inject<FastifyBaseLogger>(log),
  );

  return { service, bookService, settingsService, log };
}

describe('RenameService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (stat as Mock).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    (readdir as Mock).mockResolvedValue([]);
    (rename as Mock).mockResolvedValue(undefined);
    (mkdir as Mock).mockResolvedValue(undefined);
    (rm as Mock).mockResolvedValue(undefined);
  });

  describe('renameBook', () => {
    it('returns 200 with new path when rename succeeds', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/Wrong Author/Old Title' };
      bookService.getById.mockResolvedValue(book);
      bookService.getAll.mockResolvedValue([book]);
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
      bookService.getAll.mockResolvedValue([book]);
      bookService.update.mockResolvedValue(book);

      const result = await service.renameBook(1);

      // {author}/{title} with "Brandon Sanderson" and "The Way of Kings"
      expect(result.newPath).toMatch(/Brandon Sanderson/);
      expect(result.newPath).toMatch(/The Way of Kings/);
    });

    it('moves files via fs.rename()', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/library/wrong/path' };
      bookService.getById.mockResolvedValue(book);
      bookService.getAll.mockResolvedValue([book]);
      bookService.update.mockResolvedValue(book);

      await service.renameBook(1);

      expect(rename).toHaveBeenCalled();
    });

    it('returns no-op when target path matches current path and no files to rename', async () => {
      const { service, bookService, settingsService } = createService();
      // Path already matches what buildTargetPath would produce
      settingsService.get.mockResolvedValue({ ...librarySettings, fileFormat: '' });
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
      const { service, bookService } = createService();
      const book = { ...mockBook, id: 1, path: '/library/wrong/path' };
      const otherBook = { ...mockBook, id: 2, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);
      bookService.getAll.mockResolvedValue([book, otherBook]);
      (stat as Mock).mockResolvedValue({ isFile: () => false, isDirectory: () => true });

      await expect(service.renameBook(1)).rejects.toThrow(RenameError);
      await expect(service.renameBook(1)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('same-book target path is a no-op, not an error', async () => {
      const { service, bookService, settingsService } = createService();
      settingsService.get.mockResolvedValue({ ...librarySettings, fileFormat: '' });
      const book = { ...mockBook, path: '/library/Brandon Sanderson/The Way of Kings' };
      bookService.getById.mockResolvedValue(book);

      const result = await service.renameBook(1);

      expect(result.message).toBe('Already organized');
    });

    it('updates DB path before file rename so partial failure does not leave stale path', async () => {
      const { service, bookService, settingsService } = createService();
      settingsService.get.mockResolvedValue({ ...librarySettings, fileFormat: '{title}' });
      const book = { ...mockBook, path: '/library/Wrong Author/Old Title' };
      bookService.getById.mockResolvedValue(book);
      bookService.getAll.mockResolvedValue([book]);
      bookService.update.mockResolvedValue({ ...book, path: '/library/Brandon Sanderson/The Way of Kings' });

      // readdir returns files so renameFilesWithTemplate runs, but file rename fails
      (readdir as Mock).mockResolvedValue([
        { name: 'file1.m4b', isFile: () => true },
      ]);
      // First rename call is the folder move (succeeds), second is file rename (fails)
      (rename as Mock)
        .mockResolvedValueOnce(undefined)  // folder move
        .mockRejectedValueOnce(new Error('EACCES'));  // file rename

      await expect(service.renameBook(1)).rejects.toThrow('EACCES');

      // DB path should have been updated before the file rename failure
      expect(bookService.update).toHaveBeenCalledWith(1, expect.objectContaining({ path: expect.any(String) }));
    });

    it('handles cross-volume move with copy+delete fallback (EXDEV)', async () => {
      const { service, bookService } = createService();
      const book = { ...mockBook, path: '/volume1/wrong/path' };
      bookService.getById.mockResolvedValue(book);
      bookService.getAll.mockResolvedValue([book]);
      bookService.update.mockResolvedValue(book);

      // First rename call (folder move) throws EXDEV
      (rename as Mock).mockRejectedValueOnce(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));

      await service.renameBook(1);

      expect(cp).toHaveBeenCalled();
      expect(rm).toHaveBeenCalled();
    });
  });

  describe('renameFilesWithTemplate', () => {
    it('renames files using file format template', async () => {
      const { service } = createService();
      (readdir as Mock).mockResolvedValue([
        { name: 'old-name.m4b', isFile: () => true },
      ]);

      const count = await service.renameFilesWithTemplate(
        '/library/test',
        '{author} - {title}',
        mockBook,
        'Brandon Sanderson',
      );

      expect(count).toBe(1);
      expect(rename).toHaveBeenCalled();
    });

    it('returns 0 when no files need renaming', async () => {
      const { service } = createService();
      (readdir as Mock).mockResolvedValue([
        { name: 'Brandon Sanderson - The Way of Kings.m4b', isFile: () => true },
      ]);

      const count = await service.renameFilesWithTemplate(
        '/library/test',
        '{author} - {title}',
        mockBook,
        'Brandon Sanderson',
      );

      expect(count).toBe(0);
    });

    it('attempts rollback when rename fails mid-operation', async () => {
      const { service } = createService();
      (readdir as Mock).mockResolvedValue([
        { name: 'file1.m4b', isFile: () => true },
        { name: 'file2.m4b', isFile: () => true },
      ]);
      (rename as Mock)
        .mockResolvedValueOnce(undefined)  // first file succeeds
        .mockRejectedValueOnce(new Error('EACCES'));  // second file fails

      await expect(
        service.renameFilesWithTemplate('/library/test', '{title}', mockBook, 'Brandon Sanderson'),
      ).rejects.toThrow('EACCES');

      // Rollback: rename should be called to undo the first successful rename
      expect(rename).toHaveBeenCalledTimes(3); // 2 attempts + 1 rollback
    });

    it('deduplicates colliding filenames', async () => {
      const { service } = createService();
      // Two files, template produces same name for both
      (readdir as Mock).mockResolvedValue([
        { name: 'a.m4b', isFile: () => true },
        { name: 'b.m4b', isFile: () => true },
      ]);

      await service.renameFilesWithTemplate(
        '/library/test',
        '{title}',
        mockBook,
        'Brandon Sanderson',
      );

      // Should have renamed both files, second gets (2) suffix
      const renameCalls = (rename as Mock).mock.calls;
      const newNames = renameCalls.map((call: unknown[]) => call[1] as string);
      expect(newNames).toHaveLength(2);
      // Check they're different
      expect(new Set(newNames).size).toBe(2);
    });
  });
});
