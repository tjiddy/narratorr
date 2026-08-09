import type { FastifyInstance } from 'fastify';
import type { Db } from '@db/index.js';
import { sql } from 'drizzle-orm';
import type { Services } from './index.js';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { getVersion, getCommit, getBuildTime } from '../utils/version.js';
import { serializeError } from '../utils/serialize-error.js';

// The notice lives at cwd in both the repository and runtime image.
const THIRD_PARTY_NOTICES_FILENAME = 'THIRD_PARTY_NOTICES.md';


export async function healthRoutes(app: FastifyInstance, services: Services, db: Db) {
  app.get('/api/system/health/status', async () => {
    return services.healthCheck.getCachedResults();
  });

  app.get('/api/system/health/summary', async () => {
    return { state: services.healthCheck.getAggregateState() };
  });

  // Manual runs refresh version state; scheduled runs intentionally use cached state.
  app.post('/api/system/health/run', async (request) => {
    return services.healthCheck.runManualChecks(request.log);
  });

  app.get('/api/system/tasks', async () => {
    return services.taskRegistry.getAll();
  });

  app.post<{ Params: { name: string } }>('/api/system/tasks/:name/run', async (request) => {
    await services.taskRegistry.runTask(request.params.name);
    return { ok: true };
  });

  // Serve the packaged notice itself so the image and UI share one source of truth.
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
