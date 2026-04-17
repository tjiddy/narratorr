import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { inject } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import type { ImportQueueWorker } from '../services/import-queue-worker.js';
import { retryImportRoute } from './retry-import.js';

function createApp(db: Db, worker: ImportQueueWorker) {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app.register(async (scoped) => {
    await retryImportRoute(scoped as unknown as typeof app, db, worker);
  });
}

describe('POST /api/books/:id/retry-import', () => {
  let mockWorker: { nudge: ReturnType<typeof vi.fn> };
  let selectResults: Map<number, unknown[]>;

  // Helper to build a mock DB with configurable select results
  function buildMockDb(opts: {
    book?: { id: number; status: string } | null;
    activeJob?: { id: number } | null;
    failedJob?: Record<string, unknown> | null;
    insertReturning?: { id: number };
  }) {
    let selectCallCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        const results = selectCallCount === 1
          ? (opts.book ? [opts.book] : [])
          : selectCallCount === 2
            ? (opts.activeJob ? [opts.activeJob] : [])
            : (opts.failedJob ? [opts.failedJob] : []);
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(results),
        };
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([opts.insertReturning ?? { id: 99 }]),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        }),
      }),
    };
    return db;
  }

  beforeEach(() => {
    mockWorker = { nudge: vi.fn() };
  });

  it('inserts new pending import_jobs row with same metadata when book has failed import job', async () => {
    const db = buildMockDb({
      book: { id: 1, status: 'failed' },
      activeJob: null,
      failedJob: { id: 10, bookId: 1, type: 'manual', metadata: '{"title":"Test","path":"/a","mode":"copy"}' },
      insertReturning: { id: 20 },
    });
    const app = await createApp(inject<Db>(db), inject<ImportQueueWorker>(mockWorker));

    const res = await app.inject({ method: 'POST', url: '/api/books/1/retry-import' });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.payload)).toEqual({ jobId: 20 });
    expect(db.insert).toHaveBeenCalled();
  });

  it('nudges import queue worker', async () => {
    const db = buildMockDb({
      book: { id: 1, status: 'failed' },
      failedJob: { id: 10, bookId: 1, type: 'manual', metadata: '{}' },
    });
    const app = await createApp(inject<Db>(db), inject<ImportQueueWorker>(mockWorker));

    await app.inject({ method: 'POST', url: '/api/books/1/retry-import' });

    expect(mockWorker.nudge).toHaveBeenCalledTimes(1);
  });

  it('sets books.status to importing', async () => {
    const db = buildMockDb({
      book: { id: 1, status: 'failed' },
      failedJob: { id: 10, bookId: 1, type: 'manual', metadata: '{}' },
    });
    const app = await createApp(inject<Db>(db), inject<ImportQueueWorker>(mockWorker));

    await app.inject({ method: 'POST', url: '/api/books/1/retry-import' });

    expect(db.update).toHaveBeenCalled();
  });

  it('returns 400 when no failed import job exists for the book', async () => {
    const db = buildMockDb({
      book: { id: 1, status: 'imported' },
      failedJob: null,
    });
    const app = await createApp(inject<Db>(db), inject<ImportQueueWorker>(mockWorker));

    const res = await app.inject({ method: 'POST', url: '/api/books/1/retry-import' });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ error: 'No failed import job found for this book' });
  });

  it('returns 409 when book is already importing', async () => {
    const db = buildMockDb({
      book: { id: 1, status: 'importing' },
    });
    const app = await createApp(inject<Db>(db), inject<ImportQueueWorker>(mockWorker));

    const res = await app.inject({ method: 'POST', url: '/api/books/1/retry-import' });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Import already in progress' });
  });

  it('returns 409 when active processing job exists', async () => {
    const db = buildMockDb({
      book: { id: 1, status: 'failed' },
      activeJob: { id: 5 },
    });
    const app = await createApp(inject<Db>(db), inject<ImportQueueWorker>(mockWorker));

    const res = await app.inject({ method: 'POST', url: '/api/books/1/retry-import' });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Import already in progress' });
  });

  it('returns 404 when book does not exist', async () => {
    const db = buildMockDb({ book: null });
    const app = await createApp(inject<Db>(db), inject<ImportQueueWorker>(mockWorker));

    const res = await app.inject({ method: 'POST', url: '/api/books/999/retry-import' });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Book not found' });
  });
});
