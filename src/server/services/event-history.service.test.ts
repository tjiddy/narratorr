import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbBookEvent } from '../__tests__/factories.js';
import { EventHistoryService } from './event-history.service.js';
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
      // First call: count query, second call: data query
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

      const result = await service.getAll({ eventType: 'grabbed' });
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

      const result = await service.getAll({ eventType: 'grabbed', search: 'Kings' });
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

      const result = await service.getAll({ eventType: 'grabbed' }, { limit: 10, offset: 0 });
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
      // Should have two sort columns (createdAt DESC, id DESC)
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
    it('blacklists release and reverts book to wanted', async () => {
      const event = createMockDbBookEvent({ downloadId: 5 });
      const download = { id: 5, infoHash: 'abc123', title: 'The Way of Kings [MP3]' };

      // First select: getById for the event
      // Second select: download lookup
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

    it('throws when event not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      await expect(service.markFailed(999)).rejects.toThrow('Event not found');
    });

    it('throws on non-actionable event type', async () => {
      const event = createMockDbBookEvent({ eventType: 'deleted' });
      db.select.mockReturnValue(mockDbChain([event]));

      await expect(service.markFailed(1)).rejects.toThrow("does not support mark-as-failed");
    });

    it('throws when event has no download_id', async () => {
      const event = createMockDbBookEvent({ downloadId: null });
      db.select.mockReturnValue(mockDbChain([event]));

      await expect(service.markFailed(1)).rejects.toThrow('no associated download');
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

    it('throws when download not found', async () => {
      const event = createMockDbBookEvent({ downloadId: 5 });
      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([]));

      await expect(service.markFailed(1)).rejects.toThrow('Associated download not found');
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
  });

  describe('markFailed search trigger', () => {
    it('triggers book-scoped retry search when retrySearchDeps are set', async () => {
      const event = createMockDbBookEvent({ downloadId: 5, bookId: 42 });
      const download = { id: 5, infoHash: 'abc123', title: 'Test' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      const { RetryBudget } = await import('./retry-budget.js');
      const mockSearchAll = vi.fn().mockResolvedValue([]);
      service.setRetrySearchDeps({
        indexerService: { searchAll: mockSearchAll },
        downloadService: { grab: vi.fn() },
        blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()) },
        bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Test', duration: 3600, author: { name: 'Author' } }) },
        settingsService: { get: vi.fn().mockResolvedValue({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: '', requiredWords: '' }) },
        retryBudget: new RetryBudget(),
        log: createMockLogger(),
      } as never);

      const result = await service.markFailed(1);

      expect(result).toEqual({ success: true });
      // Verify the retry search was actually triggered (fire-and-forget)
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

      // Set retrySearchDeps that will cause retrySearch to fail
      const { RetryBudget } = await import('./retry-budget.js');
      const mockSearchAll = vi.fn().mockRejectedValue(new Error('Indexer down'));
      service.setRetrySearchDeps({
        indexerService: { searchAll: mockSearchAll },
        downloadService: { grab: vi.fn() },
        blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()) },
        bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Test', duration: 3600, author: { name: 'Author' } }) },
        settingsService: { get: vi.fn().mockResolvedValue({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: '', requiredWords: '' }) },
        retryBudget: new RetryBudget(),
        log: createMockLogger(),
      } as never);

      // markFailed should succeed — search failure is caught inside retrySearch (returns retry_error)
      const result = await service.markFailed(1);
      expect(result).toEqual({ success: true });
      // Verify the search was attempted even though it failed
      await vi.waitFor(() => {
        expect(mockSearchAll).toHaveBeenCalled();
      });
    });

    it('does not trigger search when no retrySearchDeps', async () => {
      const event = createMockDbBookEvent({ downloadId: 5, bookId: 42 });
      const download = { id: 5, infoHash: 'abc123', title: 'Test' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      // No retrySearchDeps set on service — should succeed without triggering search
      const result = await service.markFailed(1);
      expect(result).toEqual({ success: true });
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
      vi.useFakeTimers({ now: fakeNow });

      try {
        await service.pruneOlderThan(30);
      } finally {
        vi.useRealTimers();
      }

      // Verify where was called with a predicate
      const whereFn = chain.where as ReturnType<typeof vi.fn>;
      expect(whereFn).toHaveBeenCalledTimes(1);

      // The predicate passed to where() is lt(bookEvents.createdAt, cutoff)
      // Drizzle comparison operators produce SQL objects with queryChunks:
      //   [StringChunk(''), Column, StringChunk(' < '), Param(value), StringChunk('')]
      const predicate = whereFn.mock.calls[0][0];
      const chunks = predicate.queryChunks;

      // Must use strict less-than (lt), not less-than-or-equal (lte)
      const operatorChunk = chunks[2];
      expect(operatorChunk.value[0]).toBe(' < ');

      // The right-hand value should be a Date (matching Drizzle { mode: 'timestamp' } contract)
      // Drizzle wraps the value in a Param — extract it
      const paramChunk = chunks[3];
      expect(paramChunk.value).toBeInstanceOf(Date);

      // Cutoff should be Date(2026-03-10 - 30 days) = 2026-02-08T00:00:00Z
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
      // Without a filter, where() should receive undefined (no predicate)
      const whereFn = chain.where as ReturnType<typeof vi.fn>;
      expect(whereFn).toHaveBeenCalledWith(undefined);
    });

    it('deletes only matching events when eventType filter provided', async () => {
      const chain = mockDbChain([
        createMockDbBookEvent({ id: 1, eventType: 'download_failed' }),
      ]);
      db.delete.mockReturnValue(chain);

      const result = await service.deleteAll({ eventType: 'download_failed' });

      expect(result).toBe(1);
      expect(db.delete).toHaveBeenCalled();

      // Verify the where predicate targets bookEvents.eventType with eq()
      const whereFn = chain.where as ReturnType<typeof vi.fn>;
      expect(whereFn).toHaveBeenCalledTimes(1);
      const predicate = whereFn.mock.calls[0][0];
      const chunks = predicate.queryChunks;
      // Drizzle eq() produces: [StringChunk(''), Column, StringChunk(' = '), Param(value), StringChunk('')]
      const operatorChunk = chunks[2];
      expect(operatorChunk.value[0]).toBe(' = ');
      const paramChunk = chunks[3];
      expect(paramChunk.value).toBe('download_failed');
    });

    it('returns 0 when no matching events', async () => {
      db.delete.mockReturnValue(mockDbChain([]));

      const result = await service.deleteAll({ eventType: 'download_failed' });

      expect(result).toBe(0);
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
      expect(result.data[0].bookTitle).toBe('Deleted Book');
      expect(result.data[0].bookId).toBeNull();
    });
  });
});
