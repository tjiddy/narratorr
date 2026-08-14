import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, bookEvents, downloads, importListExclusions, importLists } from '@db/schema.js';
import { BookService } from './book.service.js';
import { BookDeletionService } from './book-deletion.service.js';
import { DownloadService } from './download.service.js';
import { EventHistoryService } from './event-history.service.js';
import { ImportListExclusionService } from './import-list-exclusion.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { DownloadClientService } from './download-client.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import { transitionBookStatus } from '../utils/book-status.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';

vi.mock('../utils/cover-cache.js', () => ({
  cleanCoverCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', () => ({
  config: { configPath: '/test-config' },
}));

import { cleanCoverCache } from '../utils/cover-cache.js';

/**
 * The atomicity invariant lives here rather than in the unit suite because a chain mock cannot
 * observe a rollback: it records that a statement was issued, not whether it survived. Every case
 * below runs against a real migrated database and asserts committed rows.
 */
describe('BookDeletionService — durable artifacts commit or roll back together (DB-backed, #2329)', () => {
  let dir: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let bookService: BookService;
  let exclusions: ImportListExclusionService;
  let eventHistory: EventHistoryService;
  let downloadService: DownloadService;
  let cancel: ReturnType<typeof vi.fn>;
  let service: BookDeletionService;
  let listId: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'book-deletion-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    const logger = inject<FastifyBaseLogger>(log);

    bookService = new BookService(db, logger);
    exclusions = new ImportListExclusionService(db, logger);
    eventHistory = new EventHistoryService(db, logger, inject<BlacklistService>({}), bookService);
    downloadService = new DownloadService(db, inject<DownloadClientService>({}), logger);
    cancel = vi.fn().mockResolvedValue(true);

    service = new BookDeletionService(
      db,
      bookService,
      downloadService,
      inject<DownloadOrchestrator>({ cancel }),
      inject<SettingsService>({ get: vi.fn().mockResolvedValue({ path: '/audiobooks' }) }),
      logger,
      eventHistory,
      exclusions,
    );

    const [list] = await db.insert(importLists).values({ name: 'NYT Bestsellers', type: 'nyt', settings: {} }).returning();
    listId = list!.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql can retain Windows handles; cleanup is best-effort.
    }
  });

  async function seed(opts: {
    title: string;
    author?: string | null;
    asin?: string;
    fromList?: boolean;
    status?: 'missing' | 'imported' | 'wanted' | 'failed';
  }): Promise<number> {
    const book = await bookService.create({
      title: opts.title,
      authors: opts.author === null ? [] : [{ name: opts.author ?? 'Jane Doe' }],
      ...(opts.asin && { asin: opts.asin }),
      status: opts.status ?? 'missing',
      ...(opts.fromList !== false && { importListId: listId }),
    });
    return book.id;
  }

  const exclusionRows = () => db.select().from(importListExclusions);
  const deletedEvents = () => db.select().from(bookEvents).where(eq(bookEvents.eventType, 'deleted'));
  const bookRow = async (id: number) => (await db.select().from(books).where(eq(books.id, id)))[0] ?? null;

  /** Reject the next call to `bookService.delete`'s row removal, leaving every earlier write issued. */
  function failRowDelete(message = 'books table locked') {
    return vi.spyOn(bookService, 'delete').mockRejectedValue(new Error(message));
  }

  describe('the sweep, end to end against real rows', () => {
    it('deletes every missing book, excludes the list-sourced ones, and leaves the rest alone', async () => {
      const listBook = await seed({ title: 'The Reckoning' });
      const manual = await seed({ title: 'Hand Added', author: 'John Roe', fromList: false });
      const imported = await seed({ title: 'Still Here', author: 'Ada Lovelace', status: 'imported', fromList: false });

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 2, failed: 0 });
      expect(await bookRow(listBook)).toBeNull();
      expect(await bookRow(manual)).toBeNull();
      // The enumeration's filter, not just its payload: a wrong WHERE would sweep this row too.
      expect(await bookRow(imported)).not.toBeNull();

      const rows = await exclusionRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ title: 'The Reckoning', authorName: 'Jane Doe', importListId: listId, importListName: 'NYT Bestsellers' });
    });

    it('produces a field-for-field identical exclusion row on both deletion paths', async () => {
      const bulkBook = await seed({ title: 'The Reckoning', asin: ' b0abc12345 ' });
      await service.deleteMissingBooks();
      const [fromBulk] = await exclusionRows();
      await db.delete(importListExclusions);

      const singleBook = await seed({ title: 'The Reckoning', asin: ' b0abc12345 ' });
      expect(singleBook).not.toBe(bulkBook);
      await service.deleteBook(singleBook, { deleteFiles: false });
      const [fromSingle] = await exclusionRows();

      expect(fromBulk).toBeDefined();
      expect(fromSingle).toBeDefined();
      const identity = (row: typeof fromBulk) => ({
        title: row!.title, asin: row!.asin, authorName: row!.authorName,
        authorSlug: row!.authorSlug, importListId: row!.importListId, importListName: row!.importListName,
      });
      expect(identity(fromBulk)).toEqual(identity(fromSingle));
      expect(identity(fromBulk)).toMatchObject({ asin: 'B0ABC12345', authorSlug: 'jane-doe' });
    });

    it('converges two identical books on one exclusion row and still deletes both', async () => {
      await seed({ title: 'The Reckoning' });
      await seed({ title: 'The Reckoning' });

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 2, failed: 0 });
      expect(await exclusionRows()).toHaveLength(1);
      expect(await db.select().from(books)).toHaveLength(0);
    });

    it('records an exclusion with a null author for a book with no authors', async () => {
      await seed({ title: 'The Reckoning', author: null });

      expect(await service.deleteMissingBooks()).toEqual({ deleted: 1, failed: 0 });

      const [row] = await exclusionRows();
      expect(row).toMatchObject({ title: 'The Reckoning', authorName: null, authorSlug: null });
    });

    it('records no exclusion once the originating list was deleted and nulled the provenance', async () => {
      const id = await seed({ title: 'The Reckoning' });
      await db.delete(importLists).where(eq(importLists.id, listId));

      expect(await service.deleteMissingBooks()).toEqual({ deleted: 1, failed: 0 });

      expect(await bookRow(id)).toBeNull();
      expect(await exclusionRows()).toHaveLength(0);
    });

    it('records a deleted event per swept book, surviving the row delete with a null book_id', async () => {
      await seed({ title: 'The Reckoning' });

      await service.deleteMissingBooks();

      const events = await deletedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ bookId: null, bookTitle: 'The Reckoning', authorName: 'Jane Doe', source: 'manual' });
    });

    it('writes nothing at all for an empty sweep', async () => {
      expect(await service.deleteMissingBooks()).toEqual({ deleted: 0, failed: 0 });

      expect(await exclusionRows()).toHaveLength(0);
      expect(await deletedEvents()).toHaveLength(0);
    });

    it('runs N books in N transactions without nesting or SQLITE_BUSY', async () => {
      await seed({ title: 'One' });
      await seed({ title: 'Two', author: 'Ada Lovelace' });
      await seed({ title: 'Three', author: 'Grace Hopper' });
      // After seeding: `create` opens its own transaction per book and would inflate the count.
      const opened = vi.spyOn(db, 'transaction');

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 3, failed: 0 });
      expect(opened).toHaveBeenCalledTimes(3);
    });
  });

  /**
   * Every case below seeds a list-sourced book whose identity has NO pre-existing exclusion, which
   * is what makes the bare "no exclusion row" assertions mean what AC5 guarantees: no row *this
   * call* would have inserted. The convergence case at the end is where a surviving row is correct.
   */
  describe('rollback — a failed deleteBook strands nothing it created', () => {
    it('rolls back an exclusion-write rejection: no exclusion, no event, no cancel, book present', async () => {
      const id = await seed({ title: 'The Reckoning' });
      await db.insert(downloads).values({ publicId: 'dl_rollback_excl_00000', bookId: id, title: 'The Reckoning', clientStatus: 'downloading' });
      vi.spyOn(exclusions, 'recordExclusion').mockRejectedValue(new Error('exclusions table locked'));

      await expect(service.deleteBook(id, { deleteFiles: false })).rejects.toThrow('exclusions table locked');

      expect(await bookRow(id)).not.toBeNull();
      expect(await exclusionRows()).toHaveLength(0);
      expect(await deletedEvents()).toHaveLength(0);
      expect(cancel).not.toHaveBeenCalled();
    });

    it('rolls back an active-download lookup rejection with the exclusion already issued', async () => {
      const id = await seed({ title: 'The Reckoning' });
      vi.spyOn(downloadService, 'getActiveByBookId').mockRejectedValue(new Error('downloads table locked'));

      await expect(service.deleteBook(id, { deleteFiles: false })).rejects.toThrow('downloads table locked');

      expect(await bookRow(id)).not.toBeNull();
      expect(await exclusionRows()).toHaveLength(0);
      expect(await deletedEvents()).toHaveLength(0);
    });

    it('rolls back a row-delete rejection with both the exclusion and the event already issued', async () => {
      const id = await seed({ title: 'The Reckoning' });
      failRowDelete();

      await expect(service.deleteBook(id, { deleteFiles: false })).rejects.toThrow('books table locked');

      expect(await bookRow(id)).not.toBeNull();
      expect(await exclusionRows()).toHaveLength(0);
      expect(await deletedEvents()).toHaveLength(0);
    });

    it('rolls back a not_found race after both artifacts were issued', async () => {
      // The row survives the re-check and `deleteBook`'s hydration, then vanishes before the
      // transaction's delete — the only stimulus that reaches rollback after issuance.
      const id = await seed({ title: 'The Reckoning' });
      vi.spyOn(bookService, 'delete').mockResolvedValue(false);

      const result = await service.deleteBook(id, { deleteFiles: false });

      expect(result).toEqual({ outcome: 'not_found' });
      expect(await exclusionRows()).toHaveLength(0);
      expect(await deletedEvents()).toHaveLength(0);
    });

    it('emits none of the success records on rollback, and all of them on commit', async () => {
      const failing = await seed({ title: 'The Reckoning' });
      const restore = failRowDelete();

      await expect(service.deleteBook(failing, { deleteFiles: false })).rejects.toThrow('books table locked');

      const messages = () => (log.info as Mock).mock.calls.map((c: unknown[]) => c[1]);
      expect(messages()).not.toContain('Import list exclusion recorded');
      expect(messages()).not.toContain('Recorded import list exclusion for deleted book');
      expect(messages()).not.toContain('Event recorded');
      expect(messages()).not.toContain('Book deleted');

      // Positive control: the same records all appear once the identical call commits.
      restore.mockRestore();
      await service.deleteBook(failing, { deleteFiles: false });

      expect(messages()).toEqual(expect.arrayContaining([
        'Import list exclusion recorded',
        'Recorded import list exclusion for deleted book',
        'Event recorded',
        'Book deleted',
      ]));
    });

    it('commits the deletion anyway when only the event insert rejects', async () => {
      const id = await seed({ title: 'The Reckoning' });
      vi.spyOn(eventHistory, 'create').mockRejectedValue(new Error('events table locked'));

      const result = await service.deleteBook(id, { deleteFiles: false });

      expect(result).toMatchObject({ outcome: 'deleted' });
      expect(await bookRow(id)).toBeNull();
      expect(await exclusionRows()).toHaveLength(1);
      expect(await deletedEvents()).toHaveLength(0);
      expect(log.warn).toHaveBeenCalledWith(expect.anything(), 'Failed to record deleted event');
    });

    it('keeps a converged sibling exclusion when the second book of the pair fails', async () => {
      // A's successful deletion earned the tombstone; B's rollback inserted nothing, so it must
      // remove nothing. An implementation that deletes any matching row on rollback reds here.
      const a = await seed({ title: 'The Reckoning' });
      const b = await seed({ title: 'The Reckoning' });
      const real = bookService.delete.bind(bookService);
      vi.spyOn(bookService, 'delete').mockImplementation(async (id, tx) => {
        if (id === b) throw new Error('books table locked');
        return real(id, tx);
      });

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 1, failed: 1 });
      expect(await bookRow(a)).toBeNull();
      expect(await bookRow(b)).not.toBeNull();
      expect(await exclusionRows()).toHaveLength(1);
    });

    it('isolates the failure to one book of a batch and still answers with both counters', async () => {
      const first = await seed({ title: 'First Book' });
      const failing = await seed({ title: 'Second Book', author: 'Ada Lovelace' });
      const last = await seed({ title: 'Third Book', author: 'Grace Hopper' });
      const real = bookService.delete.bind(bookService);
      vi.spyOn(bookService, 'delete').mockImplementation(async (id, tx) => {
        if (id === failing) throw new Error('books table locked');
        return real(id, tx);
      });

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 2, failed: 1 });
      expect(await bookRow(first)).toBeNull();
      expect(await bookRow(last)).toBeNull();
      expect(await bookRow(failing)).not.toBeNull();
      expect(await exclusionRows()).toHaveLength(2);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: failing }),
        'Failed to delete missing book',
      );
    });
  });

  describe('post-commit effects', () => {
    it('cancels the download rows read inside the transaction, after the book is gone', async () => {
      const id = await seed({ title: 'The Reckoning' });
      const [dl] = await db.insert(downloads).values({
        publicId: 'dl_cancel_after_commit', bookId: id, title: 'The Reckoning', clientStatus: 'downloading',
      }).returning();

      await service.deleteMissingBooks();

      // `downloads.book_id` is nulled by the FK, so a post-commit lookup could not have found it.
      expect(cancel).toHaveBeenCalledWith(dl!.id);
      const [survivor] = await db.select().from(downloads).where(eq(downloads.id, dl!.id));
      expect(survivor!.bookId).toBeNull();
    });

    it('swallows a cancel rejection without resurrecting the book or counting a failure', async () => {
      const id = await seed({ title: 'The Reckoning' });
      await db.insert(downloads).values({ publicId: 'dl_cancel_rejects_000', bookId: id, title: 'The Reckoning', clientStatus: 'downloading' });
      cancel.mockRejectedValue(new Error('client unreachable'));

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 1, failed: 0 });
      expect(await bookRow(id)).toBeNull();
      expect(log.warn).toHaveBeenCalledWith(expect.anything(), 'Failed to cancel download during book deletion');
    });

    it('cancels nothing for a book with no active download', async () => {
      await seed({ title: 'The Reckoning' });

      await service.deleteMissingBooks();

      expect(cancel).not.toHaveBeenCalled();
    });

    it('cleans the cover cache per swept book and swallows its rejection', async () => {
      vi.mocked(cleanCoverCache).mockRejectedValueOnce(new Error('EACCES'));
      const id = await seed({ title: 'The Reckoning' });

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 1, failed: 0 });
      expect(cleanCoverCache).toHaveBeenCalledWith(id, '/test-config', expect.anything());
    });
  });

  describe('the delete-time membership re-check', () => {
    it('skips a book a concurrent scan restored between enumeration and its turn', async () => {
      const first = await seed({ title: 'First Book' });
      const restored = await seed({ title: 'Second Book', author: 'Ada Lovelace' });
      const realFind = bookService.findIdsByStatus.bind(bookService);
      vi.spyOn(bookService, 'findIdsByStatus').mockImplementation(async (status) => {
        const ids = await realFind(status);
        // Drive the restore through the same guarded CAS a library scan uses.
        await transitionBookStatus(db, restored, { status: 'imported', expected: { status: 'missing' } });
        return ids;
      });

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 1, failed: 0 });
      expect(await bookRow(first)).toBeNull();
      expect(await bookRow(restored)).not.toBeNull();
      expect(await exclusionRows()).toHaveLength(1);
      expect(await deletedEvents()).toHaveLength(1);
    });

    it('skips a row deleted outright before its turn, counting it in neither bucket', async () => {
      const first = await seed({ title: 'First Book' });
      const vanishing = await seed({ title: 'Second Book', author: 'Ada Lovelace' });
      const realFind = bookService.findIdsByStatus.bind(bookService);
      vi.spyOn(bookService, 'findIdsByStatus').mockImplementation(async (status) => {
        const ids = await realFind(status);
        await db.delete(books).where(eq(books.id, vanishing));
        return ids;
      });

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 1, failed: 0 });
      expect(await bookRow(first)).toBeNull();
      expect(await exclusionRows()).toHaveLength(1);
    });
  });
});
