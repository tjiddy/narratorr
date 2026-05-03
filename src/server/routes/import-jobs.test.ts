import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { BookImportService, ImportJobListing } from '../services/book-import.service.js';
import { importJobsRoutes } from './import-jobs.js';

interface MockBookImportService {
  listImportJobs: ReturnType<typeof vi.fn>;
}

async function createApp(bookImportService: MockBookImportService) {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const { errorHandlerPlugin } = await import('../plugins/error-handler.js');
  await app.register(errorHandlerPlugin);
  await importJobsRoutes(app, inject<BookImportService>(bookImportService));
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
  let bookImportService: MockBookImportService;

  beforeEach(() => {
    bookImportService = { listImportJobs: vi.fn() };
  });

  it('returns the service result unchanged', async () => {
    bookImportService.listImportJobs.mockResolvedValueOnce([baseListing]);
    const app = await createApp(bookImportService);

    const res = await app.inject({ method: 'GET', url: '/api/import-jobs' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ImportJobListing[];
    expect(body).toHaveLength(1);
    expect(body[0]!.book.title).toBe('My Book');
    expect(body[0]!.book.coverUrl).toBe('/covers/42.jpg');
    expect(body[0]!.book.primaryAuthorName).toBe('Brandon Sanderson');
    expect(body[0]!.phaseHistory).toEqual([{ phase: 'analyzing', startedAt: 1000, completedAt: 2000 }]);
    expect(bookImportService.listImportJobs).toHaveBeenCalledWith({ status: undefined });
  });

  it('returns empty array when service returns no rows', async () => {
    bookImportService.listImportJobs.mockResolvedValueOnce([]);
    const app = await createApp(bookImportService);

    const res = await app.inject({ method: 'GET', url: '/api/import-jobs' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('parses single status into typed array', async () => {
    bookImportService.listImportJobs.mockResolvedValueOnce([]);
    const app = await createApp(bookImportService);

    await app.inject({ method: 'GET', url: '/api/import-jobs?status=processing' });

    expect(bookImportService.listImportJobs).toHaveBeenCalledWith({ status: ['processing'] });
  });

  it('parses comma-separated statuses into typed array', async () => {
    bookImportService.listImportJobs.mockResolvedValueOnce([]);
    const app = await createApp(bookImportService);

    await app.inject({ method: 'GET', url: '/api/import-jobs?status=processing,failed' });

    expect(bookImportService.listImportJobs).toHaveBeenCalledWith({ status: ['processing', 'failed'] });
  });

  it('returns 400 when status contains an invalid value', async () => {
    bookImportService.listImportJobs.mockResolvedValueOnce([]);
    const app = await createApp(bookImportService);

    const res = await app.inject({ method: 'GET', url: '/api/import-jobs?status=bogus' });

    expect(res.statusCode).toBe(400);
    expect(bookImportService.listImportJobs).not.toHaveBeenCalled();
  });

  it('returns 400 when status mixes valid and invalid values', async () => {
    bookImportService.listImportJobs.mockResolvedValueOnce([]);
    const app = await createApp(bookImportService);

    const res = await app.inject({ method: 'GET', url: '/api/import-jobs?status=processing,bogus' });

    expect(res.statusCode).toBe(400);
    expect(bookImportService.listImportJobs).not.toHaveBeenCalled();
  });
});
