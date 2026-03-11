import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { RecyclingBinService, RecyclingBinError } from './recycling-bin.service.js';
import type { SettingsService } from './settings.service.js';
import { createMockDbRecyclingBinEntry, createMockDbBook } from '../__tests__/factories.js';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  cp: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
}));

import { mkdir, rename, cp, rm, access } from 'node:fs/promises';

/**
 * Queue-based mock DB. Each call to select/insert/delete takes the next result from a queue.
 * Falls back to empty array if queue is exhausted.
 */
function createMockDb() {
  const selectQueue: unknown[][] = [];
  const insertQueue: unknown[][] = [];

  const makeChain = (queue: unknown[][]) => {
    const result = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    const methods = ['from', 'where', 'limit', 'orderBy', 'values', 'returning', 'set'];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.then = (resolve: (v: unknown) => void) => resolve(result);
    return chain;
  };

  return {
    insert: vi.fn().mockImplementation(() => makeChain(insertQueue)),
    select: vi.fn().mockImplementation(() => makeChain(selectQueue)),
    delete: vi.fn().mockImplementation(() => makeChain([])),
    /** Queue a result for the next select() call */
    onSelect(...results: unknown[][]) { selectQueue.push(...results); },
    /** Queue a result for the next insert().returning() call */
    onInsert(...results: unknown[][]) { insertQueue.push(...results); },
  };
}

function createMockLog() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn(), silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

function createMockSettingsService() {
  return {
    get: vi.fn().mockResolvedValue({ logLevel: 'info', housekeepingRetentionDays: 90, recycleRetentionDays: 30 }),
  } as unknown as SettingsService;
}

