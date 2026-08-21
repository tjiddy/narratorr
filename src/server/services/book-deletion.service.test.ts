import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbBook } from '../__tests__/factories.js';
import { BookDeletionService } from './book-deletion.service.js';
import { PathOutsideLibraryError } from '../utils/paths.js';
import type { BookService } from './book.service.js';
import type { DownloadService } from './download.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { ImportListExclusionService } from './import-list-exclusion.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';

vi.mock('../utils/cover-cache.js', () => ({
  cleanCoverCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', () => ({
  config: { configPath: '/test-config' },
}));

import { cleanCoverCache } from '../utils/cover-cache.js';

const deletableBook = {
  ...createMockDbBook({ id: 1, title: 'The Way of Kings', path: '/audiobooks/Sanderson/Way of Kings' }),
  authors: [{ name: 'Brandon Sanderson' }],
  narrators: [{ name: 'Michael Kramer' }],
};

/**
 * A mock db that marks when its transaction promise RESOLVES, which is the only observation point
 * that separates a post-commit effect from one issued at the end of the transaction callback.
 * Statement issuance cannot: both orders look identical to an `invocationCallOrder` comparison.
 */
function tracingDb() {
  const order: string[] = [];
  const db = createMockDb();
  db.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const result = await cb(db);
    order.push('tx-committed');
    return result;
  });
  return { db, order };
}

function createService(opts?: {
  db?: ReturnType<typeof createMockDb>;
  bookService?: Partial<BookService>;
  downloadService?: Partial<DownloadService>;
  downloadOrchestrator?: Partial<DownloadOrchestrator>;
  settingsService?: Partial<SettingsService>;
  /** Pass `null` to construct the service without an eventHistory dependency. */
  eventHistory?: Partial<EventHistoryService> | null;
  /** Pass `null` to construct the service without the exclusion dependency. */
  exclusions?: Partial<ImportListExclusionService> | null;
}) {
  const log = createMockLogger();
  // `createMockDb` hands the same object back as the transaction handle, so the tx a collaborator
  // receives is identifiable — that is what the "ran on the caller's handle" assertions key on.
  const db = opts?.db ?? createMockDb();
  const bookService = inject<BookService>({
    getById: vi.fn().mockResolvedValue(deletableBook),
    findIdsByStatus: vi.fn().mockResolvedValue([]),
    getStatusById: vi.fn().mockResolvedValue('missing'),
    delete: vi.fn().mockResolvedValue(true),
    deleteBookFiles: vi.fn().mockResolvedValue({ deletedManaged: [], preservedForeign: [], failedManaged: [] }),
    ...opts?.bookService,
  });
  const downloadService = inject<DownloadService>({
    getActiveByBookId: vi.fn().mockResolvedValue([]),
    ...opts?.downloadService,
  });
  const downloadOrchestrator = inject<DownloadOrchestrator>({
    cancel: vi.fn().mockResolvedValue(true),
    ...opts?.downloadOrchestrator,
  });
  const settingsService = inject<SettingsService>({
    get: vi.fn().mockResolvedValue({ path: '/audiobooks' }),
    ...opts?.settingsService,
  });
  const eventHistory = opts?.eventHistory === null
    ? undefined
    : inject<EventHistoryService>({
      create: vi.fn().mockResolvedValue({ id: 7, bookId: 1, eventType: 'deleted', bookTitle: 'The Way of Kings' }),
      logRecorded: vi.fn(),
      ...opts?.eventHistory,
    });

  const exclusions = opts?.exclusions === null
    ? undefined
    : inject<ImportListExclusionService>({
      recordExclusion: vi.fn().mockResolvedValue({ row: { id: 99 }, inserted: true }),
      removeAdded: vi.fn().mockResolvedValue(0),
      logRecorded: vi.fn(),
      ...opts?.exclusions,
    });

  const service = new BookDeletionService(
    inject<Db>(db),
    bookService,
    downloadService,
    downloadOrchestrator,
    settingsService,
    inject<FastifyBaseLogger>(log),
    eventHistory,
    exclusions,
  );

  return { service, log, db, bookService, downloadService, downloadOrchestrator, settingsService, eventHistory, exclusions };
}

