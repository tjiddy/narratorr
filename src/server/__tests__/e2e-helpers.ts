import Fastify from 'fastify';
import { generatePublicId } from '../utils/public-id.js';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { eq } from 'drizzle-orm';
import { downloads, books } from '@db/schema.js';
import { createServices, registerRoutes, type Services } from '../routes/index.js';
import { clearImportAdapters } from '../services/import-adapters/registry.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { removeTreeSync } from '@core/utils/remove-tree.js';
import { expect } from 'vitest';
import { initializeKey } from '../utils/secret-codec.js';

export interface E2EApp {
  app: ReturnType<typeof Fastify> & { withTypeProvider: () => unknown };
  db: Db;
  services: Services;
  /** Per-run libSQL directory, exposed for cleanup assertions. */
  dir: string;
  cleanup: () => Promise<void>;
}

const activeRunDirs = new Set<string>();
let signalHandlersRegistered = false;
const isWindows = process.platform === 'win32';

/**
 * libSQL can retain its Windows file handle after close, so tolerate EPERM until process exit.
 * Linux cleanup remains strict to expose real leaks.
 */
function rmDirOrLeak(dir: string) {
  try {
    removeTreeSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const isLockError = code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY';
    if (isWindows && isLockError) return; // libsql file-handle leak — unavoidable on Windows
    throw err;
  }
}

function purgeActiveDirs() {
  for (const dir of activeRunDirs) {
    try {
      removeTreeSync(dir);
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
 * Boot the real app against an isolated migrated libSQL database. Cleanup removes the whole run
 * directory; process signals attempt cleanup for every active run.
 */
export async function createE2EApp(): Promise<E2EApp> {
  registerSignalHandlersOnce();

  const dir = mkdtempSync(join(tmpdir(), 'narratorr-e2e-'));
  activeRunDirs.add(dir);
  const dbFile = join(dir, 'narratorr.db');

  await runMigrations(dbFile);
  const db = createDb(dbFile);

  const testKey = Buffer.from('a'.repeat(64), 'hex');
  initializeKey(testKey);

  const app = Fastify({
    logger: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  clearImportAdapters(); // Reset module-level registry between test runs
  // Production and both unit-tier helpers register this; without it every ERROR_REGISTRY-mapped
  // error reads as a generic 500 here, and no e2e test can protect a registry mapping (#2460).
  const { errorHandlerPlugin } = await import('../plugins/error-handler.js');
  await app.register(errorHandlerPlugin);
  const services = await createServices(db, app.log);
  await registerRoutes(app, services, db);
  await app.ready();

  const cleanup = async () => {
    await app.close();
    db.$client.close();
    // Strict on Linux; tolerate libSQL's retained Windows handle.
    rmDirOrLeak(dir);
    activeRunDirs.delete(dir);
  };

  return { app: app as unknown as E2EApp['app'], db, services, dir, cleanup };
}

/** Seed a downloading book and completed download record. */
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

  await e2e.db.update(books).set({ status: 'downloading' }).where(eq(books.id, bookId));

  const [download] = await e2e.db.insert(downloads).values({ publicId: generatePublicId('dl'),
    bookId,
    downloadClientId,
    title,
    protocol: 'torrent' as const,
    externalId: opts.externalId ?? 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
    clientStatus: 'completed' as const,
    pipelineStage: 'idle' as const,
    // Import failure restores this lifecycle snapshot rather than inferring from path.
    bookStatusAtGrab: 'wanted' as const,
    completedAt: opts.completedAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000),
  }).returning();

  return { bookId, downloadId: download!.id };
}
