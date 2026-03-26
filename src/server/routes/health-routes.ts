import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import type { Services } from './index.js';
import fsp from 'fs/promises';
import os from 'os';
import { getVersion, getCommit } from '../utils/version.js';

export async function healthRoutes(app: FastifyInstance, services: Services, db: Db) {
  // GET /api/system/health/status — detailed health check results
  app.get('/api/system/health/status', async () => {
    return services.healthCheck.getCachedResults();
  });

  // GET /api/system/health/summary — aggregate state for navbar indicator
  app.get('/api/system/health/summary', async () => {
    return { state: services.healthCheck.getAggregateState() };
  });

  // POST /api/system/health/run — trigger immediate health check
  app.post('/api/system/health/run', async () => {
    return services.healthCheck.runAllChecks();
  });

  // GET /api/system/tasks — list all scheduled tasks
  app.get('/api/system/tasks', async () => {
    return services.taskRegistry.getAll();
  });

  // POST /api/system/tasks/:name/run — trigger immediate task execution
  app.post<{ Params: { name: string } }>('/api/system/tasks/:name/run', async (request) => {
    await services.taskRegistry.runTask(request.params.name);
    return { ok: true };
  });

  // GET /api/system/info — system information
  app.get('/api/system/info', async (request) => {
    const librarySettings = await services.settings.get('library');
    const libraryPath = librarySettings?.path ?? null;

    let dbSize: number | null = null;
    try {
      const result = await db.run(
        sql`SELECT (SELECT page_count FROM pragma_page_count()) as page_count, (SELECT page_size FROM pragma_page_size()) as page_size`,
      );
      const row = result.rows[0];
      if (row) {
        dbSize = (row[0] as number) * (row[1] as number);
      }
    } catch (err) {
      request.log.debug(err, 'Failed to query DB size');
    }

    let freeSpace: number | null = null;
    if (libraryPath) {
      try {
        const stats = await fsp.statfs(libraryPath);
        freeSpace = stats.bavail * stats.bsize;
      } catch {
        // Library path may not exist yet
      }
    }

    return {
      version: getVersion(),
      commit: getCommit(),
      nodeVersion: process.version,
      os: `${os.type()} ${os.release()}`,
      dbSize,
      libraryPath,
      freeSpace,
    };
  });
}
