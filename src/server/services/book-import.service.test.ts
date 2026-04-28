import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { BookImportService } from './book-import.service.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';

describe('BookImportService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: BookImportService;

  beforeEach(() => {
    db = createMockDb();
    service = new BookImportService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  describe('retryImport', () => {
    let nudge: Mock;

    beforeEach(() => {
      nudge = vi.fn();
    });

    it('returns 404 when book is missing', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));

      const result = await service.retryImport(999, nudge);

      expect(result).toEqual({ error: 'Book not found', status: 404 });
      expect(nudge).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns 409 when book.status is already importing', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ id: 1, status: 'importing' }]));

      const result = await service.retryImport(1, nudge);

      expect(result).toEqual({ error: 'Import already in progress', status: 409 });
      expect(nudge).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns 409 when an active processing import_jobs row exists', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }]))
        .mockReturnValueOnce(mockDbChain([{ id: 7 }]));

      const result = await service.retryImport(1, nudge);

      expect(result).toEqual({ error: 'Import already in progress', status: 409 });
      expect(nudge).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns 400 when no failed import job exists', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'wanted' }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.retryImport(1, nudge);

      expect(result).toEqual({ error: 'No failed import job found for this book', status: 400 });
      expect(nudge).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('inserts new pending job preserving metadata, flips book status, nudges, and returns jobId', async () => {
      const failedJob = {
        id: 10,
        bookId: 1,
        type: 'manual',
        status: 'failed',
        metadata: '{"path":"/a","mode":"copy"}',
      };
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([failedJob]));
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValueOnce(mockDbChain([]));

      const result = await service.retryImport(1, nudge);

      expect(result).toEqual({ jobId: 99 });
      expect(db.insert).toHaveBeenCalled();
      const insertCall = db.insert.mock.results[0].value;
      expect(insertCall.values).toHaveBeenCalledWith({
        bookId: 1,
        type: 'manual',
        status: 'pending',
        phase: 'queued',
        metadata: '{"path":"/a","mode":"copy"}',
      });
      expect(db.update).toHaveBeenCalled();
      const updateCall = db.update.mock.results[0].value;
      expect(updateCall.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'importing' }),
      );
      expect(nudge).toHaveBeenCalledTimes(1);
    });

    it('orders failed-job lookup by desc(createdAt) AND desc(id) for deterministic tiebreaking', async () => {
      const failedJobChain = mockDbChain([
        { id: 10, bookId: 1, type: 'manual', metadata: '{}' },
      ]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(failedJobChain);
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValueOnce(mockDbChain([]));

      await service.retryImport(1, nudge);

      expect(failedJobChain.orderBy).toHaveBeenCalledTimes(1);
      expect(failedJobChain.orderBy.mock.calls[0]).toHaveLength(2);
    });
  });

  describe('getRetryAvailability', () => {
    it('returns retryable=false when no failed job exists', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));

      const result = await service.getRetryAvailability(1);

      expect(result).toEqual({ retryable: false });
    });

    it('returns retryable=true with lastFailedJobId when a failed job exists', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ id: 42 }]));

      const result = await service.getRetryAvailability(1);

      expect(result).toEqual({ retryable: true, lastFailedJobId: 42 });
    });
  });

  describe('listImportJobs', () => {
    function makeRow(overrides: { id?: number; status?: string; phaseHistory?: string | null; bookTitle?: string | null; coverUrl?: string | null; author?: string | null } = {}) {
      return {
        job: {
          id: overrides.id ?? 1,
          bookId: 42,
          type: 'manual',
          status: overrides.status ?? 'processing',
          phase: 'copying',
          phaseHistory: overrides.phaseHistory ?? null,
          metadata: '{}',
          lastError: null,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-01'),
          startedAt: null,
          completedAt: null,
        },
        bookTitle: 'bookTitle' in overrides ? overrides.bookTitle : 'Title',
        bookCoverUrl: 'coverUrl' in overrides ? overrides.coverUrl : null,
        primaryAuthorName: 'author' in overrides ? overrides.author : null,
      };
    }

    it('returns DTO-shaped rows with hydrated book title, cover, and author', async () => {
      const orderByChain = mockDbChain([
        makeRow({ bookTitle: 'My Book', coverUrl: '/c.jpg', author: 'Sanderson' }),
      ]);
      db.select.mockReturnValueOnce(orderByChain);

      const rows = await service.listImportJobs();

      expect(rows).toHaveLength(1);
      expect(rows[0].book).toEqual({
        title: 'My Book',
        coverUrl: '/c.jpg',
        primaryAuthorName: 'Sanderson',
      });
    });

    it('parses phaseHistory JSON column into an array', async () => {
      const history = [{ phase: 'analyzing', startedAt: 1000, completedAt: 2000 }];
      db.select.mockReturnValueOnce(
        mockDbChain([makeRow({ phaseHistory: JSON.stringify(history) })]),
      );

      const rows = await service.listImportJobs();

      expect(rows[0].phaseHistory).toEqual(history);
    });

    it('returns empty phaseHistory when column is null', async () => {
      db.select.mockReturnValueOnce(mockDbChain([makeRow({ phaseHistory: null })]));

      const rows = await service.listImportJobs();

      expect(rows[0].phaseHistory).toEqual([]);
    });

    it('falls back to "Unknown" / null when book row is null (orphan job)', async () => {
      db.select.mockReturnValueOnce(
        mockDbChain([makeRow({ bookTitle: null, coverUrl: null, author: null })]),
      );

      const rows = await service.listImportJobs();

      expect(rows[0].book).toEqual({
        title: 'Unknown',
        coverUrl: null,
        primaryAuthorName: null,
      });
    });

    it('returns empty array when no rows match', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));

      const rows = await service.listImportJobs({ status: ['processing'] });

      expect(rows).toEqual([]);
    });

    it('skips status filter when array is empty', async () => {
      const chain = mockDbChain([]);
      db.select.mockReturnValueOnce(chain);

      await service.listImportJobs({ status: [] });

      expect(chain.where).toHaveBeenCalledWith(undefined);
    });

    it('applies status filter when array has values', async () => {
      const chain = mockDbChain([]);
      db.select.mockReturnValueOnce(chain);

      await service.listImportJobs({ status: ['processing', 'failed'] });

      expect(chain.where).toHaveBeenCalledTimes(1);
      expect(chain.where.mock.calls[0][0]).toBeDefined();
    });
  });
});
