import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { desc } from 'drizzle-orm';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { BookImportService } from './book-import.service.js';
import { importJobs } from '@db/schema.js';
import type { Db } from '@db/index.js';
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

      expect(result).toEqual({ error: 'Book not found', code: 'book_not_found', status: 404 });
      expect(nudge).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns 409 when book.status is already importing', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ id: 1, status: 'importing' }]));

      const result = await service.retryImport(1, nudge);

      expect(result).toEqual({ error: 'Import already in progress', code: 'already_importing', status: 409 });
      expect(nudge).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns active-job-exists 409 when an active processing import_jobs row exists', async () => {
      const failedJob = { id: 5, bookId: 1, type: 'manual', metadata: '{}' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }]))
        .mockReturnValueOnce(mockDbChain([failedJob]))
        .mockReturnValueOnce(mockDbChain([{ id: 7 }]));

      const result = await service.retryImport(1, nudge);

      expect(result).toEqual({
        error: 'An import job for this book is already queued or running',
        code: 'active_job_exists',
        status: 409,
      });
      expect(nudge).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns active-job-exists 409 when an active PENDING import_jobs row exists (#747 bug fix)', async () => {
      const failedJob = { id: 5, bookId: 1, type: 'manual', metadata: '{}' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }]))
        .mockReturnValueOnce(mockDbChain([failedJob]))
        .mockReturnValueOnce(mockDbChain([{ id: 9 }]));

      const result = await service.retryImport(1, nudge);

      expect(result).toEqual({
        error: 'An import job for this book is already queued or running',
        code: 'active_job_exists',
        status: 409,
      });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns 400 when no failed import job exists', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'wanted' }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.retryImport(1, nudge);

      expect(result).toEqual({ error: 'No failed import job found for this book', code: 'no_failed_job', status: 400 });
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
        .mockReturnValueOnce(mockDbChain([failedJob]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValueOnce(mockDbChain([]));

      const result = await service.retryImport(1, nudge);

      expect(result).toEqual({ jobId: 99 });
      expect(db.insert).toHaveBeenCalled();
      const insertCall = db.insert.mock.results[0]!.value;
      expect(insertCall.values).toHaveBeenCalledWith({
        bookId: 1,
        type: 'manual',
        status: 'pending',
        phase: 'queued',
        metadata: '{"path":"/a","mode":"copy"}',
      });
      expect(db.update).toHaveBeenCalled();
      const updateCall = db.update.mock.results[0]!.value;
      expect(updateCall.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'importing' }),
      );
      expect(nudge).toHaveBeenCalledTimes(1);
    });

    it('wraps the active-job INSERT and books UPDATE in a single db.transaction (#799 AC1)', async () => {
      // Independent callback assertions protect one transaction wrapping enqueue and the books update.
      const failedJob = { id: 10, bookId: 1, type: 'manual', metadata: '{}' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }]))
        .mockReturnValueOnce(mockDbChain([failedJob]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValueOnce(mockDbChain([]));

      await service.retryImport(1, nudge);

      expect(db.transaction).toHaveBeenCalledTimes(1);
      const txCallback = db.transaction.mock.calls[0]![0] as (tx: typeof db) => Promise<unknown>;
      expect(typeof txCallback).toBe('function');

      // The callback must own both writes on the same transaction handle.
      const txSelect = vi.fn().mockReturnValue(mockDbChain([]));
      const txInsert = vi.fn().mockReturnValue(mockDbChain([{ id: 100 }]));
      const txUpdate = vi.fn().mockReturnValue(mockDbChain([]));
      const txMock = { select: txSelect, insert: txInsert, update: txUpdate };
      const cbResult = await txCallback(txMock as never);
      expect(txInsert).toHaveBeenCalledTimes(1);
      expect(txUpdate).toHaveBeenCalledTimes(1);
      expect(cbResult).toEqual({ jobId: 100 });
    });

    it('nudges AFTER the transaction resolves, never inside it (#799 AC5)', async () => {
      const failedJob = { id: 10, bookId: 1, type: 'manual', metadata: '{}' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }]))
        .mockReturnValueOnce(mockDbChain([failedJob]))
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValueOnce(mockDbChain([]));

      const callOrder: string[] = [];
      db.transaction.mockImplementationOnce(async (cb: (tx: typeof db) => Promise<unknown>) => {
        const r = await cb(db);
        callOrder.push('transaction-done');
        return r;
      });
      nudge.mockImplementation(() => { callOrder.push('nudge'); });

      await service.retryImport(1, nudge);

      expect(callOrder).toEqual(['transaction-done', 'nudge']);
    });

    it('does NOT nudge when the transaction throws (rollback path, #799 AC5)', async () => {
      const failedJob = { id: 10, bookId: 1, type: 'manual', metadata: '{}' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }]))
        .mockReturnValueOnce(mockDbChain([failedJob]));
      db.transaction.mockImplementationOnce(async () => {
        throw new Error('disk write failed');
      });

      await expect(service.retryImport(1, nudge)).rejects.toThrow('disk write failed');
      expect(nudge).not.toHaveBeenCalled();
    });

    it('does NOT nudge when the in-tx pre-check finds an active job (rollback path, #799 AC5)', async () => {
      const failedJob = { id: 10, bookId: 1, type: 'manual', metadata: '{}' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }]))
        .mockReturnValueOnce(mockDbChain([failedJob]))
        .mockReturnValueOnce(mockDbChain([{ id: 7 }]));

      const result = await service.retryImport(1, nudge);

      expect(result).toEqual({
        error: 'An import job for this book is already queued or running',
        code: 'active_job_exists',
        status: 409,
      });
      expect(nudge).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('translates a unique-index violation thrown from enqueue into active-job-exists (TOCTOU, #799 AC3)', async () => {
      const failedJob = { id: 10, bookId: 1, type: 'manual', metadata: '{}' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }]))
        .mockReturnValueOnce(mockDbChain([failedJob]))
        .mockReturnValueOnce(mockDbChain([]));
      const indexErr = Object.assign(new Error('libsql failure'), {
        cause: { message: 'UNIQUE constraint failed: idx_import_jobs_book_active' },
      });
      db.insert.mockReturnValueOnce(mockDbChain([], { error: indexErr }));

      const result = await service.retryImport(1, nudge);

      expect(result).toEqual({
        error: 'An import job for this book is already queued or running',
        code: 'active_job_exists',
        status: 409,
      });
      expect(nudge).not.toHaveBeenCalled();
    });

    it('orders failed-job lookup by desc(createdAt) AND desc(id) for deterministic tiebreaking', async () => {
      const failedJobChain = mockDbChain([
        { id: 10, bookId: 1, type: 'manual', metadata: '{}' },
      ]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }]))
        .mockReturnValueOnce(failedJobChain)
        .mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValueOnce(mockDbChain([]));

      await service.retryImport(1, nudge);

      expect(failedJobChain.orderBy).toHaveBeenCalledTimes(1);
      expect(failedJobChain.orderBy).toHaveBeenCalledWith(
        desc(importJobs.createdAt),
        desc(importJobs.id),
      );
    });
  });

  describe('enqueue', () => {
    it('returns jobId on success when no active row exists', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 77 }]));

      const result = await service.enqueue({
        bookId: 5,
        type: 'auto',
        metadata: '{"downloadId":1}',
      });

      expect(result).toEqual({ jobId: 77 });
      const insertCall = db.insert.mock.results[0]!.value;
      expect(insertCall.values).toHaveBeenCalledWith({
        bookId: 5,
        type: 'auto',
        status: 'pending',
        phase: 'queued',
        metadata: '{"downloadId":1}',
      });
    });

    it('returns active-job-exists when in-tx pre-check finds an active row', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ id: 12 }]));

      const result = await service.enqueue({
        bookId: 5,
        type: 'auto',
        metadata: '{"downloadId":1}',
      });

      expect(result).toEqual({ error: 'active-job-exists', status: 409 });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('catches UNIQUE-constraint backstop matching index-name form and returns 409', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      const indexErr = Object.assign(new Error('libsql failure'), {
        cause: { message: 'UNIQUE constraint failed: idx_import_jobs_book_active' },
      });
      db.insert.mockReturnValueOnce(mockDbChain([], { error: indexErr }));

      const result = await service.enqueue({ bookId: 5, type: 'auto', metadata: '{}' });

      expect(result).toEqual({ error: 'active-job-exists', status: 409 });
    });

    it('catches UNIQUE-constraint backstop matching column-message form and returns 409', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      const colErr = Object.assign(new Error('libsql failure'), {
        cause: { message: 'UNIQUE constraint failed: import_jobs.book_id' },
      });
      db.insert.mockReturnValueOnce(mockDbChain([], { error: colErr }));

      const result = await service.enqueue({ bookId: 5, type: 'auto', metadata: '{}' });

      expect(result).toEqual({ error: 'active-job-exists', status: 409 });
    });

    it('rethrows unrelated errors (does not silently map to active-job-exists)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      const unrelated = new Error('disk I/O error');
      db.insert.mockReturnValueOnce(mockDbChain([], { error: unrelated }));

      await expect(
        service.enqueue({ bookId: 5, type: 'auto', metadata: '{}' }),
      ).rejects.toThrow('disk I/O error');
    });

    it('does NOT classify bare-column book_id violations from other tables as active-job conflicts', async () => {
      // Bare book_id UNIQUE violations can come from unrelated tables and must not become 409s.
      db.select.mockReturnValueOnce(mockDbChain([]));
      const otherTableErr = Object.assign(new Error('libsql failure'), {
        cause: { message: 'UNIQUE constraint failed: book_id' },
      });
      db.insert.mockReturnValueOnce(mockDbChain([], { error: otherTableErr }));

      await expect(
        service.enqueue({ bookId: 5, type: 'auto', metadata: '{}' }),
      ).rejects.toThrow('libsql failure');
    });

    it('wraps active-job pre-check + insert in db.transaction (TOCTOU guard, AC4) (F1)', async () => {
      // Callback assertions protect the atomic pre-check/insert boundary, not merely call order.
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 50 }]));

      const result = await service.enqueue({ bookId: 5, type: 'auto', metadata: '{}' });

      expect(result).toEqual({ jobId: 50 });
      expect(db.transaction).toHaveBeenCalledTimes(1);
      const txCallback = db.transaction.mock.calls[0]![0] as (tx: typeof db) => Promise<unknown>;
      expect(typeof txCallback).toBe('function');

      const txSelect = vi.fn().mockReturnValue(mockDbChain([]));
      const txInsert = vi.fn().mockReturnValue(mockDbChain([{ id: 51 }]));
      const txMock = { select: txSelect, insert: txInsert };
      const cbResult = await txCallback(txMock as never);
      expect(txSelect).toHaveBeenCalledTimes(1);
      expect(txInsert).toHaveBeenCalledTimes(1);
      expect(cbResult).toEqual({ jobId: 51 });
    });

    it('uses the caller-provided tx and does NOT open a nested db.transaction (#799 shape B)', async () => {
      // A caller-provided transaction must own both operations; nesting would break parent atomicity.
      const txSelect = vi.fn().mockReturnValue(mockDbChain([]));
      const txInsert = vi.fn().mockReturnValue(mockDbChain([{ id: 88 }]));
      const txMock = { select: txSelect, insert: txInsert };

      const result = await service.enqueue(
        { bookId: 5, type: 'auto', metadata: '{"downloadId":1}' },
        inject(txMock),
      );

      expect(result).toEqual({ jobId: 88 });
      expect(txSelect).toHaveBeenCalledTimes(1);
      expect(txInsert).toHaveBeenCalledTimes(1);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('propagates errors from the caller-provided tx (parent rolls back, #799 shape B)', async () => {
      // Caller-transaction errors must escape so the parent can roll back; only the own-tx path maps conflicts.
      const txSelect = vi.fn().mockReturnValue(mockDbChain([]));
      const indexErr = Object.assign(new Error('libsql failure'), {
        cause: { message: 'UNIQUE constraint failed: idx_import_jobs_book_active' },
      });
      const txInsert = vi.fn().mockReturnValue(mockDbChain([], { error: indexErr }));
      const txMock = { select: txSelect, insert: txInsert };

      await expect(
        service.enqueue({ bookId: 5, type: 'auto', metadata: '{}' }, inject(txMock)),
      ).rejects.toThrow('libsql failure');
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('skips insert when pre-check inside the transaction finds an active row (TOCTOU guard) (F1)', async () => {
      const txCallback = vi.fn();
      db.transaction.mockImplementationOnce(async (cb: (tx: typeof db) => Promise<unknown>) => {
        txCallback.mockImplementation(cb);
        return cb(db);
      });

      db.select.mockReturnValueOnce(mockDbChain([{ id: 12 }]));

      const result = await service.enqueue({ bookId: 5, type: 'auto', metadata: '{}' });

      expect(result).toEqual({ error: 'active-job-exists', status: 409 });
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(db.insert).not.toHaveBeenCalled();
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
      expect(rows[0]!.book).toEqual({
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

      expect(rows[0]!.phaseHistory).toEqual(history);
    });

    it('returns empty phaseHistory when column is null', async () => {
      db.select.mockReturnValueOnce(mockDbChain([makeRow({ phaseHistory: null })]));

      const rows = await service.listImportJobs();

      expect(rows[0]!.phaseHistory).toEqual([]);
    });

    it('falls back to empty phaseHistory when JSON is unparseable (does not 500)', async () => {
      db.select.mockReturnValueOnce(
        mockDbChain([makeRow({ phaseHistory: 'not-json' })]),
      );

      const rows = await service.listImportJobs();

      expect(rows[0]!.phaseHistory).toEqual([]);
    });

    it('falls back to empty phaseHistory when shape is wrong (does not 500)', async () => {
      db.select.mockReturnValueOnce(
        mockDbChain([makeRow({ phaseHistory: JSON.stringify([{ foo: 'bar' }]) })]),
      );

      const rows = await service.listImportJobs();

      expect(rows[0]!.phaseHistory).toEqual([]);
    });

    it('falls back to "Unknown" / null when book row is null (orphan job)', async () => {
      db.select.mockReturnValueOnce(
        mockDbChain([makeRow({ bookTitle: null, coverUrl: null, author: null })]),
      );

      const rows = await service.listImportJobs();

      expect(rows[0]!.book).toEqual({
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
