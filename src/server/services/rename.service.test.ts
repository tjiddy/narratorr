import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockLogger, createMockDb, mockDbChain, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { RenameService, RenameError } from './rename.service.js';
import { renameFilesWithTemplate } from '../utils/paths.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { rename, readdir, mkdir, stat, rm, cp } from 'node:fs/promises';

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

  const service = new RenameService(
    inject<Db>(db),
    inject<BookService>(bookService),
    inject<SettingsService>(settingsService),
    inject<FastifyBaseLogger>(log),
  );

  return { service, db, bookService, settingsService, log };
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

      // {author}/{title} with "Brandon Sanderson" and "The Way of Kings"
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
      // Path already matches what buildTargetPath would produce
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
      // checkConflict now uses targeted DB query
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
      bookService.getAll.mockResolvedValue({ data: [book], total: 1 });
      bookService.update.mockResolvedValue(book);

      // First rename call (folder move) throws EXDEV
      (rename as Mock).mockRejectedValueOnce(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));

      await service.renameBook(1);

      expect(cp).toHaveBeenCalled();
      expect(rm).toHaveBeenCalled();
    });
  });

  // N+1 elimination tests (issue #356)
  describe('checkConflict optimization', () => {
    it('uses targeted DB query instead of bookService.getAll()', async () => {
      const { service, db, bookService } = createService();
      const book = { ...mockBook, id: 1, path: '/library/wrong/path' };
      bookService.getById.mockResolvedValue(book);
      bookService.update.mockResolvedValue({ ...book, path: '/library/Brandon Sanderson/The Way of Kings' });
      // stat succeeds = target exists on disk
      (stat as Mock).mockResolvedValue({ isFile: () => false, isDirectory: () => true });
      // DB query returns no conflict
      db.select.mockReturnValue(mockDbChain([]));

      await service.renameBook(1);

      // getAll should NOT be called
      expect(bookService.getAll).not.toHaveBeenCalled();
      // db.select should be called for the conflict check
      expect(db.select).toHaveBeenCalled();
    });

    it('does not query DB when target path does not exist on disk', async () => {
      const { service, db, bookService } = createService();
      const book = { ...mockBook, id: 1, path: '/library/wrong/path' };
      bookService.getById.mockResolvedValue(book);
      bookService.update.mockResolvedValue(book);
      // stat rejects = target doesn't exist → no conflict check needed
      (stat as Mock).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      await service.renameBook(1);

      expect(bookService.getAll).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
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

      // Rollback: rename should be called to undo the first successful rename
      expect(rename).toHaveBeenCalledTimes(3); // 2 attempts + 1 rollback
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

      // 3 forward attempts + 2 rollback attempts (file2 reverse + file1 reverse)
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

      // 3 forward attempts + 2 rollback attempts = 5 total
      expect(rename).toHaveBeenCalledTimes(5);
      // log.error called for EACH failed rollback file
      const errorCalls = (log.error as ReturnType<typeof vi.fn>).mock.calls;
      const rollbackErrors = errorCalls.filter(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('Rollback failed'),
      );
      expect(rollbackErrors).toHaveLength(2);
      // Original error is re-thrown (not a rollback error)
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

      // 2 forward + 1 rollback = 3 total
      expect(rename).toHaveBeenCalledTimes(3);
      // No rollback errors logged — the single rollback succeeded
      const errorCalls = (log.error as ReturnType<typeof vi.fn>).mock.calls;
      const rollbackErrors = errorCalls.filter(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('Rollback failed'),
      );
      expect(rollbackErrors).toHaveLength(0);
    });

    it('deduplicates colliding filenames', async () => {
      const { log } = createService();
      // Two files, template produces same name for both
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

      // Should have renamed both files, second gets (2) suffix
      const renameCalls = (rename as Mock).mock.calls;
      const newNames = renameCalls.map((call: unknown[]) => call[1] as string);
      expect(newNames).toHaveLength(2);
      // Check they're different
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
      // The renamed file should use period separator and uppercase
      const newPath = (rename as Mock).mock.calls[0]![1] as string;
      expect(newPath).toContain('BRANDON.SANDERSON');
    });

    describe('single-file track token omission', () => {
      it('omits trackNumber, trackTotal, and partName from token map when audioFiles.length === 1', async () => {
        const { log } = createService();
        (readdir as Mock).mockResolvedValue([
          { name: 'audiobook.m4b', isFile: () => true },
        ]);

        // Template references trackNumber — should produce empty for single file
        await renameFilesWithTemplate(
          '/library/test',
          '{title} {trackNumber}',
          mockBook,
          'Brandon Sanderson',
          inject<FastifyBaseLogger>(log),
        );

        // With track tokens omitted, {trackNumber} resolves to empty →
        // result is "The Way of Kings" (trailing space trimmed by sanitizePath)
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
        // Each file gets a trackNumber
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
        // partName absent → conditional prefix " - " omitted → just "Title"
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
        // trackTotal absent → conditional " of " omitted → just "Title"
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
        // trackNumber absent → suffix ". " omitted → just "Title"
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
      // Use a different folder format so target path differs from current path
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

      // Target doesn't exist on disk (no conflict)
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

  // ── #229 Observability — skip logging ───────────────────────────────────
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
});
