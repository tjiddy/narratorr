import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { inject } from '../__tests__/helpers.js';
import type { BookService, RetryImportResult } from '../services/book.service.js';
import { retryImportRoute } from './retry-import.js';

interface MockBookService {
  retryImport: ReturnType<typeof vi.fn>;
  getRetryAvailability: ReturnType<typeof vi.fn>;
}

async function createApp(bookService: MockBookService, nudge: () => void = () => undefined) {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(async (scoped) => {
    await retryImportRoute(scoped as unknown as typeof app, inject<BookService>(bookService), nudge);
  });
  return app;
}

describe('POST /api/books/:id/retry-import', () => {
  let bookService: MockBookService;
  let nudge: () => void;

  beforeEach(() => {
    bookService = {
      retryImport: vi.fn(),
      getRetryAvailability: vi.fn(),
    };
    nudge = vi.fn();
  });

  it('returns 202 with jobId on success and forwards nudge callback', async () => {
    bookService.retryImport.mockResolvedValueOnce({ jobId: 20 } satisfies RetryImportResult);
    const app = await createApp(bookService, nudge);

    const res = await app.inject({ method: 'POST', url: '/api/books/1/retry-import' });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.payload)).toEqual({ jobId: 20 });
    expect(bookService.retryImport).toHaveBeenCalledWith(1, nudge);
  });

  it('returns 404 when service reports book not found', async () => {
    bookService.retryImport.mockResolvedValueOnce({ error: 'Book not found', status: 404 });
    const app = await createApp(bookService, nudge);

    const res = await app.inject({ method: 'POST', url: '/api/books/999/retry-import' });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Book not found' });
  });

  it('returns 409 when service reports active import', async () => {
    bookService.retryImport.mockResolvedValueOnce({ error: 'Import already in progress', status: 409 });
    const app = await createApp(bookService, nudge);

    const res = await app.inject({ method: 'POST', url: '/api/books/1/retry-import' });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Import already in progress' });
  });

  it('returns 400 when service reports no failed job', async () => {
    bookService.retryImport.mockResolvedValueOnce({ error: 'No failed import job found for this book', status: 400 });
    const app = await createApp(bookService, nudge);

    const res = await app.inject({ method: 'POST', url: '/api/books/1/retry-import' });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ error: 'No failed import job found for this book' });
  });
});

describe('GET /api/books/:id/retry-import', () => {
  let bookService: MockBookService;

  beforeEach(() => {
    bookService = {
      retryImport: vi.fn(),
      getRetryAvailability: vi.fn(),
    };
  });

  it('maps retryable=true to available=true', async () => {
    bookService.getRetryAvailability.mockResolvedValueOnce({ retryable: true, lastFailedJobId: 10 });
    const app = await createApp(bookService, vi.fn());

    const res = await app.inject({ method: 'GET', url: '/api/books/1/retry-import' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ available: true });
  });

  it('maps retryable=false to available=false', async () => {
    bookService.getRetryAvailability.mockResolvedValueOnce({ retryable: false });
    const app = await createApp(bookService, vi.fn());

    const res = await app.inject({ method: 'GET', url: '/api/books/1/retry-import' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ available: false });
  });

  it('does not leak lastFailedJobId in HTTP response', async () => {
    bookService.getRetryAvailability.mockResolvedValueOnce({ retryable: true, lastFailedJobId: 42 });
    const app = await createApp(bookService, vi.fn());

    const res = await app.inject({ method: 'GET', url: '/api/books/1/retry-import' });

    expect(Object.keys(JSON.parse(res.payload))).toEqual(['available']);
  });
});
