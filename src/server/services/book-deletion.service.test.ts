import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createMockLogger, inject } from '../__tests__/helpers.js';
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

function createService(opts?: {
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
  const bookService = inject<BookService>({
    getById: vi.fn().mockResolvedValue(deletableBook),
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
    : inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({}), ...opts?.eventHistory });

  const exclusions = opts?.exclusions === null
    ? undefined
    : inject<ImportListExclusionService>({
      recordExclusion: vi.fn().mockResolvedValue({ id: 99 }),
      ...opts?.exclusions,
    });

  const service = new BookDeletionService(
    bookService,
    downloadService,
    downloadOrchestrator,
    settingsService,
    inject<FastifyBaseLogger>(log),
    eventHistory,
    exclusions,
  );

  return { service, log, bookService, downloadService, downloadOrchestrator, settingsService, eventHistory, exclusions };
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

    it('cancels active downloads BEFORE the DB delete', async () => {
      const cancel = vi.fn().mockResolvedValue(true);
      const { service, bookService } = createService({
        downloadService: { getActiveByBookId: vi.fn().mockResolvedValue([{ id: 10 }]) },
        downloadOrchestrator: { cancel },
      });

      await service.deleteBook(1, { deleteFiles: false });

      const cancelOrder = cancel.mock.invocationCallOrder[0]!;
      const deleteOrder = (bookService.delete as Mock).mock.invocationCallOrder[0]!;
      expect(cancelOrder).toBeLessThan(deleteOrder);
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
      expect(bookService.delete).toHaveBeenCalledWith(1);
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
      expect(bookService.delete).toHaveBeenCalledWith(1);
    });

    it('omits fileSummary when deleteFiles is false (no on-disk delete)', async () => {
      const { service } = createService();

      const result = await service.deleteBook(1, { deleteFiles: false });

      expect(result).toEqual({ outcome: 'deleted', bookTitle: 'The Way of Kings' });
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
      expect(bookService.delete).toHaveBeenCalledWith(1);
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
    const { service, exclusions } = createService({
      bookService: { getById: vi.fn().mockResolvedValue(importedBook) },
    });

    await service.deleteBook(1, { deleteFiles: false });

    expect(exclusions!.recordExclusion).toHaveBeenCalledWith(
      { title: 'The Way of Kings', asin: 'B0ABC12345', authorName: 'Brandon Sanderson' },
      { importListId: 5, importListName: 'NYT Bestsellers' },
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
    );
  });

  it('records NO exclusion for a manually added book', async () => {
    const { service, exclusions, bookService } = createService();

    const result = await service.deleteBook(1, { deleteFiles: false });

    expect(result).toEqual({ outcome: 'deleted', bookTitle: 'The Way of Kings' });
    expect(exclusions!.recordExclusion).not.toHaveBeenCalled();
    expect(bookService.delete).toHaveBeenCalledWith(1);
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
        deleteBookFiles: vi.fn().mockRejectedValue(new PathOutsideLibraryError('outside')),
      },
    });

    const result = await service.deleteBook(1, { deleteFiles: true });

    expect(result.outcome).toBe('path_outside_library');
    expect(exclusions!.recordExclusion).not.toHaveBeenCalled();
  });

  it('aborts the whole deletion when the exclusion write rejects — no cancel, no event, no row delete', async () => {
    const { service, exclusions, bookService, downloadOrchestrator, eventHistory, downloadService } = createService({
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
    expect(bookService.delete).toHaveBeenCalledWith(1);
  });
});
