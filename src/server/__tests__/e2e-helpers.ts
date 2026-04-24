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
import { clearImportAdapters } from '../services/import-adapters/registry.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { expect } from 'vitest';
import { initializeKey } from '../utils/secret-codec.js';

export interface E2EApp {
  app: ReturnType<typeof Fastify> & { withTypeProvider: () => unknown };
  db: Db;
  services: Services;
  /**
   * Per-run temp directory containing the libSQL DB file and its -wal/-shm sidecars.
   * Removed atomically by cleanup(); exposed for tests that need to inspect it.
   */
  dir: string;
  cleanup: () => Promise<void>;
}

const activeRunDirs = new Set<string>();
let signalHandlersRegistered = false;

function purgeActiveDirs() {
  for (const dir of activeRunDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort — process is exiting.
    }
  }
  activeRunDirs.clear();
}

function registerSignalHandlersOnce() {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;
  process.on('exit', purgeActiveDirs);
  process.on('SIGINT', () => {
    purgeActiveDirs();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    purgeActiveDirs();
    process.exit(143);
  });
}

/**
 * Boots a real Fastify server with an isolated temp libSQL database.
 * Runs migrations, creates real services, registers all routes.
 * Returns the app instance + cleanup function to tear down.
 *
 * Each call creates a per-run directory under `os.tmpdir()` prefixed
 * `narratorr-e2e-` that holds the DB file and its WAL/SHM sidecars.
 * cleanup() removes the directory atomically via a single recursive
 * `rmSync`. An abnormal exit (SIGINT/SIGTERM/process exit) triggers
 * a best-effort purge of any still-active run directories registered
 * at module load.
 *
 * Leftovers from an uncaught crash can be purged in bulk:
 *   find $TMPDIR -maxdepth 1 -name 'narratorr-e2e-*' -exec rm -rf {} +
 *
 * No static files, no background jobs, no CORS — pure API testing.
 */
export async function createE2EApp(): Promise<E2EApp> {
  registerSignalHandlersOnce();

  const dir = mkdtempSync(join(tmpdir(), 'narratorr-e2e-'));
  activeRunDirs.add(dir);
  const dbFile = join(dir, 'narratorr.db');

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

  clearImportAdapters(); // Reset module-level registry between test runs
  const services = await createServices(db, app.log);
  await registerRoutes(app, services, db);
  await app.ready();

  const cleanup = async () => {
    await app.close();
    // Surface rmSync failures on the happy path so tests can distinguish
    // success from masked failure. Best-effort swallowing is reserved for
    // the signal-handler branch above.
    rmSync(dir, { recursive: true, force: true });
    activeRunDirs.delete(dir);
  };

  return { app: app as unknown as E2EApp['app'], db, services, dir, cleanup };
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
