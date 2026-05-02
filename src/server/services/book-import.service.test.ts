import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { desc } from 'drizzle-orm';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { BookImportService } from './book-import.service.js';
import { importJobs } from '../../db/schema.js';
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

    it('returns active-job-exists 409 when an active processing import_jobs row exists', async () => {
      const failedJob = { id: 5, bookId: 1, type: 'manual', metadata: '{}' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }])) // book lookup
        .mockReturnValueOnce(mockDbChain([failedJob]))                    // failed-job lookup
        .mockReturnValueOnce(mockDbChain([{ id: 7 }]));                   // in-tx active-job pre-check

      const result = await service.retryImport(1, nudge);

      expect(result).toEqual({ error: 'active-job-exists', status: 409 });
      expect(nudge).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns active-job-exists 409 when an active PENDING import_jobs row exists (#747 bug fix)', async () => {
      // Pre-fix code only checked 'processing' — this test asserts that an
      // already-queued retry (status='pending') is now correctly detected.
      const failedJob = { id: 5, bookId: 1, type: 'manual', metadata: '{}' };
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }]))
        .mockReturnValueOnce(mockDbChain([failedJob]))
        .mockReturnValueOnce(mockDbChain([{ id: 9 }])); // pending active job present

      const result = await service.retryImport(1, nudge);

      expect(result).toEqual({ error: 'active-job-exists', status: 409 });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('returns 400 when no failed import job exists', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'wanted' }]))
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
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }])) // book
        .mockReturnValueOnce(mockDbChain([failedJob]))                    // failed
        .mockReturnValueOnce(mockDbChain([]));                            // in-tx active
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

    it('orders failed-job lookup by desc(createdAt) AND desc(id) for deterministic tiebreaking', async () => {
      const failedJobChain = mockDbChain([
        { id: 10, bookId: 1, type: 'manual', metadata: '{}' },
      ]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ id: 1, status: 'failed' }])) // book
        .mockReturnValueOnce(failedJobChain)                              // failed
        .mockReturnValueOnce(mockDbChain([]));                            // in-tx active
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
      db.select.mockReturnValueOnce(mockDbChain([])); // in-tx pre-check
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
      db.select.mockReturnValueOnce(mockDbChain([{ id: 12 }])); // active row found

      const result = await service.enqueue({
        bookId: 5,
        type: 'auto',
        metadata: '{"downloadId":1}',
      });

      expect(result).toEqual({ error: 'active-job-exists', status: 409 });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('catches UNIQUE-constraint backstop matching index-name form and returns 409', async () => {
      db.select.mockReturnValueOnce(mockDbChain([])); // pre-check sees no row (TOCTOU window)
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
      // A UNIQUE violation surfaced from another table that happens to have a
      // `book_id` column (e.g. book_authors, book_narrators, blacklist) must
      // propagate as a 500-class error, not be swallowed as 409 active-job.
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
      // Independent of select/insert assertions — this test specifically
      // protects the transaction boundary. If a refactor removed
      // `this.db.transaction(...)` and inlined the same select/insert calls,
      // the other enqueue tests would still pass; this one would fail.
      db.select.mockReturnValueOnce(mockDbChain([])); // in-tx pre-check
      db.insert.mockReturnValueOnce(mockDbChain([{ id: 50 }]));

      const result = await service.enqueue({ bookId: 5, type: 'auto', metadata: '{}' });

      expect(result).toEqual({ jobId: 50 });
      // The transaction MUST be invoked exactly once and its callback MUST
      // own the select+insert pair so the active-job check and the insert
      // share a single atomic visibility window.
      expect(db.transaction).toHaveBeenCalledTimes(1);
      const txCallback = db.transaction.mock.calls[0]![0] as (tx: typeof db) => Promise<unknown>;
      expect(typeof txCallback).toBe('function');

      // Verify the callback semantics: invoking it with a fresh tx-shaped mock
      // routes BOTH the select pre-check AND the insert to that same handle —
      // proving the two reads/writes are inside the same transaction context.
      const txSelect = vi.fn().mockReturnValue(mockDbChain([]));
      const txInsert = vi.fn().mockReturnValue(mockDbChain([{ id: 51 }]));
      const txMock = { select: txSelect, insert: txInsert };
      const cbResult = await txCallback(txMock as never);
      expect(txSelect).toHaveBeenCalledTimes(1); // active-job pre-check on tx handle
      expect(txInsert).toHaveBeenCalledTimes(1); // insert on tx handle
      expect(cbResult).toEqual({ jobId: 51 });
    });

    it('skips insert when pre-check inside the transaction finds an active row (TOCTOU guard) (F1)', async () => {
      // Companion to the boundary test above — verifies the in-tx pre-check
      // result short-circuits the insert call so a duplicate is never even
      // attempted. Together with the boundary test, these protect the AC4
      // contract: the check and the insert must atomically agree.
      const txCallback = vi.fn();
      db.transaction.mockImplementationOnce(async (cb: (tx: typeof db) => Promise<unknown>) => {
        txCallback.mockImplementation(cb);
        return cb(db);
      });

      db.select.mockReturnValueOnce(mockDbChain([{ id: 12 }])); // active row exists in-tx

      const result = await service.enqueue({ bookId: 5, type: 'auto', metadata: '{}' });

      expect(result).toEqual({ error: 'active-job-exists', status: 409 });
      expect(db.transaction).toHaveBeenCalledTimes(1);
      // Critical: insert never even attempted when pre-check sees an active row.
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
