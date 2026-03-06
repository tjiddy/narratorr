import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Db } from '@narratorr/db';
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
    it('returns all events ordered by createdAt desc', async () => {
      const events = [createMockDbBookEvent({ id: 2 }), createMockDbBookEvent({ id: 1 })];
      db.select.mockReturnValue(mockDbChain(events));

      const result = await service.getAll();
      expect(result).toHaveLength(2);
    });

    it('filters by event type', async () => {
      db.select.mockReturnValue(mockDbChain([createMockDbBookEvent()]));

      const result = await service.getAll({ eventType: 'grabbed' });
      expect(result).toHaveLength(1);
    });

    it('filters by title search', async () => {
      db.select.mockReturnValue(mockDbChain([createMockDbBookEvent()]));

      const result = await service.getAll({ search: 'Kings' });
      expect(result).toHaveLength(1);
    });

    it('filters by both event type and search', async () => {
      db.select.mockReturnValue(mockDbChain([createMockDbBookEvent()]));

      const result = await service.getAll({ eventType: 'grabbed', search: 'Kings' });
      expect(result).toHaveLength(1);
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

    it('throws when download has no info hash', async () => {
      const event = createMockDbBookEvent({ downloadId: 5 });
      const download = { id: 5, infoHash: null, title: 'Test' };

      db.select
        .mockReturnValueOnce(mockDbChain([event]))
        .mockReturnValueOnce(mockDbChain([download]));

      await expect(service.markFailed(1)).rejects.toThrow('no info hash');
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

  describe('deleted book history', () => {
    it('returns events with null bookId and snapshotted title', async () => {
      const event = createMockDbBookEvent({
        bookId: null,
        bookTitle: 'Deleted Book',
        authorName: 'Gone Author',
      });
      db.select.mockReturnValue(mockDbChain([event]));

      const result = await service.getAll({ search: 'Deleted' });
      expect(result).toHaveLength(1);
      expect(result[0].bookTitle).toBe('Deleted Book');
      expect(result[0].bookId).toBeNull();
    });
  });
});
