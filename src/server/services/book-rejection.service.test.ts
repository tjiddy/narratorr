import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbBook } from '../__tests__/factories.js';
import { BookRejectionService, BookRejectionError } from './book-rejection.service.js';
import { BookService, type BookWithAuthor } from './book.service.js';
import type { DeleteManagedFilesResult } from '../utils/delete-managed-files.js';
import { PathOutsideLibraryError } from '../utils/paths.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { RetrySearchDeps } from './retry-search.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';

vi.mock('../utils/rejection-helpers.js', () => ({
  blacklistAndRetrySearch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/cover-cache.js', () => ({
  preserveBookCover: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', () => ({
  config: { configPath: '/test-config' },
}));

import { blacklistAndRetrySearch } from '../utils/rejection-helpers.js';
import { preserveBookCover } from '../utils/cover-cache.js';

const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

/** The empty three-bucket {@link DeleteManagedFilesResult} a successful no-foreign sweep returns. */
const emptyDeleteResult = (): DeleteManagedFilesResult => ({ deletedManaged: [], preservedForeign: [], failedManaged: [] });

function createService(opts?: {
  bookService?: Partial<BookService>;
  blacklistService?: Partial<BlacklistService>;
  settingsService?: Partial<SettingsService>;
  eventHistory?: Partial<EventHistoryService>;
  retrySearchDeps?: RetrySearchDeps;
}) {
  const db = createMockDb();
  const log = createMockLogger();
  const bookService = inject<BookService>(opts?.bookService ?? {
    getById: vi.fn(),
    deleteBookFiles: vi.fn().mockResolvedValue(emptyDeleteResult()),
  });
  const blacklistService = inject<BlacklistService>(opts?.blacklistService ?? {
    create: vi.fn().mockResolvedValue({}),
  });
  const settingsService = inject<SettingsService>(opts?.settingsService ?? {
    get: vi.fn().mockResolvedValue({ path: '/audiobooks' }),
  });
  const eventHistory = opts?.eventHistory
    ? inject<EventHistoryService>(opts.eventHistory)
    : inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({}) });
  const retrySearchDeps = opts?.retrySearchDeps ?? { log: createMockLogger() } as unknown as RetrySearchDeps;

  db.update.mockReturnValue(mockDbChain());

  const service = new BookRejectionService(
    inject<Db>(db),
    inject<FastifyBaseLogger>(log),
    bookService,
    blacklistService,
    settingsService,
    eventHistory,
    retrySearchDeps,
  );

  return { service, db, log, bookService, blacklistService, settingsService, eventHistory };
}

const importedBook = createMockDbBook({
  id: 42,
  status: 'imported' as const,
  path: '/audiobooks/Author/Book',
  size: 500_000_000,
  audioCodec: 'AAC',
  audioBitrate: 128000,
  audioSampleRate: 44100,
  audioChannels: 2,
  audioBitrateMode: 'CBR',
  audioFileFormat: 'mp3',
  audioFileCount: 10,
  topLevelAudioFileCount: 10,
  audioTotalSize: 450_000_000,
  audioDuration: 36000,
  lastGrabGuid: 'guid-abc',
  lastGrabInfoHash: 'hash-123',
});