describe('BookDeletionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('deleteBook — happy path', () => {
    it('returns deleted with the book title', async () => {
      const { service } = createService();

      const result = await service.deleteBook(1, { deleteFiles: false });

      expect(result).toEqual({ outcome: 'deleted', bookTitle: 'The Way of Kings' });
      expect(cleanCoverCache).toHaveBeenCalledWith(1, '/test-config', expect.anything());
    });

    it('records a deleted event whose snapshot joins authors and narrators (#71)', async () => {
      const multiAuthorBook = {
        ...deletableBook,
        authors: [{ name: 'Brandon Sanderson' }, { name: 'Robert Jordan' }],
        narrators: [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }],
      };
      const { service, eventHistory } = createService({
        bookService: { getById: vi.fn().mockResolvedValue(multiAuthorBook) },
      });

      await service.deleteBook(1, { deleteFiles: false });

      expect(eventHistory!.create).toHaveBeenCalledWith(
        expect.objectContaining({
          authorName: 'Brandon Sanderson, Robert Jordan',
          narratorName: 'Michael Kramer, Kate Reading',
          eventType: 'deleted',
          source: 'manual',
        }),
        expect.anything(),
      );
    });
  });

  describe('ordering invariants', () => {
    it('records the deleted event BEFORE the DB delete', async () => {
      const { service, bookService, eventHistory } = createService();

      await service.deleteBook(1, { deleteFiles: false });

      const createOrder = (eventHistory!.create as Mock).mock.invocationCallOrder[0]!;
      const deleteOrder = (bookService.delete as Mock).mock.invocationCallOrder[0]!;
      expect(createOrder).toBeLessThan(deleteOrder);
    });

    it('deletes files from disk BEFORE the DB delete', async () => {
      const { service, bookService } = createService();

      await service.deleteBook(1, { deleteFiles: true });

      const filesOrder = (bookService.deleteBookFiles as Mock).mock.invocationCallOrder[0]!;
      const deleteOrder = (bookService.delete as Mock).mock.invocationCallOrder[0]!;
      expect(filesOrder).toBeLessThan(deleteOrder);
      expect(bookService.deleteBookFiles).toHaveBeenCalledWith('/audiobooks/Sanderson/Way of Kings', '/audiobooks');
    });

    it('cancels active downloads after the transaction RESOLVES, from the rows read inside it', async () => {
      // `downloads.book_id` is ON DELETE SET NULL, so a post-commit lookup would find nothing and
      // the torrent would never be cancelled — the rows must be captured inside the transaction.
      // The observation point is the transaction's resolution, not the row delete's issuance:
      // cancelling at the END of the transaction callback still precedes the commit while
      // satisfying any issuance-ordered assertion.
      const { db, order } = tracingDb();
      const cancel = vi.fn(() => { order.push('cancel'); return Promise.resolve(true); });
      const getActiveByBookId = vi.fn().mockResolvedValue([{ id: 10 }]);
      const { service, bookService } = createService({
        db,
        downloadService: { getActiveByBookId },
        downloadOrchestrator: { cancel },
      });

      await service.deleteBook(1, { deleteFiles: false });

      expect(order).toEqual(['tx-committed', 'cancel']);
      const lookupOrder = getActiveByBookId.mock.invocationCallOrder[0]!;
      expect(lookupOrder).toBeLessThan((bookService.delete as Mock).mock.invocationCallOrder[0]!);
      expect(cancel).toHaveBeenCalledWith(10);
      expect(getActiveByBookId).toHaveBeenCalledWith(1, db);
    });

    it('runs the exclusion, the lookup, the event and the row delete on one transaction handle', async () => {
      const { service, db, bookService, eventHistory, downloadService } = createService({
        bookService: { getById: vi.fn().mockResolvedValue({ ...deletableBook, importListId: 5, importListName: 'NYT' }) },
      });

      await service.deleteBook(1, { deleteFiles: false });

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(bookService.delete).toHaveBeenCalledWith(1, db);
      expect(downloadService.getActiveByBookId).toHaveBeenCalledWith(1, db);
      expect(eventHistory!.create).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'deleted' }), db);
    });
  });

  describe('post-commit effects, observed against the transaction resolving', () => {
    it('emits the exclusion and event records only after the transaction resolves', async () => {
      const { db, order } = tracingDb();
      const exclusionLog = vi.fn(() => { order.push('exclusion-log'); });
      const eventLog = vi.fn(() => { order.push('event-log'); });
      const { service } = createService({
        db,
        bookService: { getById: vi.fn().mockResolvedValue({ ...deletableBook, importListId: 5, importListName: 'NYT' }) },
        exclusions: { logRecorded: exclusionLog },
        eventHistory: { logRecorded: eventLog },
      });

      await service.deleteBook(1, { deleteFiles: false });

      expect(order).toEqual(['tx-committed', 'exclusion-log', 'event-log']);
      expect(exclusionLog).toHaveBeenCalledWith({ row: { id: 99 }, inserted: true });
    });

    it('starts cover-cache cleanup only after the transaction resolves', async () => {
      // Filesystem work inside a libSQL transaction blocks every other write in the process, and
      // an issuance-ordered assertion cannot tell the two placements apart.
      const { db, order } = tracingDb();
      (cleanCoverCache as Mock).mockImplementationOnce(() => { order.push('cover-cache'); return Promise.resolve(); });
      const { service } = createService({ db });

      await service.deleteBook(1, { deleteFiles: false });

      expect(order).toEqual(['tx-committed', 'cover-cache']);
      expect(cleanCoverCache).toHaveBeenCalledWith(1, '/test-config', expect.anything());
    });

    it('emits none of the success records when the transaction rolls back', async () => {
      const exclusionLog = vi.fn();
      const eventLog = vi.fn();
      const { service, log } = createService({
        bookService: {
          getById: vi.fn().mockResolvedValue({ ...deletableBook, importListId: 5, importListName: 'NYT' }),
          delete: vi.fn().mockRejectedValue(new Error('books table locked')),
        },
        exclusions: { logRecorded: exclusionLog },
        eventHistory: { logRecorded: eventLog },
      });

      await expect(service.deleteBook(1, { deleteFiles: false })).rejects.toThrow('books table locked');

      expect(exclusionLog).not.toHaveBeenCalled();
      expect(eventLog).not.toHaveBeenCalled();
      expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Recorded import list exclusion for deleted book');
      expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Book deleted');
    });
  });

  describe('best-effort failures do not block deletion', () => {
    it('swallows a deleted-event write rejection (fire-and-forget) and still deletes', async () => {
      const create = vi.fn().mockRejectedValue(new Error('event DB write failed'));
      const { service, bookService } = createService({ eventHistory: { create } });

      const result = await service.deleteBook(1, { deleteFiles: false });

      const createOrder = create.mock.invocationCallOrder[0]!;
      const deleteOrder = (bookService.delete as Mock).mock.invocationCallOrder[0]!;
      expect(createOrder).toBeLessThan(deleteOrder);
      expect(result).toEqual({ outcome: 'deleted', bookTitle: 'The Way of Kings' });
    });

    it('swallows a per-download cancel rejection and cancels the rest', async () => {
      const cancel = vi.fn()
        .mockRejectedValueOnce(new Error('cancel failed'))
        .mockResolvedValueOnce(true);
      const { service, bookService } = createService({
        downloadService: { getActiveByBookId: vi.fn().mockResolvedValue([{ id: 10 }, { id: 11 }]) },
        downloadOrchestrator: { cancel },
      });

      const result = await service.deleteBook(1, { deleteFiles: false });

      expect(cancel).toHaveBeenCalledWith(10);
      expect(cancel).toHaveBeenCalledWith(11);
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(bookService.delete).toHaveBeenCalledWith(1, expect.anything());
      expect(result).toEqual({ outcome: 'deleted', bookTitle: 'The Way of Kings' });
    });

    it('swallows a cover-cache cleanup rejection and still returns deleted', async () => {
      (cleanCoverCache as Mock).mockRejectedValueOnce(new Error('EACCES'));
      const { service } = createService();

      const result = await service.deleteBook(1, { deleteFiles: false });

      expect(result).toEqual({ outcome: 'deleted', bookTitle: 'The Way of Kings' });
      expect(cleanCoverCache).toHaveBeenCalledWith(1, '/test-config', expect.anything());
    });
  });

  describe('file deletion failures abort before any DB mutation', () => {
    it('returns path_outside_library and performs no downloads/event/DB work', async () => {
      const { service, bookService, downloadService, eventHistory } = createService({
        bookService: {
          getById: vi.fn().mockResolvedValue(deletableBook),
          deleteBookFiles: vi.fn().mockRejectedValue(new PathOutsideLibraryError('/audiobooks/Sanderson/Way of Kings', '/audiobooks')),
          delete: vi.fn().mockResolvedValue(true),
        },
      });

      const result = await service.deleteBook(1, { deleteFiles: true });

      expect(result).toEqual({
        outcome: 'path_outside_library',
        error: expect.stringMatching(/not inside library root/),
      });
      expect(downloadService.getActiveByBookId).not.toHaveBeenCalled();
      expect(eventHistory!.create).not.toHaveBeenCalled();
      expect(bookService.delete).not.toHaveBeenCalled();
    });

    it('returns file_deletion_failed and performs no downloads/event/DB work', async () => {
      const { service, bookService, downloadService, eventHistory } = createService({
        bookService: {
          getById: vi.fn().mockResolvedValue(deletableBook),
          deleteBookFiles: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')),
          delete: vi.fn().mockResolvedValue(true),
        },
      });

      const result = await service.deleteBook(1, { deleteFiles: true });

      expect(result).toEqual({ outcome: 'file_deletion_failed', error: 'Failed to delete book files from disk' });
      expect(downloadService.getActiveByBookId).not.toHaveBeenCalled();
      expect(eventHistory!.create).not.toHaveBeenCalled();
      expect(bookService.delete).not.toHaveBeenCalled();
    });

    it('returns file_deletion_failed (and skips DB delete) when a managed file fails to delete (#1589)', async () => {
      const { service, bookService, eventHistory } = createService({
        bookService: {
          getById: vi.fn().mockResolvedValue(deletableBook),
          deleteBookFiles: vi.fn().mockResolvedValue({
            deletedManaged: ['/audiobooks/Sanderson/Way of Kings/ch1.mp3'],
            preservedForeign: [],
            failedManaged: ['/audiobooks/Sanderson/Way of Kings/ch2.mp3'],
          }),
          delete: vi.fn().mockResolvedValue(true),
        },
      });

      const result = await service.deleteBook(1, { deleteFiles: true });

      expect(result).toEqual({ outcome: 'file_deletion_failed', error: 'Failed to delete book files from disk' });
      expect(eventHistory!.create).not.toHaveBeenCalled();
      expect(bookService.delete).not.toHaveBeenCalled();
    });
  });

  describe('preserved-foreign disclosure (#1589)', () => {
    it('returns a deleted result carrying the kept-files summary when foreign files were preserved', async () => {
      const { service, bookService } = createService({
        bookService: {
          getById: vi.fn().mockResolvedValue(deletableBook),
          deleteBookFiles: vi.fn().mockResolvedValue({
            deletedManaged: ['/audiobooks/Sanderson/Way of Kings/ch1.mp3', '/audiobooks/Sanderson/Way of Kings/cover.jpg'],
            preservedForeign: ['/audiobooks/Sanderson/Way of Kings/book.epub', '/audiobooks/Sanderson/Way of Kings/notes.pdf'],
            failedManaged: [],
          }),
          delete: vi.fn().mockResolvedValue(true),
        },
      });

      const result = await service.deleteBook(1, { deleteFiles: true });

      expect(result).toEqual({
        outcome: 'deleted',
        bookTitle: 'The Way of Kings',
        fileSummary: { deletedManaged: 2, preservedForeign: ['book.epub', 'notes.pdf'] },
      });
      expect(bookService.delete).toHaveBeenCalledWith(1, expect.anything());
    });

    it('omits fileSummary when deleteFiles is false (no on-disk delete)', async () => {
      const { service } = createService();

      const result = await service.deleteBook(1, { deleteFiles: false });

      expect(result).toEqual({ outcome: 'deleted', bookTitle: 'The Way of Kings' });
    });
  });

  describe('claim-key enrolment (#2301)', () => {
    it('sweeps the path the row names NOW, not the one hydrated before the awaits', async () => {
      const { service, bookService } = createService({
        bookService: {
          getById: vi.fn()
            .mockResolvedValueOnce({ ...deletableBook, path: '/audiobooks/Sanderson/Stale' })
            .mockResolvedValue({ ...deletableBook, path: '/audiobooks/Sanderson/Fresh' }),
        },
      });

      await service.deleteBook(1, { deleteFiles: true });

      expect(bookService.deleteBookFiles).toHaveBeenCalledWith('/audiobooks/Sanderson/Fresh', '/audiobooks');
    });

    it('refuses the disk sweep — and still deletes the book — when another row owns the folder', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([{ id: 8, title: 'Other Claim', path: '/audiobooks/Sanderson/Way of Kings' }]));
      const { service, bookService, log } = createService({ db });

      const result = await service.deleteBook(1, { deleteFiles: true });

      expect(bookService.deleteBookFiles).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: 'deleted', bookTitle: 'The Way of Kings', fileSummary: { deletedManaged: 0, preservedForeign: [] } });
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, ownerBookId: 8 }),
        expect.stringMatching(/another book owns this folder/i),
      );
    });

    it('keeps the refusal scoped to the disk sweep — downloads, event and cover cache still run', async () => {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain([{ id: 8, title: 'Other Claim', path: '/audiobooks/Sanderson/Way of Kings' }]));
      const active = [{ id: 55 }];
      const { service, downloadOrchestrator, eventHistory } = createService({
        db,
        downloadService: { getActiveByBookId: vi.fn().mockResolvedValue(active) },
      });

      await service.deleteBook(1, { deleteFiles: true });

      expect(downloadOrchestrator.cancel).toHaveBeenCalledWith(55);
      expect(eventHistory?.create).toHaveBeenCalled();
      expect(cleanCoverCache).toHaveBeenCalledWith(1, '/test-config', expect.anything());
    });

    it('skips the disk step but still deletes the row when the fresh path is null', async () => {
      const { service, bookService } = createService({
        bookService: {
          getById: vi.fn()
            .mockResolvedValueOnce(deletableBook)
            .mockResolvedValue({ ...deletableBook, path: null }),
        },
      });

      const result = await service.deleteBook(1, { deleteFiles: true });

      expect(bookService.deleteBookFiles).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: 'deleted', bookTitle: 'The Way of Kings' });
      expect(bookService.delete).toHaveBeenCalled();
    });

    it('takes file_deletion_failed WITHOUT deleting the row when the path churns past the bound', async () => {
      let call = 0;
      const { service, bookService } = createService({
        bookService: { getById: vi.fn().mockImplementation(async () => ({ ...deletableBook, path: `/audiobooks/churn/${call++}` })) },
      });

      const result = await service.deleteBook(1, { deleteFiles: true });

      expect(result).toEqual({ outcome: 'file_deletion_failed', error: 'Failed to delete book files from disk' });
      expect(bookService.delete).not.toHaveBeenCalled();
      expect(bookService.deleteBookFiles).not.toHaveBeenCalled();
    }, 5000);

    it('runs no ownership query at all when deleteFiles is false', async () => {
      const { service, db } = createService();

      await service.deleteBook(1, { deleteFiles: false });

      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('not_found semantics', () => {
    it('returns not_found before any file/download work when deleteFiles=true and book is missing', async () => {
      const { service, bookService, downloadService } = createService({
        bookService: { getById: vi.fn().mockResolvedValue(null), deleteBookFiles: vi.fn(), delete: vi.fn() },
      });

      const result = await service.deleteBook(999, { deleteFiles: true });

      expect(result).toEqual({ outcome: 'not_found' });
      expect(bookService.deleteBookFiles).not.toHaveBeenCalled();
      expect(downloadService.getActiveByBookId).not.toHaveBeenCalled();
      expect(bookService.delete).not.toHaveBeenCalled();
    });

    it('returns not_found when the DB delete reports no row removed (deleteFiles=false)', async () => {
      const { service } = createService({
        bookService: {
          getById: vi.fn().mockResolvedValue(null),
          delete: vi.fn().mockResolvedValue(false),
          deleteBookFiles: vi.fn(),
        },
      });

      const result = await service.deleteBook(999, { deleteFiles: false });

      expect(result).toEqual({ outcome: 'not_found' });
      expect(cleanCoverCache).not.toHaveBeenCalled();
    });
  });

  describe('null / absent path', () => {
    it('skips file deletion when deleteFiles=true but the book has a null path', async () => {
      const bookNoPath = { ...deletableBook, path: null };
      const { service, bookService } = createService({
        bookService: {
          getById: vi.fn().mockResolvedValue(bookNoPath),
          delete: vi.fn().mockResolvedValue(true),
          deleteBookFiles: vi.fn(),
        },
      });

      const result = await service.deleteBook(1, { deleteFiles: true });

      expect(bookService.deleteBookFiles).not.toHaveBeenCalled();
      expect(bookService.delete).toHaveBeenCalledWith(1, expect.anything());
      expect(result).toEqual({ outcome: 'deleted', bookTitle: 'The Way of Kings' });
    });

    it('skips file deletion entirely when deleteFiles=false', async () => {
      const { service, bookService, settingsService } = createService();

      await service.deleteBook(1, { deleteFiles: false });

      expect(bookService.deleteBookFiles).not.toHaveBeenCalled();
      expect(settingsService.get).not.toHaveBeenCalled();
    });
  });

  it('works without an eventHistory dependency', async () => {
    const { service } = createService({ eventHistory: null });

    const result = await service.deleteBook(1, { deleteFiles: false });

    expect(result).toEqual({ outcome: 'deleted', bookTitle: 'The Way of Kings' });
  });
});

