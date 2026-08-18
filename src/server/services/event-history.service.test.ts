import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { createMockDb, createMockLogger, inject, mockDbChain, createMockSettingsService, mockSearchAllWithStatus } from '../__tests__/helpers.js';
import { createMockDbBookEvent } from '../__tests__/factories.js';

import type * as RetrySearchModule from './retry-search.js';
vi.mock('./retry-search.js', async () => {
  const actual = await vi.importActual<typeof RetrySearchModule>('./retry-search.js');
  return { ...actual, retrySearch: vi.fn(actual.retrySearch) };
});

import { EventHistoryService, EventHistoryServiceError } from './event-history.service.js';
import { retrySearch } from './retry-search.js';
import type { BlacklistService } from './blacklist.service.js';
import type { BookService } from './book.service.js';

describe('EventHistoryService', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let blacklistService: { create: ReturnType<typeof vi.fn> };
  let bookService: { updateStatus: ReturnType<typeof vi.fn> };
  let service: EventHistoryService;

  beforeEach(() => {
    db = createMockDb();
    log = createMockLogger();
    blacklistService = { create: vi.fn().mockResolvedValue(undefined) };
    bookService = { updateStatus: vi.fn().mockResolvedValue(undefined) };
    service = new EventHistoryService(
      inject<Db>(db),
      inject<FastifyBaseLogger>(log),
      inject<BlacklistService>(blacklistService),
      inject<BookService>(bookService),
    );
  });

  // Fresh unwired service sharing the assertion mocks.
  function freshService(): EventHistoryService {
    return new EventHistoryService(
      inject<Db>(db),
      inject<FastifyBaseLogger>(log),
      inject<BlacklistService>(blacklistService),
      inject<BookService>(bookService),
    );
  }

  describe('create', () => {
    it('inserts an event and returns the row', async () => {
      const mockEvent = createMockDbBookEvent();
      db.insert.mockReturnValue(mockDbChain([mockEvent]));

      const result = await service.create({
        bookId: 1,
        bookTitle: 'The Way of Kings',
        authorName: 'Brandon Sanderson',
        eventType: 'grabbed',
        source: 'auto',
        reason: { score: 95 },
      });

      expect(result).toEqual(mockEvent);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 1, eventType: 'grabbed' }),
        'Event recorded',
      );
    });
  });

  describe('getAll', () => {
    it('returns events in { data, total } envelope', async () => {
      const events = [createMockDbBookEvent({ id: 2 }), createMockDbBookEvent({ id: 1 })];
      // Count query precedes data query.
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 2 }]))
        .mockReturnValueOnce(mockDbChain(events));

      const result = await service.getAll();
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('filters by event type', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([createMockDbBookEvent()]));

      const result = await service.getAll({ eventType: ['grabbed'] });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('filters by title search', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([createMockDbBookEvent()]));

      const result = await service.getAll({ search: 'Kings' });
      expect(result.data).toHaveLength(1);
    });

    it('filters by both event type and search', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([createMockDbBookEvent()]));

      const result = await service.getAll({ eventType: ['grabbed'], search: 'Kings' });
      expect(result.data).toHaveLength(1);
    });

    it('returns empty data with total 0 when no events', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll();
      expect(result).toEqual({ data: [], total: 0 });
    });

    it('applies limit and offset when provided', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 50 }]))
        .mockReturnValueOnce(mockDbChain([createMockDbBookEvent()]));

      const result = await service.getAll(undefined, { limit: 10, offset: 20 });
      expect(result.total).toBe(50);
      expect(result.data).toHaveLength(1);
    });

    it('returns total reflecting filtered count before limit/offset', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 25 }]))
        .mockReturnValueOnce(mockDbChain([createMockDbBookEvent()]));

      const result = await service.getAll({ eventType: ['grabbed'] }, { limit: 10, offset: 0 });
      expect(result.total).toBe(25);
    });

    it('paginates the data query only, leaving the filtered count query unwindowed', async () => {
      const countChain = mockDbChain([{ value: 25 }]);
      const dataChain = mockDbChain([createMockDbBookEvent()]);
      db.select.mockReturnValueOnce(countChain).mockReturnValueOnce(dataChain);

      const result = await service.getAll(
        { eventType: ['grabbed'], search: 'Kings' },
        { limit: 10, offset: 20 },
      );

      expect(dataChain.limit).toHaveBeenCalledWith(10);
      expect(dataChain.offset).toHaveBeenCalledWith(20);
      expect(countChain.limit).not.toHaveBeenCalled();
      expect(countChain.offset).not.toHaveBeenCalled();
      expect(result.total).toBe(25);
    });

    it('applies stable orderBy with createdAt DESC, id DESC', async () => {
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(dataChain);

      await service.getAll();

      expect(dataChain.orderBy).toHaveBeenCalledTimes(1);
      const args = (dataChain.orderBy as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args).toHaveLength(2);
    });
  });

  describe('getByBookId', () => {
    it('returns events for a specific book', async () => {
      const events = [createMockDbBookEvent()];
      db.select.mockReturnValue(mockDbChain(events));

      const result = await service.getByBookId(1);
      expect(result).toHaveLength(1);
    });

    it('returns empty array when no events exist', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getByBookId(999);
      expect(result).toEqual([]);
    });
  });

  describe('getById', () => {
    it('returns event by id', async () => {
      const event = createMockDbBookEvent();
      db.select.mockReturnValue(mockDbChain([event]));

      const result = await service.getById(1);
      expect(result).toEqual(event);
    });

    it('returns null when not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getById(999);
      expect(result).toBeNull();
    });
  });

  describe('markFailed', () => {
    beforeEach(() => {
      // Most cases need retry dispatch wired; dedicated tests create fresh unwired services.
      service.wire({ retrySearchDeps: { log: createMockLogger() } as never });
    });

    it('blacklists release and reverts book to wanted', async () => {
      const event = createMockDbBookEvent({ downloadId: 5 });
      const download = { id: 5, infoHash: 'abc123', title: 'The Way of Kings [MP3]' };

      // markFailed loads the event, then its download.
      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      const result = await service.markFailed(1);

      expect(result).toEqual({ success: true });
      expect(blacklistService.create).toHaveBeenCalledWith({
        infoHash: 'abc123',
        title: 'The Way of Kings [MP3]',
        bookId: 1,
        reason: 'bad_quality',
      });
      expect(bookService.updateStatus).toHaveBeenCalledWith(1, 'wanted');
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 1, downloadId: 5 }),
        'Event marked as failed',
      );
    });

    /**
     * #2420 — "mark failed" is the user-facing blacklist action, and it wrote infoHash with no
     * guid. ABB search results no longer carry a hash, so without the guid the operator sees the
     * action succeed and the same release grabbed again on the next cycle.
     */
    it('carries the download row\'s guid onto the bad_quality entry', async () => {
      const guid = 'abb:/audio-books/murder-in-the-new-forest/';
      const event = createMockDbBookEvent({ downloadId: 5 });
      const download = { id: 5, infoHash: 'abc123', guid, title: 'The Way of Kings [MP3]' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      await service.markFailed(1);

      expect(blacklistService.create).toHaveBeenCalledWith({
        infoHash: 'abc123',
        guid,
        title: 'The Way of Kings [MP3]',
        bookId: 1,
        reason: 'bad_quality',
      });
    });

    // The fix must not make guid required.
    it('still blacklists on infoHash alone when the download row has a null guid', async () => {
      const event = createMockDbBookEvent({ downloadId: 5 });
      const download = { id: 5, infoHash: 'abc123', guid: null, title: 'The Way of Kings [MP3]' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      await service.markFailed(1);

      const created = blacklistService.create.mock.calls[0]![0] as Record<string, unknown>;
      expect(created.infoHash).toBe('abc123');
      expect(created.guid).toBeUndefined();
    });

    it('throws EventHistoryServiceError NOT_FOUND when event not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      await expect(service.markFailed(999)).rejects.toThrow(EventHistoryServiceError);
      await expect(service.markFailed(999)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws EventHistoryServiceError UNSUPPORTED_EVENT_TYPE on non-actionable event type', async () => {
      const event = createMockDbBookEvent({ eventType: 'deleted' });
      db.select.mockReturnValue(mockDbChain([event]));

      await expect(service.markFailed(1)).rejects.toThrow(EventHistoryServiceError);
      await expect(service.markFailed(1)).rejects.toMatchObject({ code: 'UNSUPPORTED_EVENT_TYPE' });
    });

    it('throws EventHistoryServiceError NO_DOWNLOAD when event has no download_id', async () => {
      const event = createMockDbBookEvent({ downloadId: null });
      db.select.mockReturnValue(mockDbChain([event]));

      await expect(service.markFailed(1)).rejects.toThrow(EventHistoryServiceError);
      await expect(service.markFailed(1)).rejects.toMatchObject({ code: 'NO_DOWNLOAD' });
    });

    it('skips blacklist and reverts book when download has no infoHash (Usenet)', async () => {
      const event = createMockDbBookEvent({ downloadId: 5 });
      const download = { id: 5, infoHash: null, title: 'Usenet Download' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      const result = await service.markFailed(1);

      expect(result).toEqual({ success: true });
      expect(blacklistService.create).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith(
        { downloadId: 5 },
        'Skipping blacklist — no infoHash (Usenet download)',
      );
      expect(bookService.updateStatus).toHaveBeenCalledWith(1, 'wanted');
    });

    it('throws EventHistoryServiceError DOWNLOAD_NOT_FOUND when download not found', async () => {
      const event = createMockDbBookEvent({ downloadId: 5 });
      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([]));

      const error = await service.markFailed(1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EventHistoryServiceError);
      expect(error).toMatchObject({ code: 'DOWNLOAD_NOT_FOUND' });
    });

    it('handles deleted book (null bookId) without calling updateStatus', async () => {
      const event = createMockDbBookEvent({ bookId: null, downloadId: 5 });
      const download = { id: 5, infoHash: 'abc123', title: 'Orphaned Release' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      const result = await service.markFailed(1);

      expect(result).toEqual({ success: true });
      expect(blacklistService.create).toHaveBeenCalled();
      expect(bookService.updateStatus).not.toHaveBeenCalled();
    });

    it('survives a blacklist creation failure — logs warning, still reverts book and resolves', async () => {
      const event = createMockDbBookEvent({ downloadId: 5 });
      const download = { id: 5, infoHash: 'abc123', title: 'Bad Release' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      blacklistService.create.mockRejectedValueOnce(
        new Error('UNIQUE constraint failed: idx_blacklist_guid_unique'),
      );

      const result = await service.markFailed(1);

      expect(result).toEqual({ success: true });
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 1,
          downloadId: 5,
          error: expect.objectContaining({ message: expect.stringContaining('UNIQUE') }),
        }),
        'Mark-failed blacklist creation failed — proceeding with book revert',
      );
      expect(bookService.updateStatus).toHaveBeenCalledWith(1, 'wanted');
    });
  });

  describe('markFailed search trigger', () => {
    it('triggers book-scoped retry search when retrySearchDeps are set', async () => {
      const event = createMockDbBookEvent({ downloadId: 5, bookId: 42 });
      const download = { id: 5, infoHash: 'abc123', title: 'Test' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      const { RetryBudget } = await import('./retry-budget.js');
      const mockSearchAll = mockSearchAllWithStatus([]);
      const fresh = freshService();
      fresh.wire({ retrySearchDeps: {
        indexerSearchService: { searchAllWithStatus: mockSearchAll },
        downloadOrchestrator: { grabForRetry: vi.fn(), hasGrabBlocker: vi.fn().mockResolvedValue(false) },
        downloadService: { grab: vi.fn() },
        blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()), getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) },
        bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Test', duration: 3600, path: null, author: { name: 'Author' } }) },
        settingsService: createMockSettingsService(),
        retryBudget: new RetryBudget(),
        log: createMockLogger(),
      } } as never);

      const result = await fresh.markFailed(1);

      expect(result).toEqual({ success: true });
      await vi.waitFor(() => {
        expect(mockSearchAll).toHaveBeenCalled();
      });
    });

    it('markFailed succeeds even when trigger-search fails and logs warning', async () => {
      const event = createMockDbBookEvent({ downloadId: 5, bookId: 42 });
      const download = { id: 5, infoHash: 'abc123', title: 'Test' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      const { RetryBudget } = await import('./retry-budget.js');
      const mockSearchAll = vi.fn().mockRejectedValue(new Error('Indexer down'));
      const fresh = freshService();
      fresh.wire({ retrySearchDeps: {
        indexerSearchService: { searchAllWithStatus: mockSearchAll },
        downloadOrchestrator: { grabForRetry: vi.fn(), hasGrabBlocker: vi.fn().mockResolvedValue(false) },
        downloadService: { grab: vi.fn() },
        blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()), getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) },
        bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Test', duration: 3600, path: null, author: { name: 'Author' } }) },
        settingsService: createMockSettingsService(),
        retryBudget: new RetryBudget(),
        log: createMockLogger(),
      } } as never);

      const result = await fresh.markFailed(1);
      expect(result).toEqual({ success: true });
      await vi.waitFor(() => {
        expect(mockSearchAll).toHaveBeenCalled();
      });
    });

    it('throws ServiceWireError when markFailed dispatches retry-search before wire() (required-wiring contract)', async () => {
      const event = createMockDbBookEvent({ downloadId: 5, bookId: 42 });
      const download = { id: 5, infoHash: 'abc123', title: 'Test' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      const unwiredService = freshService();

      await expect(unwiredService.markFailed(1)).rejects.toThrow(/EventHistoryService used before wire/);
    });

    it('unwired markFailed() with bookId fails BEFORE blacklist or book-status side effects', async () => {
      const event = createMockDbBookEvent({ downloadId: 5, bookId: 42 });
      const download = { id: 5, infoHash: 'abc123', title: 'Test' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      const unwiredService = freshService();

      await expect(unwiredService.markFailed(1)).rejects.toThrow(/EventHistoryService used before wire/);

      expect(blacklistService.create).not.toHaveBeenCalled();
      expect(bookService.updateStatus).not.toHaveBeenCalled();
    });

    it('still dispatches retry-search after blacklist creation failure', async () => {
      const event = createMockDbBookEvent({ downloadId: 5, bookId: 42 });
      const download = { id: 5, infoHash: 'abc123', title: 'Test' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      blacklistService.create.mockRejectedValueOnce(
        new Error('UNIQUE constraint failed: idx_blacklist_guid_unique'),
      );

      const { RetryBudget } = await import('./retry-budget.js');
      const mockSearchAll = mockSearchAllWithStatus([]);
      const fresh = freshService();
      fresh.wire({ retrySearchDeps: {
        indexerSearchService: { searchAllWithStatus: mockSearchAll },
        downloadOrchestrator: { grabForRetry: vi.fn(), hasGrabBlocker: vi.fn().mockResolvedValue(false) },
        downloadService: { grab: vi.fn() },
        blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()), getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) },
        bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Test', duration: 3600, path: null, author: { name: 'Author' } }) },
        settingsService: createMockSettingsService(),
        retryBudget: new RetryBudget(),
        log: createMockLogger(),
      } } as never);

      const result = await fresh.markFailed(1);

      expect(result).toEqual({ success: true });
      expect(blacklistService.create).toHaveBeenCalled();
      expect(bookService.updateStatus).toHaveBeenCalledWith(42, 'wanted');
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 1,
          error: expect.objectContaining({ message: expect.stringContaining('UNIQUE') }),
        }),
        'Mark-failed blacklist creation failed — proceeding with book revert',
      );
      await vi.waitFor(() => {
        expect(mockSearchAll).toHaveBeenCalled();
      });
    });

    it('logs canonical serialized warning when retrySearch promise itself rejects', async () => {
      const event = createMockDbBookEvent({ downloadId: 5, bookId: 42 });
      const download = { id: 5, infoHash: 'abc123', title: 'Test' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      vi.mocked(retrySearch).mockRejectedValueOnce(new Error('retry search exploded'));

      const { RetryBudget } = await import('./retry-budget.js');
      const fresh = freshService();
      fresh.wire({ retrySearchDeps: {
        indexerSearchService: { searchAllWithStatus: vi.fn() },
        downloadService: { grab: vi.fn() },
        blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()), getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) },
        bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Test', duration: 3600, path: null, author: { name: 'Author' } }) },
        settingsService: createMockSettingsService(),
        retryBudget: new RetryBudget(),
        log: createMockLogger(),
      } } as never);

      const result = await fresh.markFailed(1);
      expect(result).toEqual({ success: true });

      await vi.waitFor(() => {
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.objectContaining({ message: 'retry search exploded', type: 'Error' }) }),
          'Mark-as-failed retry search failed',
        );
      });
    });

    it('imported-book retry guard — no indexer search, no grab, budget unchanged', async () => {
      const event = createMockDbBookEvent({ downloadId: 5, bookId: 42 });
      const download = { id: 5, infoHash: 'abc123', title: 'Imported Book' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      const { RetryBudget } = await import('./retry-budget.js');
      const retryBudget = new RetryBudget();
      const mockSearchAll = mockSearchAllWithStatus([]);
      const mockGrab = vi.fn();

      const fresh = freshService();
      fresh.wire({ retrySearchDeps: {
        indexerSearchService: { searchAllWithStatus: mockSearchAll },
        downloadOrchestrator: { grab: mockGrab, grabForRetry: mockGrab, hasGrabBlocker: vi.fn().mockResolvedValue(false) },
        downloadService: { grab: vi.fn() },
        blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()), getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) },
        bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Imported Book', duration: 3600, path: '/library/imported-book', author: { name: 'Author' } }) },
        settingsService: createMockSettingsService(),
        retryBudget,
        log: createMockLogger(),
      } } as never);

      const budgetBefore = retryBudget.hasRemaining(42);
      const result = await fresh.markFailed(1);
      expect(result).toEqual({ success: true });

      // Drain the fire-and-forget retry.
      await new Promise((r) => setTimeout(r, 0));

      expect(mockSearchAll).not.toHaveBeenCalled();
      expect(mockGrab).not.toHaveBeenCalled();
      expect(retryBudget.hasRemaining(42)).toBe(budgetBefore);
    });
  });

  describe('pruneOlderThan', () => {
    it('deletes events older than retention period and returns count', async () => {
      const oldEvents = [
        createMockDbBookEvent({ id: 1 }),
        createMockDbBookEvent({ id: 2 }),
        createMockDbBookEvent({ id: 3 }),
      ];
      db.delete.mockReturnValue(mockDbChain(oldEvents));

      const result = await service.pruneOlderThan(90);

      expect(result).toBe(3);
      expect(db.delete).toHaveBeenCalled();
    });

    it('returns 0 when no events qualify for pruning', async () => {
      db.delete.mockReturnValue(mockDbChain([]));

      const result = await service.pruneOlderThan(90);

      expect(result).toBe(0);
    });

    it('prunes orphaned events (bookId = null) by age', async () => {
      const orphanedEvent = createMockDbBookEvent({ id: 1, bookId: null });
      db.delete.mockReturnValue(mockDbChain([orphanedEvent]));

      const result = await service.pruneOlderThan(90);

      expect(result).toBe(1);
      expect(db.delete).toHaveBeenCalled();
    });

    it('uses lt (strictly older than) with a Date cutoff derived from retention days', async () => {
      const chain = mockDbChain([]);
      db.delete.mockReturnValue(chain);

      const fakeNow = new Date('2026-03-10T00:00:00Z').getTime();
      vi.useFakeTimers({ toFake: ['Date'], now: fakeNow });

      try {
        await service.pruneOlderThan(30);
      } finally {
        vi.useRealTimers();
      }

      const whereFn = chain.where as ReturnType<typeof vi.fn>;
      expect(whereFn).toHaveBeenCalledTimes(1);

      // Drizzle stores the operator at chunk 2 and bound cutoff at chunk 3.
      const predicate = whereFn.mock.calls[0]![0];
      const chunks = predicate.queryChunks;

      const operatorChunk = chunks[2];
      expect(operatorChunk.value[0]).toBe(' < ');

      const paramChunk = chunks[3];
      expect(paramChunk.value).toBeInstanceOf(Date);

      const expectedCutoff = new Date(fakeNow - 30 * 86_400_000);
      expect(paramChunk.value.getTime()).toBe(expectedCutoff.getTime());
    });
  });

  describe('delete', () => {
    it('deletes event by id and returns true', async () => {
      db.select.mockReturnValue(mockDbChain([createMockDbBookEvent()]));
      db.delete.mockReturnValue(mockDbChain([createMockDbBookEvent()]));

      const result = await service.delete(1);

      expect(result).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });

    it('returns false when event does not exist', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.delete(999);

      expect(result).toBe(false);
      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe('deleteAll', () => {
    it('deletes all events and returns count when no filter', async () => {
      const chain = mockDbChain([
        createMockDbBookEvent({ id: 1 }),
        createMockDbBookEvent({ id: 2 }),
        createMockDbBookEvent({ id: 3 }),
      ]);
      db.delete.mockReturnValue(chain);

      const result = await service.deleteAll();

      expect(result).toBe(3);
      expect(db.delete).toHaveBeenCalled();
      const whereFn = chain.where as ReturnType<typeof vi.fn>;
      expect(whereFn).toHaveBeenCalledWith(undefined);
    });

    it('deletes only matching events when eventType filter provided', async () => {
      const chain = mockDbChain([
        createMockDbBookEvent({ id: 1, eventType: 'download_failed' }),
      ]);
      db.delete.mockReturnValue(chain);

      const result = await service.deleteAll({ eventType: ['download_failed'] });

      expect(result).toBe(1);
      expect(db.delete).toHaveBeenCalled();

      const whereFn = chain.where as ReturnType<typeof vi.fn>;
      expect(whereFn).toHaveBeenCalledTimes(1);
      const predicate = whereFn.mock.calls[0]![0];
      const chunks = predicate.queryChunks;
      const operatorChunk = chunks[2];
      expect(operatorChunk.value[0]).toBe(' = ');
      const paramChunk = chunks[3];
      expect(paramChunk.value).toBe('download_failed');
    });

    it('returns 0 when no matching events', async () => {
      db.delete.mockReturnValue(mockDbChain([]));

      const result = await service.deleteAll({ eventType: ['download_failed'] });

      expect(result).toBe(0);
    });
  });

  describe('getAll — multi-type eventTypes filter', () => {
    it('filters by single-element eventTypes array using eq()', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([createMockDbBookEvent({ eventType: 'grabbed' })]));

      const result = await service.getAll({ eventType: ['grabbed'] });
      expect(result.data).toHaveLength(1);

      const whereFn = db.select.mock.results[1]!.value.from.mock.results[0].value.where as ReturnType<typeof vi.fn>;
      const predicate = whereFn.mock.calls[0]![0];
      const operatorChunk = predicate.queryChunks[2];
      expect(operatorChunk.value[0]).toBe(' = ');
    });

    it('filters by multi-element eventTypes array using inArray()', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 2 }]))
        .mockReturnValueOnce(mockDbChain([
          createMockDbBookEvent({ eventType: 'download_failed' }),
          createMockDbBookEvent({ id: 2, eventType: 'import_failed' }),
        ]));

      const result = await service.getAll({ eventType: ['download_failed', 'import_failed'] });
      expect(result.data).toHaveLength(2);

      const whereFn = db.select.mock.results[1]!.value.from.mock.results[0].value.where as ReturnType<typeof vi.fn>;
      const predicate = whereFn.mock.calls[0]![0];
      const operatorChunk = predicate.queryChunks[2];
      expect(operatorChunk.value[0]).toBe(' in ');
    });

    it('combines multi-type eventTypes filter with search filter', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([createMockDbBookEvent()]));

      const result = await service.getAll({ eventType: ['download_failed', 'import_failed'], search: 'Kings' });
      expect(result.data).toHaveLength(1);
    });

    it('returns correct total count with multi-type filter', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 5 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll({ eventType: ['download_failed', 'import_failed'] });
      expect(result.total).toBe(5);
    });
  });

  describe('deleteAll — multi-type eventTypes filter', () => {
    it('deletes matching events with single-element eventTypes array using eq()', async () => {
      const chain = mockDbChain([createMockDbBookEvent({ eventType: 'download_failed' })]);
      db.delete.mockReturnValue(chain);

      const result = await service.deleteAll({ eventType: ['download_failed'] });
      expect(result).toBe(1);

      const whereFn = chain.where as ReturnType<typeof vi.fn>;
      const predicate = whereFn.mock.calls[0]![0];
      const operatorChunk = predicate.queryChunks[2];
      expect(operatorChunk.value[0]).toBe(' = ');
    });

    it('deletes matching events with multi-element eventTypes array using inArray()', async () => {
      const chain = mockDbChain([
        createMockDbBookEvent({ eventType: 'download_failed' }),
        createMockDbBookEvent({ id: 2, eventType: 'import_failed' }),
      ]);
      db.delete.mockReturnValue(chain);

      const result = await service.deleteAll({ eventType: ['download_failed', 'import_failed'] });
      expect(result).toBe(2);

      const whereFn = chain.where as ReturnType<typeof vi.fn>;
      const predicate = whereFn.mock.calls[0]![0];
      const operatorChunk = predicate.queryChunks[2];
      expect(operatorChunk.value[0]).toBe(' in ');
    });

    it('returns correct count when deleting multiple types', async () => {
      const chain = mockDbChain([
        createMockDbBookEvent({ id: 1 }),
        createMockDbBookEvent({ id: 2 }),
        createMockDbBookEvent({ id: 3 }),
      ]);
      db.delete.mockReturnValue(chain);

      const result = await service.deleteAll({ eventType: ['download_failed', 'import_failed', 'merge_failed'] });
      expect(result).toBe(3);
    });
  });

  describe('deleted book history', () => {
    it('returns events with null bookId and snapshotted title', async () => {
      const event = createMockDbBookEvent({
        bookId: null,
        bookTitle: 'Deleted Book',
        authorName: 'Gone Author',
      });
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([event]));

      const result = await service.getAll({ search: 'Deleted' });
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.bookTitle).toBe('Deleted Book');
      expect(result.data[0]!.bookId).toBeNull();
    });
  });
});