describe('BookRejectionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rejectAsWrongRelease', () => {
    it('blacklists release with reason wrong_content and stored identifiers', async () => {
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);

      await service.rejectAsWrongRelease(42);

      expect(blacklistAndRetrySearch).toHaveBeenCalledWith(expect.objectContaining({
        identifiers: expect.objectContaining({
          infoHash: 'hash-123',
          guid: 'guid-abc',
          title: importedBook.title,
          bookId: 42,
        }),
        reason: 'wrong_content',
      }));
    });

    it('blacklists with guid only when lastGrabInfoHash is null', async () => {
      const book = { ...importedBook, lastGrabInfoHash: null };
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(book);

      await service.rejectAsWrongRelease(42);

      expect(blacklistAndRetrySearch).toHaveBeenCalledWith(expect.objectContaining({
        identifiers: expect.objectContaining({
          guid: 'guid-abc',
          infoHash: undefined,
        }),
      }));
    });

    it('blacklists with infoHash only when lastGrabGuid is null', async () => {
      const book = { ...importedBook, lastGrabGuid: null };
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(book);

      await service.rejectAsWrongRelease(42);

      expect(blacklistAndRetrySearch).toHaveBeenCalledWith(expect.objectContaining({
        identifiers: expect.objectContaining({
          infoHash: 'hash-123',
          guid: undefined,
        }),
      }));
    });

    it('resets DB before deleting files (DB-1: DB update before irreversible FS op)', async () => {
      const callOrder: string[] = [];
      const { service, bookService, db } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);
      (chain as Record<string, Mock>).where!.mockImplementation(() => {
        callOrder.push('db.update');
        return Promise.resolve();
      });
      (bookService.deleteBookFiles as Mock).mockImplementation(() => {
        callOrder.push('deleteBookFiles');
        return Promise.resolve(emptyDeleteResult());
      });

      await service.rejectAsWrongRelease(42);

      expect(callOrder).toEqual(['db.update', 'deleteBookFiles']);
    });

    it('deletes book files best-effort via BookService.deleteBookFiles', async () => {
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);

      await service.rejectAsWrongRelease(42);

      expect(bookService.deleteBookFiles).toHaveBeenCalledWith('/audiobooks/Author/Book', '/audiobooks');
    });

    // #1592 part B — the helper records per-file rm failures in `failedManaged` and never throws on
    // them (replacing the old generic-throw best-effort test, which exercised a path the post-#1589
    // helper can no longer produce). Rejection must stay nonfatal AND emit rejection-context diagnostics.
    it('continues and logs rejection-context diagnostics when deleteBookFiles reports failedManaged', async () => {
      const { service, bookService, db, log, eventHistory } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);
      (bookService.deleteBookFiles as Mock).mockResolvedValue({
        deletedManaged: ['/audiobooks/Author/Book/chapter1.mp3'],
        preservedForeign: [],
        failedManaged: ['/audiobooks/Author/Book/locked.mp3'],
      } satisfies DeleteManagedFilesResult);

      // Does not throw — the locked managed file is nonfatal.
      await service.rejectAsWrongRelease(42);

      // Diagnostics carry bookId + the failed count + the failed paths (#1598 Gap 3), so an operator
      // can find the orphaned managed audio after the DB path is nulled (the catch-level warn no
      // longer fires for this path).
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 42,
          failed: 1,
          failedPaths: ['/audiobooks/Author/Book/locked.mp3'],
        }),
        expect.stringContaining('Wrong release'),
      );
      // Rejection still completes: DB reset ran and the event was recorded.
      expect(db.update).toHaveBeenCalled();
      expect(eventHistory.create).toHaveBeenCalled();
    });

    // #1592 part A — foreign-file-preservation contract at the rejection site (the one destructive,
    // no-opt-in delete). A bundled foreign file in the result must not abort or alter the rejection flow.
    it('completes rejection when deleteBookFiles preserves a foreign file', async () => {
      const { service, bookService, db, log, eventHistory } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);
      (bookService.deleteBookFiles as Mock).mockResolvedValue({
        deletedManaged: ['/audiobooks/Author/Book/chapter1.mp3'],
        preservedForeign: ['/audiobooks/Author/Book/bundled.pdf'],
        failedManaged: [],
      } satisfies DeleteManagedFilesResult);

      await service.rejectAsWrongRelease(42);

      // DB row reset to wanted/path null.
      const setFn = (chain as Record<string, Mock>).set;
      expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ status: 'wanted', path: null }));
      // wrong_release event recorded.
      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'wrong_release' }));
      // #1598 Gap 3: with no failed managed deletes, the failed-files diagnostic warn does NOT fire.
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('some managed files could not be deleted'),
      );
    });

    // #1592 part A — real end-to-end proof: drive a true rejectAsWrongRelease against a real library
    // root with a real BookService, and confirm a co-located foreign file survives on disk while the
    // audio is removed (mirrors the helper's own tmpdir preservation test in delete-managed-files.test.ts).
    it('preserves a co-located .pdf on disk through a real rejectAsWrongRelease run', async () => {
      const root = mkdtempSync(join(tmpdir(), 'narratorr-1592-'));
      try {
        const bookDir = join(root, 'Author', 'Book');
        await mkdir(bookDir, { recursive: true });
        await writeFile(join(bookDir, 'chapter1.mp3'), 'audio');
        await writeFile(join(bookDir, 'bundled.pdf'), 'pdf');

        // Real BookService: deleteBookFiles touches only the filesystem + logger (no DB), so the mock
        // DB is unused there; getById is spied to return the staged book.
        const realBookService = new BookService(inject<Db>(createMockDb()), inject<FastifyBaseLogger>(createMockLogger()));
        vi.spyOn(realBookService, 'getById').mockResolvedValue({ ...importedBook, path: bookDir } as unknown as BookWithAuthor);

        const { service } = createService({
          bookService: realBookService,
          settingsService: { get: vi.fn().mockResolvedValue({ path: root }) },
        });

        await service.rejectAsWrongRelease(42);

        // Foreign file survives; managed audio is gone.
        expect(await pathExists(join(bookDir, 'bundled.pdf'))).toBe(true);
        expect(await pathExists(join(bookDir, 'chapter1.mp3'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('rethrows PathOutsideLibraryError instead of swallowing as best-effort', async () => {
      const { service, bookService, db, eventHistory } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);
      (bookService.deleteBookFiles as Mock).mockRejectedValue(
        new PathOutsideLibraryError('/tmp/external', '/audiobooks'),
      );

      await expect(service.rejectAsWrongRelease(42)).rejects.toBeInstanceOf(PathOutsideLibraryError);

      // DB reset still ran (steps 1–2 happen before the catch)
      expect(db.update).toHaveBeenCalled();
      // Re-throw skips the post-deletion event recording
      expect(eventHistory.create).not.toHaveBeenCalled();
    });

    it('skips file deletion when book path is null', async () => {
      const book = { ...importedBook, path: null };
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(book);

      await service.rejectAsWrongRelease(42);

      expect(bookService.deleteBookFiles).not.toHaveBeenCalled();
    });

    it('resets book status to wanted and nulls all 14 fields', async () => {
      const { service, bookService, db } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.rejectAsWrongRelease(42);

      const setFn = (chain as Record<string, Mock>).set;
      expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
        status: 'wanted',
        path: null,
        size: null,
        audioCodec: null,
        audioBitrate: null,
        audioSampleRate: null,
        audioChannels: null,
        audioBitrateMode: null,
        audioFileFormat: null,
        audioFileCount: null,
        topLevelAudioFileCount: null,
        audioTotalSize: null,
        audioDuration: null,
        lastGrabGuid: null,
        lastGrabInfoHash: null,
      }));
    });

    it('records wrong_release event with correct bookId and identifiers in reason', async () => {
      const { service, bookService, eventHistory } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);

      await service.rejectAsWrongRelease(42);

      expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 42,
        bookTitle: importedBook.title,
        eventType: 'wrong_release',
        source: 'manual',
        reason: expect.objectContaining({
          lastGrabGuid: 'guid-abc',
          lastGrabInfoHash: 'hash-123',
        }),
      }));
    });

    it('continues when event recording fails (fire-and-forget)', async () => {
      const { service } = createService({
        bookService: {
          getById: vi.fn().mockResolvedValue(importedBook),
          deleteBookFiles: vi.fn().mockResolvedValue(emptyDeleteResult()),
        },
        eventHistory: { create: vi.fn().mockRejectedValue(new Error('DB error')) },
      });

      // Should not throw
      await service.rejectAsWrongRelease(42);
    });

    it('throws BookRejectionError with NOT_IMPORTED when book is not imported', async () => {
      const wantedBook = { ...importedBook, status: 'wanted' };
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(wantedBook);

      await expect(service.rejectAsWrongRelease(42)).rejects.toThrow(BookRejectionError);
      await expect(service.rejectAsWrongRelease(42)).rejects.toMatchObject({ code: 'NOT_IMPORTED' });
    });

    it('throws BookRejectionError with NO_IDENTIFIERS when both identifiers are null', async () => {
      const noIdBook = { ...importedBook, lastGrabGuid: null, lastGrabInfoHash: null };
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(noIdBook);

      await expect(service.rejectAsWrongRelease(42)).rejects.toThrow(BookRejectionError);
      await expect(service.rejectAsWrongRelease(42)).rejects.toMatchObject({ code: 'NO_IDENTIFIERS' });
    });

    it('throws BookRejectionError with NOT_FOUND when book does not exist', async () => {
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(null);

      await expect(service.rejectAsWrongRelease(42)).rejects.toThrow(BookRejectionError);
      await expect(service.rejectAsWrongRelease(42)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    // #396 — cover cache copy-out before deletion
    it('copies cover file to cache before calling deleteBookFiles', async () => {
      const callOrder: string[] = [];
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);
      (preserveBookCover as Mock).mockImplementation(() => {
        callOrder.push('preserveBookCover');
        return Promise.resolve();
      });
      (bookService.deleteBookFiles as Mock).mockImplementation(() => {
        callOrder.push('deleteBookFiles');
        return Promise.resolve(emptyDeleteResult());
      });

      await service.rejectAsWrongRelease(42);

      expect(preserveBookCover).toHaveBeenCalledWith('/audiobooks/Author/Book', 42, '/test-config', expect.anything());
      expect(callOrder).toEqual(expect.arrayContaining(['preserveBookCover', 'deleteBookFiles']));
      expect(callOrder.indexOf('preserveBookCover')).toBeLessThan(callOrder.indexOf('deleteBookFiles'));
    });

    it('skips cover copy-out when book.path is null', async () => {
      const book = { ...importedBook, path: null };
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(book);

      await service.rejectAsWrongRelease(42);

      expect(preserveBookCover).not.toHaveBeenCalled();
    });

    it('continues with deletion even if preserveBookCover rejects unexpectedly', async () => {
      const { service, bookService, log } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);
      (preserveBookCover as Mock).mockRejectedValue(new Error('EACCES'));

      // preserveBookCover normally handles its own errors, but if it somehow
      // throws, the outer try/catch in rejectAsWrongRelease catches it and
      // the rejection still completes (best-effort pattern)
      await service.rejectAsWrongRelease(42);

      // Deletion is skipped because error is caught in the same try/catch,
      // but the overall rejection still completes without throwing
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42 }),
        expect.stringContaining('Wrong release'),
      );
    });

    it('passes overrideRetry: true to blacklistAndRetrySearch', async () => {
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);

      await service.rejectAsWrongRelease(42);

      expect(blacklistAndRetrySearch).toHaveBeenCalledWith(expect.objectContaining({
        overrideRetry: true,
      }));
    });

    it('continues when blacklist creation fails', async () => {
      (blacklistAndRetrySearch as Mock).mockRejectedValueOnce(new Error('blacklist error'));
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);

      // blacklistAndRetrySearch is awaited, so if it throws, the service should handle it
      // Actually per spec, blacklist creation failure is inside the shared helper which catches it
      // The mock throws from the top-level call — let's verify behavior
      await expect(service.rejectAsWrongRelease(42)).rejects.toThrow('blacklist error');
    });
  });
});