/**
 * The exclusion write is the durable artifact the next sync's gate reads, so it is awaited and sits
 * immediately after the disk step — before download cancellation, before the Activity event and
 * before the row delete. A rejection must leave none of those three behind.
 */
describe('BookDeletionService — the import-list exclusion (#2305)', () => {
  const importedBook = {
    ...deletableBook,
    importListId: 5,
    importListName: 'NYT Bestsellers',
    asin: 'B0ABC12345',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records an exclusion for an import-list book with its identity and provenance', async () => {
    const { service, exclusions, db } = createService({
      bookService: { getById: vi.fn().mockResolvedValue(importedBook) },
    });

    await service.deleteBook(1, { deleteFiles: false });

    expect(exclusions!.recordExclusion).toHaveBeenCalledWith(
      { title: 'The Way of Kings', asin: 'B0ABC12345', authorName: 'Brandon Sanderson' },
      { importListId: 5, importListName: 'NYT Bestsellers' },
      'deleted',
      db,
    );
  });

  it('passes only the position-0 primary author', async () => {
    const { service, exclusions } = createService({
      bookService: {
        getById: vi.fn().mockResolvedValue({
          ...importedBook,
          authors: [{ name: 'Brandon Sanderson' }, { name: 'Robert Jordan' }],
        }),
      },
    });

    await service.deleteBook(1, { deleteFiles: false });

    expect(exclusions!.recordExclusion).toHaveBeenCalledWith(
      expect.objectContaining({ authorName: 'Brandon Sanderson' }),
      expect.anything(),
      'deleted',
      expect.anything(),
    );
  });

  it('passes a null author for a book with no authors', async () => {
    const { service, exclusions } = createService({
      bookService: { getById: vi.fn().mockResolvedValue({ ...importedBook, authors: [] }) },
    });

    await service.deleteBook(1, { deleteFiles: false });

    expect(exclusions!.recordExclusion).toHaveBeenCalledWith(
      expect.objectContaining({ authorName: null }),
      expect.anything(),
      'deleted',
      expect.anything(),
    );
  });

  it('records NO exclusion for a manually added book', async () => {
    const { service, exclusions, bookService } = createService();

    const result = await service.deleteBook(1, { deleteFiles: false });

    expect(result).toEqual({ outcome: 'deleted', bookTitle: 'The Way of Kings' });
    expect(exclusions!.recordExclusion).not.toHaveBeenCalled();
    expect(bookService.delete).toHaveBeenCalledWith(1, expect.anything());
  });

  it('records NO exclusion when the import list was deleted first and nulled the provenance', async () => {
    // `books.import_list_id` is ON DELETE SET NULL, so deleting the LIST erases the only evidence
    // that a list ever added the book. The gap is documented; this pins it in both directions.
    const { service, exclusions } = createService({
      bookService: {
        getById: vi.fn().mockResolvedValue({ ...importedBook, importListId: null, importListName: null }),
      },
    });

    await service.deleteBook(1, { deleteFiles: false });

    expect(exclusions!.recordExclusion).not.toHaveBeenCalled();
  });

  it('records NO exclusion for an unknown book id', async () => {
    const { service, exclusions } = createService({
      bookService: {
        getById: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue(false),
      },
    });

    const result = await service.deleteBook(404, { deleteFiles: false });

    expect(result).toEqual({ outcome: 'not_found' });
    expect(exclusions!.recordExclusion).not.toHaveBeenCalled();
  });

  it('releases the add-ledger rows for the same identity, on the caller-owned transaction (#2530)', async () => {
    const { service, exclusions, db } = createService({
      bookService: { getById: vi.fn().mockResolvedValue(importedBook) },
    });

    await service.deleteBook(1, { deleteFiles: false });

    expect(exclusions!.removeAdded).toHaveBeenCalledWith(
      { title: 'The Way of Kings', asin: 'B0ABC12345', authorName: 'Brandon Sanderson' },
      db,
    );
  });

  it('releases NO add-ledger row for a manually added book (#2530)', async () => {
    const { service, exclusions } = createService();

    await service.deleteBook(1, { deleteFiles: false });

    expect(exclusions!.removeAdded).not.toHaveBeenCalled();
  });

  it('records NO exclusion when managed file deletion fails', async () => {
    const { service, exclusions, downloadOrchestrator } = createService({
      bookService: {
        getById: vi.fn().mockResolvedValue(importedBook),
        deleteBookFiles: vi.fn().mockResolvedValue({ deletedManaged: [], preservedForeign: [], failedManaged: ['/a.m4b'] }),
      },
    });

    const result = await service.deleteBook(1, { deleteFiles: true });

    expect(result.outcome).toBe('file_deletion_failed');
    expect(exclusions!.recordExclusion).not.toHaveBeenCalled();
    expect(downloadOrchestrator.cancel).not.toHaveBeenCalled();
  });

  it('records NO exclusion when the path is outside the library root', async () => {
    const { service, exclusions } = createService({
      bookService: {
        getById: vi.fn().mockResolvedValue(importedBook),
        deleteBookFiles: vi.fn().mockRejectedValue(new PathOutsideLibraryError('/elsewhere/book', '/audiobooks')),
      },
    });

    const result = await service.deleteBook(1, { deleteFiles: true });

    expect(result.outcome).toBe('path_outside_library');
    expect(exclusions!.recordExclusion).not.toHaveBeenCalled();
  });

  it('aborts the whole deletion when the exclusion write rejects — no cancel, no event, no row delete', async () => {
    const { service, bookService, downloadOrchestrator, eventHistory, downloadService } = createService({
      bookService: { getById: vi.fn().mockResolvedValue(importedBook) },
      downloadService: { getActiveByBookId: vi.fn().mockResolvedValue([{ id: 77 }]) },
      exclusions: { recordExclusion: vi.fn().mockRejectedValue(new Error('exclusions table locked')) },
    });

    await expect(service.deleteBook(1, { deleteFiles: false })).rejects.toThrow('exclusions table locked');

    // All three downstream ports, not just the row delete: a placement that had already cancelled
    // downloads and told Activity the book was gone would still satisfy the last assertion alone.
    expect(downloadService.getActiveByBookId).not.toHaveBeenCalled();
    expect(downloadOrchestrator.cancel).not.toHaveBeenCalled();
    expect(eventHistory!.create).not.toHaveBeenCalled();
    expect(bookService.delete).not.toHaveBeenCalled();
  });

  it('aborts the same way after a SUCCESSFUL disk step — the files are already gone, inherited', async () => {
    // The pre-existing failure profile of anything after the irreversible disk step. This
    // placement minimises the window rather than widening it.
    const deleteBookFiles = vi.fn().mockResolvedValue({
      deletedManaged: ['/audiobooks/Sanderson/Way of Kings/1.m4b'],
      preservedForeign: [],
      failedManaged: [],
    });
    const { service, bookService, downloadOrchestrator, eventHistory } = createService({
      bookService: { getById: vi.fn().mockResolvedValue(importedBook), deleteBookFiles },
      exclusions: { recordExclusion: vi.fn().mockRejectedValue(new Error('exclusions table locked')) },
    });

    await expect(service.deleteBook(1, { deleteFiles: true })).rejects.toThrow('exclusions table locked');

    expect(deleteBookFiles).toHaveBeenCalled();
    expect(downloadOrchestrator.cancel).not.toHaveBeenCalled();
    expect(eventHistory!.create).not.toHaveBeenCalled();
    expect(bookService.delete).not.toHaveBeenCalled();
  });

  it('deletes normally when no exclusion service is wired', async () => {
    const { service, bookService } = createService({
      bookService: { getById: vi.fn().mockResolvedValue(importedBook) },
      exclusions: null,
    });

    const result = await service.deleteBook(1, { deleteFiles: false });

    expect(result).toEqual({ outcome: 'deleted', bookTitle: 'The Way of Kings' });
    expect(bookService.delete).toHaveBeenCalledWith(1, expect.anything());
  });
});

