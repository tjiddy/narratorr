import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { createMockLogger, createMockServices, inject } from '../__tests__/helpers.js';
import { generatePublicId } from '../utils/public-id.js';

// The route's own OPF refresh is #1670's contract and has its own suite; it is not under test here.
vi.mock('../utils/opf-refresh.js', () => ({ refreshOpfForBook: vi.fn().mockResolvedValue('skipped') }));

import { booksRoutes, type BookRouteDeps } from './books.js';
import { BookService } from '../services/book.service.js';
import { withBookAdmissionLock } from '../services/book-admission.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

/**
 * #2369 AC9 / F12. The operator edit acquires at the ROUTE, not inside `BookService.update` — that
 * method is a shared write primitive with nine non-test callers, most already inside a held
 * section (AC2). A service-level test therefore cannot see the wiring: it has to be driven through
 * the request, with another mutator holding the book, or deleting the route's wrapper leaves the
 * suite green.
 */
describe('PUT /api/books/:id participates in the admission lock (#2369 AC9)', () => {
  let dir: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let bookService: BookService;
  let app: Awaited<ReturnType<typeof buildApp>>;

  async function buildApp(deps: BookRouteDeps) {
    const instance = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    const { errorHandlerPlugin } = await import('../plugins/error-handler.js');
    await instance.register(errorHandlerPlugin);
    await booksRoutes(instance, deps);
    await instance.ready();
    return instance;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'books-route-admission-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    bookService = new BookService(db, inject<FastifyBaseLogger>(log));

    const services = createMockServices();
    app = await buildApp(inject<BookRouteDeps>({ ...services, bookService, connectorService: undefined }));
  });

  afterEach(async () => {
    await app.close();
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps libSQL handles open; see windows-hostile-test-primitives.
    }
  });

  const seedBook = async (title: string): Promise<number> => {
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title, status: 'imported', subtitle: null })
      .returning();
    return row!.id;
  };

  const rowOf = async (id: number) => {
    const [row] = await db
      .select({ subtitle: books.subtitle, title: books.title, userClearedFields: books.userClearedFields })
      .from(books)
      .where(eq(books.id, id));
    return row;
  };

  it('waits for a mutator already holding the book before applying the operator edit', async () => {
    const bookId = await seedBook('Held Book');

    // Stands in for any enrolled mutator mid-section: enrichment, refresh scan, an import commit.
    const parked = deferred();
    const holder = withBookAdmissionLock(bookId, async () => {
      await parked.promise;
      await bookService.update(bookId, { subtitle: 'Written By The Other Mutator' });
    });

    let settledResponse = false;
    const request = app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { subtitle: null } })
      .then((res) => { settledResponse = true; return res; });
    await settle();

    // The request is queued on the book's section, and nothing of it has reached the row.
    expect(settledResponse).toBe(false);
    expect((await rowOf(bookId))?.subtitle).toBeNull();

    parked.resolve();
    await holder;
    const response = await request;

    expect(response.statusCode).toBe(200);
    const row = await rowOf(bookId);
    // The operator's clear ran AFTER the other mutator's write, so it is the durable value…
    expect(row?.subtitle).toBeNull();
    // …and its tombstone survives, which is what stops the next fill-empty pass from undoing it.
    expect(row?.userClearedFields).toContain('subtitle');
  });

  it('applies the edit immediately when nothing holds the book', async () => {
    const bookId = await seedBook('Free Book');

    const response = await app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { title: 'Operator Title' } });

    expect(response.statusCode).toBe(200);
    expect((await rowOf(bookId))?.title).toBe('Operator Title');
  });

  it('still answers 404 for a book that vanished, without wedging the key for the next caller', async () => {
    const bookId = await seedBook('Doomed');
    await db.delete(books).where(eq(books.id, bookId));

    const response = await app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { title: 'Nope' } });

    expect(response.statusCode).toBe(404);
    // The section released: a second request for the same id is served rather than queued forever.
    const again = await app.inject({ method: 'PUT', url: `/api/books/${bookId}`, payload: { title: 'Nope' } });
    expect(again.statusCode).toBe(404);
  });
});
