import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { downloads, books } from '../../db/schema.js';
import { createServices, registerRoutes, type Services } from '../routes/index.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { unlink } from 'fs/promises';
import { expect } from 'vitest';
import { initializeKey } from '../utils/secret-codec.js';

export interface E2EApp {
  app: ReturnType<typeof Fastify> & { withTypeProvider: () => unknown };
  db: Db;
  services: Services;
  cleanup: () => Promise<void>;
}

/**
 * Boots a real Fastify server with an isolated temp libSQL database.
 * Runs migrations, creates real services, registers all routes.
 * Returns the app instance + cleanup function to tear down.
 *
 * No static files, no background jobs, no CORS — pure API testing.
 */
export async function createE2EApp(): Promise<E2EApp> {
  const dbFile = join(tmpdir(), `narratorr-e2e-${randomBytes(8).toString('hex')}.db`);

  await runMigrations(dbFile);
  const db = createDb(dbFile);

  // Initialize encryption key for e2e tests (deterministic key for test isolation)
  const testKey = Buffer.from('a'.repeat(64), 'hex');
  initializeKey(testKey);

  const app = Fastify({
    logger: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const services = await createServices(db, app.log);
  await registerRoutes(app, services, db);
  await app.ready();

  const cleanup = async () => {
    await app.close();
    try {
      await unlink(dbFile);
      // libSQL may create WAL/SHM files
      await unlink(`${dbFile}-wal`).catch(() => {});
      await unlink(`${dbFile}-shm`).catch(() => {});
    } catch {
      // temp file may already be gone
    }
  };

  return { app: app as unknown as E2EApp['app'], db, services, cleanup };
}

/**
 * Seed a book (status 'downloading') + completed download record.
 * Returns IDs for use in importDownload() and other E2E assertions.
 *
 * Shared helper — consolidates identical logic from import-flow, search-grab-flow,
 * and notifier-events E2E tests.
 */
export async function seedBookAndDownload(
  e2e: E2EApp,
  downloadClientId: number,
  title: string,
  authorName: string,
  opts: { completedAt?: Date; externalId?: string } = {},
) {
  const bookRes = await e2e.app.inject({
    method: 'POST',
    url: '/api/books',
    payload: { title, authors: [{ name: authorName }] },
  });
  expect(bookRes.statusCode).toBe(201);
  const bookId = bookRes.json().id;

  // Set book to 'downloading' (realistic pre-import state after grab)
  await e2e.db.update(books).set({ status: 'downloading' }).where(eq(books.id, bookId));

  const [download] = await e2e.db.insert(downloads).values({
    bookId,
    downloadClientId,
    title,
    protocol: 'torrent' as const,
    externalId: opts.externalId ?? 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
    status: 'completed' as const,
    completedAt: opts.completedAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000),
  }).returning();

  return { bookId, downloadId: download.id };
}