/**
 * The bulk sweep. It owns enumeration, the delete-time membership re-check and the counters —
 * nothing else. Every durable decision belongs to `deleteBook`, which is why these cases assert
 * delegation and isolation rather than re-testing the exclusion policy.
 */
describe('BookDeletionService.deleteMissingBooks — the sweep (#2329)', () => {
  const missingBook = (id: number, overrides: Record<string, unknown> = {}) => ({
    ...createMockDbBook({ id, title: `Book ${id}`, status: 'missing', importListId: 5 }),
    importListName: 'NYT Bestsellers',
    authors: [{ name: 'Jane Doe' }],
    narrators: [],
    ...overrides,
  });

  function sweep(ids: number[], opts?: Parameters<typeof createService>[0]) {
    return createService({
      ...opts,
      bookService: {
        findIdsByStatus: vi.fn().mockResolvedValue(ids),
        getStatusById: vi.fn().mockResolvedValue('missing'),
        getById: vi.fn().mockImplementation(async (id: number) => missingBook(id)),
        delete: vi.fn().mockResolvedValue(true),
        ...opts?.bookService,
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes every enumerated missing book and counts them', async () => {
    const { service, bookService } = sweep([1, 2, 3]);

    const result = await service.deleteMissingBooks();

    expect(result).toEqual({ deleted: 3, failed: 0 });
    expect(bookService.findIdsByStatus).toHaveBeenCalledWith('missing');
    expect((bookService.delete as Mock).mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it('reports an empty sweep without opening a transaction', async () => {
    const { service, db } = sweep([]);

    expect(await service.deleteMissingBooks()).toEqual({ deleted: 0, failed: 0 });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('routes through the shared single-book routine, never touching disk', async () => {
    const { service } = sweep([1, 2]);
    const deleteBook = vi.spyOn(service, 'deleteBookWithinAdmissionLock');

    await service.deleteMissingBooks();

    expect(deleteBook).toHaveBeenCalledTimes(2);
    expect(deleteBook).toHaveBeenNthCalledWith(1, 1, { deleteFiles: false });
    expect(deleteBook).toHaveBeenNthCalledWith(2, 2, { deleteFiles: false });
  });

  it('opens one transaction per book and none of its own', async () => {
    const { service, db } = sweep([1, 2, 3]);

    await service.deleteMissingBooks();

    expect(db.transaction).toHaveBeenCalledTimes(3);
  });

  it('runs the per-book deletions sequentially', async () => {
    const started: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const db = createMockDb();
    db.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      started.push(started.length + 1);
      if (started.length === 1) await gate;
      return cb(db);
    });
    const { service } = sweep([1, 2], { db });

    const run = service.deleteMissingBooks();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([1]);

    release();
    expect(await run).toEqual({ deleted: 2, failed: 0 });
    expect(started).toEqual([1, 2]);
  });

  describe('per-book failure isolation', () => {
    const rejectDeleteOf = (target: number) =>
      vi.fn().mockImplementation(async (id: number) => {
        if (id === target) throw new Error(`row ${id} locked`);
        return true;
      });

    it('leaves the failing book behind, deletes the rest, and counts it failed', async () => {
      const { service, log, bookService } = sweep([1, 2, 3], { bookService: { delete: rejectDeleteOf(1) } });

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 2, failed: 1 });
      expect((bookService.delete as Mock).mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, error: expect.objectContaining({ message: 'row 1 locked' }) }),
        'Failed to delete missing book',
      );
    });

    it('isolates a failure on the LAST book of the batch', async () => {
      const { service } = sweep([1, 2, 3], { bookService: { delete: rejectDeleteOf(3) } });

      expect(await service.deleteMissingBooks()).toEqual({ deleted: 2, failed: 1 });
    });

    it('counts a rejected delete-time status read as failed and keeps sweeping', async () => {
      const getStatusById = vi.fn().mockImplementation(async (id: number) => {
        if (id === 2) throw new Error('status read failed');
        return 'missing';
      });
      const { service, bookService } = sweep([1, 2, 3], { bookService: { getStatusById } });

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 2, failed: 1 });
      expect((bookService.delete as Mock).mock.calls.map((c) => c[0])).toEqual([1, 3]);
    });

    it('propagates a rejected enumeration — there is no sweep to isolate', async () => {
      const { service, db } = sweep([], {
        bookService: { findIdsByStatus: vi.fn().mockRejectedValue(new Error('DB error')) },
      });

      await expect(service.deleteMissingBooks()).rejects.toThrow('DB error');
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe('the delete-time membership re-check', () => {
    it('skips a book a concurrent scan restored, counting it in neither bucket', async () => {
      const getStatusById = vi.fn().mockImplementation(async (id: number) => (id === 2 ? 'imported' : 'missing'));
      const { service, bookService, log } = sweep([1, 2], { bookService: { getStatusById } });

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 1, failed: 0 });
      expect((bookService.delete as Mock).mock.calls.map((c) => c[0])).toEqual([1]);
      expect(log.info).toHaveBeenCalledWith({ bookId: 2, status: 'imported' }, 'Skipped book that is no longer missing');
    });

    it('skips a row that vanished before its turn, counting it in neither bucket', async () => {
      const getStatusById = vi.fn().mockImplementation(async (id: number) => (id === 2 ? null : 'missing'));
      const { service, bookService } = sweep([1, 2], { bookService: { getStatusById } });

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 1, failed: 0 });
      expect((bookService.delete as Mock).mock.calls.map((c) => c[0])).toEqual([1]);
    });

    it.each([
      ['file_deletion_failed', { outcome: 'file_deletion_failed' as const, error: 'Failed to delete book files from disk' }],
      ['path_outside_library', { outcome: 'path_outside_library' as const, error: '/elsewhere is not inside library root' }],
    ])('counts a %s disk outcome as failed and warns, should it ever escape deleteFiles: false', async (outcome, result) => {
      // Unreachable through the sweep's own inputs — the disk arm needs `deleteFiles: true` — so
      // the arm is stubbed. AC7 still specifies the bucket, and mis-bucketing it under-reports
      // the operator-visible failure count.
      const { service, log } = sweep([1, 2]);
      vi.spyOn(service, 'deleteBookWithinAdmissionLock')
        .mockResolvedValueOnce(result)
        .mockResolvedValueOnce({ outcome: 'deleted', bookTitle: 'Book 2' });

      expect(await service.deleteMissingBooks()).toEqual({ deleted: 1, failed: 1 });
      expect(log.warn).toHaveBeenCalledWith({ bookId: 1, outcome }, 'Unexpected disk outcome sweeping missing books');
    });

    it('counts a not_found race in neither bucket', async () => {
      // The row survived the re-check and hydration, then vanished before the transaction's delete.
      const del = vi.fn().mockImplementation(async (id: number) => id !== 2);
      const { service, log } = sweep([1, 2], { bookService: { delete: del } });

      const result = await service.deleteMissingBooks();

      expect(result).toEqual({ deleted: 1, failed: 0 });
      expect(log.debug).toHaveBeenCalledWith({ bookId: 2 }, 'Missing book vanished before the sweep deleted it');
    });
  });
});
