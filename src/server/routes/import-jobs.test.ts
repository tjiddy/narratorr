import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { BookService, ImportJobListing } from '../services/book.service.js';
import { importJobsRoutes } from './import-jobs.js';

interface MockBookService {
  listImportJobs: ReturnType<typeof vi.fn>;
}

async function createApp(bookService: MockBookService) {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const { errorHandlerPlugin } = await import('../plugins/error-handler.js');
  await app.register(errorHandlerPlugin);
  await importJobsRoutes(app, inject<BookService>(bookService));
  return app;
}

const baseListing: ImportJobListing = {
  id: 1,
  bookId: 42,
  type: 'manual',
  status: 'processing',
  phase: 'copying',
  phaseHistory: [{ phase: 'analyzing', startedAt: 1000, completedAt: 2000 }],
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  startedAt: new Date('2025-01-01'),
  completedAt: null,
  book: {
    title: 'My Book',
    coverUrl: '/covers/42.jpg',
    primaryAuthorName: 'Brandon Sanderson',
  },
};

describe('GET /api/import-jobs', () => {
  let bookService: MockBookService;

  beforeEach(() => {
    bookService = { listImportJobs: vi.fn() };
  });

  it('returns the service result unchanged', async () => {
    bookService.listImportJobs.mockResolvedValueOnce([baseListing]);
    const app = await createApp(bookService);

    const res = await app.inject({ method: 'GET', url: '/api/import-jobs' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ImportJobListing[];
    expect(body).toHaveLength(1);
    expect(body[0].book.title).toBe('My Book');
    expect(body[0].book.coverUrl).toBe('/covers/42.jpg');
    expect(body[0].book.primaryAuthorName).toBe('Brandon Sanderson');
    expect(body[0].phaseHistory).toEqual([{ phase: 'analyzing', startedAt: 1000, completedAt: 2000 }]);
    expect(bookService.listImportJobs).toHaveBeenCalledWith({ status: undefined });
  });

  it('returns empty array when service returns no rows', async () => {
    bookService.listImportJobs.mockResolvedValueOnce([]);
    const app = await createApp(bookService);

    const res = await app.inject({ method: 'GET', url: '/api/import-jobs' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('parses single status into typed array', async () => {
    bookService.listImportJobs.mockResolvedValueOnce([]);
    const app = await createApp(bookService);

    await app.inject({ method: 'GET', url: '/api/import-jobs?status=processing' });

    expect(bookService.listImportJobs).toHaveBeenCalledWith({ status: ['processing'] });
  });

  it('parses comma-separated statuses into typed array', async () => {
    bookService.listImportJobs.mockResolvedValueOnce([]);
    const app = await createApp(bookService);

    await app.inject({ method: 'GET', url: '/api/import-jobs?status=processing,failed' });

    expect(bookService.listImportJobs).toHaveBeenCalledWith({ status: ['processing', 'failed'] });
  });

  it('returns 400 when status contains an invalid value', async () => {
    bookService.listImportJobs.mockResolvedValueOnce([]);
    const app = await createApp(bookService);

    const res = await app.inject({ method: 'GET', url: '/api/import-jobs?status=bogus' });

    expect(res.statusCode).toBe(400);
    expect(bookService.listImportJobs).not.toHaveBeenCalled();
  });

  it('returns 400 when status mixes valid and invalid values', async () => {
    bookService.listImportJobs.mockResolvedValueOnce([]);
    const app = await createApp(bookService);

    const res = await app.inject({ method: 'GET', url: '/api/import-jobs?status=processing,bogus' });

    expect(res.statusCode).toBe(400);
    expect(bookService.listImportJobs).not.toHaveBeenCalled();
  });
});