describe('EventHistoryService — narrator snapshot (#71)', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let service: EventHistoryService;

  beforeEach(() => {
    db = createMockDb();
    log = createMockLogger();
    service = new EventHistoryService(
      inject<Db>(db),
      inject<FastifyBaseLogger>(log),
      inject<BlacklistService>({ create: vi.fn() }),
      inject<BookService>({ updateStatus: vi.fn() }),
    );
  });

  it('create() with narratorName persists to book_events.narrator_name', async () => {
    const mockEvent = createMockDbBookEvent({ narratorName: 'Michael Kramer' });
    const chain = mockDbChain([mockEvent]);
    db.insert.mockReturnValue(chain);

    await service.create({
      bookId: 1,
      bookTitle: 'The Way of Kings',
      authorName: 'Brandon Sanderson',
      narratorName: 'Michael Kramer',
      eventType: 'imported',
      source: 'auto',
    });

    expect((chain.values as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({
      narratorName: 'Michael Kramer',
    }));
  });

  it('create() with narratorName omitted → stored as null', async () => {
    const mockEvent = createMockDbBookEvent({ narratorName: null });
    const chain = mockDbChain([mockEvent]);
    db.insert.mockReturnValue(chain);

    await service.create({
      bookId: 1,
      bookTitle: 'The Way of Kings',
      authorName: 'Brandon Sanderson',
      eventType: 'imported',
      source: 'auto',
    });

    expect((chain.values as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({
      narratorName: null,
    }));
  });
});
