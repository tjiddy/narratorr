import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { importJobsRoutes } from './import-jobs.js';

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'info', silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function createMockDb() {
  const chain = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  };
  return {
    db: {
      select: vi.fn().mockReturnValue(chain),
    },
    chain,
  };
}

describe('GET /api/import-jobs', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  async function buildApp(queryResult: unknown[]) {
    mockDb.chain.orderBy = vi.fn().mockResolvedValue(queryResult);
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await importJobsRoutes(app, inject<Db>(mockDb.db));
    return app;
  }

  it('returns import jobs with book title and coverUrl', async () => {
    const app = await buildApp([{
      job: {
        id: 1, bookId: 42, type: 'manual', status: 'processing', phase: 'copying',
        phaseHistory: JSON.stringify([{ phase: 'analyzing', startedAt: 1000, completedAt: 2000 }]),
        metadata: '{}', lastError: null,
        createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-01'),
        startedAt: new Date('2025-01-01'), completedAt: null,
      },
      bookTitle: 'My Book',
      bookCoverUrl: '/covers/42.jpg',
      primaryAuthorName: 'Author Name',
    }]);

    const res = await app.inject({ method: 'GET', url: '/api/import-jobs' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].book.title).toBe('My Book');
    expect(body[0].book.coverUrl).toBe('/covers/42.jpg');
  });

  it('returns primaryAuthorName hydrated via bookAuthors + authors join', async () => {
    const app = await buildApp([{
      job: {
        id: 1, bookId: 42, type: 'manual', status: 'processing', phase: 'copying',
        phaseHistory: null, metadata: '{}', lastError: null,
        createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-01'),
        startedAt: null, completedAt: null,
      },
      bookTitle: 'My Book',
      bookCoverUrl: null,
      primaryAuthorName: 'Brandon Sanderson',
    }]);

    const res = await app.inject({ method: 'GET', url: '/api/import-jobs' });
    const body = JSON.parse(res.body);
    expect(body[0].book.primaryAuthorName).toBe('Brandon Sanderson');
  });

  it('returns parsed phaseHistory array from JSON column', async () => {
    const history = [{ phase: 'analyzing', startedAt: 1000, completedAt: 2000 }, { phase: 'copying', startedAt: 2000 }];
    const app = await buildApp([{
      job: {
        id: 1, bookId: 42, type: 'manual', status: 'processing', phase: 'copying',
        phaseHistory: JSON.stringify(history), metadata: '{}', lastError: null,
        createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-01'),
        startedAt: null, completedAt: null,
      },
      bookTitle: 'Test',
      bookCoverUrl: null,
      primaryAuthorName: null,
    }]);

    const res = await app.inject({ method: 'GET', url: '/api/import-jobs' });
    const body = JSON.parse(res.body);
    expect(body[0].phaseHistory).toEqual(history);
  });

  it('returns empty array when no import jobs exist', async () => {
    const app = await buildApp([]);

    const res = await app.inject({ method: 'GET', url: '/api/import-jobs' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('filters by status query param', async () => {
    const app = await buildApp([]);

    await app.inject({ method: 'GET', url: '/api/import-jobs?status=processing' });

    // Verify where clause was called (the mock chain captures the call)
    expect(mockDb.chain.where).toHaveBeenCalled();
  });

  it('returns job with no author (null primaryAuthorName)', async () => {
    const app = await buildApp([{
      job: {
        id: 1, bookId: 42, type: 'manual', status: 'pending', phase: 'queued',
        phaseHistory: null, metadata: '{}', lastError: null,
        createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-01'),
        startedAt: null, completedAt: null,
      },
      bookTitle: 'Orphan Book',
      bookCoverUrl: null,
      primaryAuthorName: null,
    }]);

    const res = await app.inject({ method: 'GET', url: '/api/import-jobs' });
    const body = JSON.parse(res.body);
    expect(body[0].book.primaryAuthorName).toBeNull();
  });
});
