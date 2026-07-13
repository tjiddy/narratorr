import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import type { Services } from './index.js';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { getVersion, getCommit, getBuildTime } from '../utils/version.js';
import { serializeError } from '../utils/serialize-error.js';

// The third-party notice ships alongside the app: repo root in dev/CI, `/app` in the
// runtime image (the s6 service runs `cd /app && node dist/server/index.js`, so
// `process.cwd()` resolves to `/app`). Resolving from cwd — not a hardcoded `/app` —
// keeps the notice readable in both trees (#1862).
const THIRD_PARTY_NOTICES_FILENAME = 'THIRD_PARTY_NOTICES.md';


export async function healthRoutes(app: FastifyInstance, services: Services, db: Db) {
  // GET /api/system/health/status — detailed health check results
  app.get('/api/system/health/status', async () => {
    return services.healthCheck.getCachedResults();
  });

  // GET /api/system/health/summary — aggregate state for navbar indicator
  app.get('/api/system/health/summary', async () => {
    return { state: services.healthCheck.getAggregateState() };
  });

  // POST /api/system/health/run — trigger immediate health check. A manual run
  // fires a live version check first (awaited, best-effort) so the returned
  // report reflects a fresh update status rather than the daily-cached value
  // (#1411). The scheduled `health-check` cron stays cache-only by calling
  // `runAllChecks()` directly.
  app.post('/api/system/health/run', async (request) => {
    return services.healthCheck.runManualChecks(request.log);
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

  // GET /api/system/notices — third-party license notices (#1862). Reads the notice
  // shipped with the app and returns it as JSON so the System-tab licenses section can
  // render the SAME file that ships in the image (single source of truth). A read failure
  // returns an explicit 500 (with a serialized server log) rather than falling through to
  // the generic handler, so the client can show a precise error affordance.
  app.get('/api/system/notices', async (request, reply) => {
    const noticePath = path.join(process.cwd(), THIRD_PARTY_NOTICES_FILENAME);
    try {
      const content = await fsp.readFile(noticePath, 'utf-8');
      return { content };
    } catch (error: unknown) {
      request.log.error({ error: serializeError(error) }, 'Failed to load third-party notices');
      return reply.status(500).send({ error: 'Failed to load third-party notices' });
    }
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
    } catch (error: unknown) {
      request.log.debug({ error: serializeError(error) }, 'Failed to query DB size');
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
      buildTime: getBuildTime(),
      nodeVersion: process.version,
      os: `${os.type()} ${os.release()}`,
      dbSize,
      libraryPath,
      freeSpace,
    };
  });
}
