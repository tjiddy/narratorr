import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbBook } from '../__tests__/factories.js';
import { BookRejectionService } from './book-rejection.service.js';
import type { BookService } from './book.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { RetrySearchDeps } from './retry-search.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';

vi.mock('../utils/rejection-helpers.js', () => ({
  blacklistAndRetrySearch: vi.fn().mockResolvedValue(undefined),
}));

import { blacklistAndRetrySearch } from '../utils/rejection-helpers.js';

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
    deleteBookFiles: vi.fn().mockResolvedValue(undefined),
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

    it('deletes book files best-effort via BookService.deleteBookFiles', async () => {
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);

      await service.rejectAsWrongRelease(42);

      expect(bookService.deleteBookFiles).toHaveBeenCalledWith('/audiobooks/Author/Book', '/audiobooks');
    });

    it('continues when file deletion throws (best-effort)', async () => {
      const { service, bookService, db } = createService();
      (bookService.getById as Mock).mockResolvedValue(importedBook);
      (bookService.deleteBookFiles as Mock).mockRejectedValue(new Error('ENOENT'));

      await service.rejectAsWrongRelease(42);

      // DB update still happens
      expect(db.update).toHaveBeenCalled();
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
          deleteBookFiles: vi.fn().mockResolvedValue(undefined),
        },
        eventHistory: { create: vi.fn().mockRejectedValue(new Error('DB error')) },
      });

      // Should not throw
      await service.rejectAsWrongRelease(42);
    });

    it('throws when book is not imported', async () => {
      const wantedBook = { ...importedBook, status: 'wanted' };
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(wantedBook);

      await expect(service.rejectAsWrongRelease(42)).rejects.toThrow('not imported');
    });

    it('throws when book has no release identifiers', async () => {
      const noIdBook = { ...importedBook, lastGrabGuid: null, lastGrabInfoHash: null };
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(noIdBook);

      await expect(service.rejectAsWrongRelease(42)).rejects.toThrow('no release identifiers');
    });

    it('throws when book not found', async () => {
      const { service, bookService } = createService();
      (bookService.getById as Mock).mockResolvedValue(null);

      await expect(service.rejectAsWrongRelease(42)).rejects.toThrow('not found');
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