describe('RecyclingBinService', () => {
  let service: RecyclingBinService;
  let db: ReturnType<typeof createMockDb>;
  let settingsService: ReturnType<typeof createMockSettingsService>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fs mocks to defaults (clearAllMocks doesn't restore vi.mock defaults reliably)
    (mkdir as Mock).mockResolvedValue(undefined);
    (rename as Mock).mockResolvedValue(undefined);
    (cp as Mock).mockResolvedValue(undefined);
    (rm as Mock).mockResolvedValue(undefined);
    (access as Mock).mockResolvedValue(undefined);

    db = createMockDb();
    const log = createMockLog();
    settingsService = createMockSettingsService();
    service = new RecyclingBinService(db as never, log as never, './config', settingsService as never);
  });

  describe('moveToRecycleBin', () => {
    const mockBook = {
      ...createMockDbBook({ id: 42, path: '/audiobooks/Author/Title', status: 'imported' }),
      author: { id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson', asin: 'B001', imageUrl: null, bio: null, monitored: false, lastCheckedAt: null, createdAt: new Date(), updatedAt: new Date() },
    };

    it('moves files to ${configPath}/recycle/{bookId}/ on delete', async () => {
      db.onInsert([createMockDbRecyclingBinEntry({ id: 10, bookId: 42 })]);

      const result = await service.moveToRecycleBin(mockBook, '/audiobooks/Author/Title');

      expect(rename).toHaveBeenCalledWith('/audiobooks/Author/Title', expect.stringContaining('recycle'));
      expect(result.id).toBe(10);
    });

    it('auto-creates parent directory (not destination itself) on first use (mkdir recursive)', async () => {
      db.onInsert([createMockDbRecyclingBinEntry()]);

      await service.moveToRecycleBin(mockBook, '/audiobooks/Author/Title');

      // mkdir should create the parent of the recycle path (dirname), not the recycle path itself
      // This is critical: rename() fails on same-filesystem if destination already exists as a directory
      const mkdirPath = (mkdir as Mock).mock.calls[0][0] as string;
      expect(mkdirPath).toContain('recycle');
      // The path should be the parent of recycle/{bookId}, not recycle/{bookId} itself
      expect(mkdirPath).not.toMatch(/recycle[/\\]42$/);
    });

    it('throws when move-to-recycle fails (mkdir EACCES)', async () => {
      (mkdir as Mock).mockRejectedValue(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));

      await expect(service.moveToRecycleBin(mockBook, '/audiobooks/Author/Title'))
        .rejects.toThrow('Permission denied');
    });

    it('creates recycling record when book files do not exist on disk', async () => {
      (access as Mock).mockRejectedValue(Object.assign(new Error('Not found'), { code: 'ENOENT' }));
      db.onInsert([createMockDbRecyclingBinEntry()]);

      const result = await service.moveToRecycleBin(mockBook, '/audiobooks/Author/Title');

      expect(rename).not.toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(db.insert).toHaveBeenCalled();
    });

    it('falls back to cp+rm when rename throws EXDEV', async () => {
      (rename as Mock).mockRejectedValueOnce(Object.assign(new Error('Cross-device'), { code: 'EXDEV' }));
      db.onInsert([createMockDbRecyclingBinEntry()]);

      await service.moveToRecycleBin(mockBook, '/audiobooks/Author/Title');

      expect(cp).toHaveBeenCalled();
      expect(rm).toHaveBeenCalled();
    });

    it('throws when cp succeeds but rm fails (cross-fs partial failure)', async () => {
      (rename as Mock).mockRejectedValueOnce(Object.assign(new Error('Cross-device'), { code: 'EXDEV' }));
      (rm as Mock).mockRejectedValueOnce(new Error('rm failed'));

      await expect(service.moveToRecycleBin(mockBook, '/audiobooks/Author/Title'))
        .rejects.toThrow('rm failed');
    });
  });

  describe('restore', () => {
    const mockEntry = createMockDbRecyclingBinEntry({
      id: 5,
      originalPath: '/audiobooks/Brandon Sanderson/The Way of Kings',
      recyclePath: './config/recycle/1',
    });

    /**
     * Queue the happy-path restore flow:
     * 1. getById returns entry
     * 2. conflict check (books with same path) returns empty
     * 3. author lookup returns existing author
     * 4. insert returns new book
     */
    function queueHappyRestore() {
      db.onSelect([mockEntry], [], [{ id: 10 }]);
      db.onInsert([createMockDbBook({ id: 99 })]);
    }

    it('moves files from recycle directory back to originalPath, creating only parent dirs', async () => {
      queueHappyRestore();
      await service.restore(5);
      expect(rename).toHaveBeenCalled();
      // mkdir should create parent of originalPath, not originalPath itself
      const mkdirPath = (mkdir as Mock).mock.calls[0][0] as string;
      expect(mkdirPath).toBe('/audiobooks/Brandon Sanderson');
    });

    it('removes recycling bin DB record after successful restore', async () => {
      queueHappyRestore();
      await service.restore(5);
      expect(db.delete).toHaveBeenCalled();
    });

    it('returns error when originalPath is occupied', async () => {
      // getById returns entry, conflict check returns existing book
      db.onSelect([mockEntry], [{ id: 77, title: 'Other Book' }]);
      await expect(service.restore(5)).rejects.toThrow(RecyclingBinError);
    });

    it('returns error when recycle files are missing from disk', async () => {
      db.onSelect([mockEntry], []); // getById, conflict check
      (access as Mock).mockRejectedValueOnce(Object.assign(new Error('Not found'), { code: 'ENOENT' }));
      // No author lookup reached since file access fails first
      await expect(service.restore(5)).rejects.toThrow(RecyclingBinError);
    });

    it('uses EXDEV fallback for cross-filesystem restore', async () => {
      queueHappyRestore();
      (rename as Mock).mockRejectedValueOnce(Object.assign(new Error('Cross-device'), { code: 'EXDEV' }));
      await service.restore(5);
      expect(cp).toHaveBeenCalled();
    });

    it('restores metadata-only entry (empty originalPath) with status=wanted and path=null', async () => {
      const metadataEntry = createMockDbRecyclingBinEntry({
        id: 7,
        originalPath: '',
        recyclePath: './config/recycle/7',
        authorName: 'Test Author',
      });
      // getById returns entry, author lookup finds existing
      db.onSelect([metadataEntry], [{ id: 5 }]);
      db.onInsert([createMockDbBook({ id: 100, status: 'wanted', path: null })]);

      await service.restore(7);

      // Should not attempt file operations
      expect(rename).not.toHaveBeenCalled();
      expect(access).not.toHaveBeenCalled();
      // Should create book with wanted status and null path
      expect(db.insert).toHaveBeenCalled();
    });

    it('restores book with existing author (reuses authorId)', async () => {
      const entry = createMockDbRecyclingBinEntry({
        id: 5,
        authorName: 'Brandon Sanderson',
        authorAsin: 'B001',
        originalPath: '/audiobooks/Brandon Sanderson/The Way of Kings',
        recyclePath: './config/recycle/1',
      });
      // getById, conflict check empty, author lookup finds existing author
      db.onSelect([entry], [], [{ id: 42 }]);
      db.onInsert([createMockDbBook({ id: 99, authorId: 42 })]);

      await service.restore(5);

      // Should look up author by name
      const selectCalls = db.select.mock.results;
      expect(selectCalls.length).toBeGreaterThanOrEqual(3);
      // Book insert should include authorId
      const insertArgs = db.insert.mock.calls;
      expect(insertArgs.length).toBe(1);
    });

    it('creates new author when restoring book with unknown author', async () => {
      const entry = createMockDbRecyclingBinEntry({
        id: 5,
        authorName: 'New Author',
        authorAsin: 'B999',
        originalPath: '/audiobooks/New Author/Book',
        recyclePath: './config/recycle/1',
      });
      // getById, conflict check empty, author lookup returns nothing
      db.onSelect([entry], [], []);
      // author insert returns new author, book insert returns new book
      db.onInsert([{ id: 77, name: 'New Author', slug: 'new-author', asin: 'B999' }], [createMockDbBook({ id: 99, authorId: 77 })]);

      await service.restore(5);

      // Should insert author AND book (2 insert calls)
      expect(db.insert).toHaveBeenCalledTimes(2);
    });

    it('restores book with null authorName (no author association)', async () => {
      const entry = createMockDbRecyclingBinEntry({
        id: 5,
        authorName: null,
        authorAsin: null,
        originalPath: '/audiobooks/Unknown/Book',
        recyclePath: './config/recycle/1',
      });
      // getById, conflict check empty (no author lookup since authorName is null)
      db.onSelect([entry], []);
      db.onInsert([createMockDbBook({ id: 99 })]);

      await service.restore(5);

      // Only 1 insert (book), no author lookup/creation
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it('returns NOT_FOUND when entry does not exist', async () => {
      db.onSelect([]);  // getById returns nothing
      await expect(service.restore(999)).rejects.toThrow('not found');
    });
  });

  describe('purge', () => {
    it('removes files from recycle directory AND DB record', async () => {
      db.onSelect([createMockDbRecyclingBinEntry({ id: 3 })]);

      const result = await service.purge(3);

      expect(result).toBe(true);
      expect(rm).toHaveBeenCalled();
      expect(db.delete).toHaveBeenCalled();
    });

    it('removes DB record even when files are already missing from disk', async () => {
      db.onSelect([createMockDbRecyclingBinEntry({ id: 3 })]);
      (rm as Mock).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await service.purge(3);

      expect(result).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });

    it('returns false when entry does not exist', async () => {
      db.onSelect([]);  // getById returns nothing
      const result = await service.purge(999);
      expect(result).toBe(false);
    });
  });

  describe('purgeAll', () => {
    it('removes all recycling bin records and their files', async () => {
      // list() returns entries
      db.onSelect([
        createMockDbRecyclingBinEntry({ id: 1 }),
        createMockDbRecyclingBinEntry({ id: 2 }),
      ]);

      const result = await service.purgeAll();

      expect(result.purged).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('continues processing remaining items when one rm fails', async () => {
      db.onSelect([
        createMockDbRecyclingBinEntry({ id: 1 }),
        createMockDbRecyclingBinEntry({ id: 2 }),
        createMockDbRecyclingBinEntry({ id: 3 }),
      ]);
      (rm as Mock)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('disk error'))
        .mockResolvedValueOnce(undefined);

      const result = await service.purgeAll();

      expect(result.purged).toBe(2);
      expect(result.failed).toBe(1);
    });
  });

  describe('purgeExpired', () => {
    it('permanently deletes items older than retention period', async () => {
      db.onSelect([
        createMockDbRecyclingBinEntry({ id: 1, deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) }),
      ]);

      const result = await service.purgeExpired();

      expect(result.purged).toBe(1);
      expect(rm).toHaveBeenCalled();
      expect(db.delete).toHaveBeenCalled();
    });

    it('deletes items exactly at retention boundary (inclusive)', async () => {
      db.onSelect([
        createMockDbRecyclingBinEntry({ id: 1, deletedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }),
      ]);

      const result = await service.purgeExpired();

      expect(result.purged).toBe(1);
    });

    it('skips cleanup entirely when recycleRetentionDays = 0', async () => {
      (settingsService.get as Mock).mockResolvedValue({
        logLevel: 'info', housekeepingRetentionDays: 90, recycleRetentionDays: 0,
      });

      const result = await service.purgeExpired();

      expect(result.purged).toBe(0);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('is a no-op when recycling bin is empty', async () => {
      db.onSelect([]);

      const result = await service.purgeExpired();

      expect(result.purged).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('continues processing remaining items when one item fails', async () => {
      db.onSelect([
        createMockDbRecyclingBinEntry({ id: 1, deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) }),
        createMockDbRecyclingBinEntry({ id: 2, deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) }),
      ]);
      (rm as Mock)
        .mockRejectedValueOnce(new Error('disk error'))
        .mockResolvedValueOnce(undefined);

      const result = await service.purgeExpired();

      expect(result.purged).toBe(1);
      expect(result.failed).toBe(1);
    });

    it('reads recycleRetentionDays from settings on each run', async () => {
      db.onSelect([], []);

      await service.purgeExpired();
      await service.purgeExpired();

      expect(settingsService.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('list', () => {
    it('returns all recycling bin entries', async () => {
      db.onSelect([
        createMockDbRecyclingBinEntry({ id: 1 }),
        createMockDbRecyclingBinEntry({ id: 2 }),
      ]);

      const result = await service.list();
      expect(result).toHaveLength(2);
    });

    it('returns empty array when recycling bin is empty', async () => {
      db.onSelect([]);

      const result = await service.list();
      expect(result).toHaveLength(0);
    });
  });
});
