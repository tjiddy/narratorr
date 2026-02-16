import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createDb, runMigrations, type Db } from '@narratorr/db';
import { createServices, registerRoutes, type Services } from '../routes/index.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { unlink } from 'fs/promises';

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

  const app = Fastify({
    logger: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const services = createServices(db, app.log);
  await registerRoutes(app, services);
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
