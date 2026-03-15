import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import type { Services } from './index.js';
import { runSearchJob, searchAllWanted } from '../jobs/search.js';
import { runRssJob } from '../jobs/rss.js';
import { runBackupJob } from '../jobs/backup.js';
import { healthRoutes } from './health-routes.js';
import { getVersion } from '../utils/version.js';
import { getUpdateStatus } from '../jobs/version-check.js';
import { RestoreUploadError } from '../services/backup.service.js';
import fs from 'fs';
import fsp from 'fs/promises';

export async function systemRoutes(app: FastifyInstance, services: Services, db: Db) {
  // GET /api/system/status
  app.get('/api/system/status', async () => {
    const systemSettings = await services.settings.get('system');
    const dismissedVersion = systemSettings?.dismissedUpdateVersion ?? '';
    const update = getUpdateStatus(dismissedVersion);

    return {
      version: getVersion(),
      status: 'ok',
      timestamp: new Date().toISOString(),
      ...(update ? { update } : {}),
    };
  });

  // GET /api/health — DB-aware health probe for Docker/k8s/load balancers
  app.get('/api/health', async (request, reply) => {
    try {
      await db.run(sql`SELECT 1`);
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      request.log.warn(error, 'Health check DB probe failed');
      return reply.status(503).send({
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Database unreachable',
      });
    }
  });

  // POST /api/system/tasks/search — manually trigger a search cycle
  app.post('/api/system/tasks/search', async (request) => {
    const result = await runSearchJob(
      services.settings,
      services.book,
      services.indexer,
      services.download,
      request.log,
      services.retryBudget,
    );
    return result;
  });

  // POST /api/system/tasks/search-all-wanted — search all wanted books
  app.post('/api/system/tasks/search-all-wanted', async (request) => {
    const result = await searchAllWanted(
      services.settings,
      services.book,
      services.indexer,
      services.download,
      request.log,
    );
    return result;
  });

  // POST /api/system/tasks/rss — manually trigger an RSS sync cycle
  app.post('/api/system/tasks/rss', async (request) => {
    const result = await runRssJob(
      services.settings,
      services.book,
      services.indexer,
      services.download,
      services.blacklist,
      request.log,
    );
    return result;
  });

  // GET /api/system/backups — list all backups
  app.get('/api/system/backups', async () => {
    return services.backup.list();
  });

  // POST /api/system/backups/create — manually trigger a backup
  app.post('/api/system/backups/create', async (request) => {
    return runBackupJob(services.backup, request.log);
  });

  // GET /api/system/backups/:filename/download — download a backup file
  app.get<{ Params: { filename: string } }>('/api/system/backups/:filename/download', async (request, reply) => {
    const filePath = services.backup.getBackupPath(request.params.filename);
    if (!filePath) {
      return reply.status(400).send({ error: 'Invalid backup filename' });
    }

    try {
      await fsp.access(filePath);
    } catch {
      return reply.status(404).send({ error: 'Backup not found' });
    }

    const stream = fs.createReadStream(filePath);
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${request.params.filename}"`)
      .send(stream);
  });

  // POST /api/system/restore — upload and validate a restore file
  app.post('/api/system/restore', async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    try {
      return await services.backup.processRestoreUpload(data.file);
    } catch (error) {
      if (error instanceof RestoreUploadError) {
        return reply.status(400).send({ error: error.message });
      }
      request.log.error(error, 'Restore upload failed');
      return reply.status(500).send({ error: 'Failed to process restore file' });
    }
  });

  // Health, task, and system info routes
  await healthRoutes(app, services, db);

  // POST /api/system/restore/confirm — confirm and apply the pending restore
  app.post('/api/system/restore/confirm', async (request, reply) => {
    try {
      await services.backup.confirmRestore();

      // Send response before exiting — the startup swap will apply the restore
      reply.send({ message: 'Restore confirmed. Server will restart to apply.' });

      // Exit after response is flushed — external supervisor restarts the process
      setImmediate(() => {
        request.log.info('Exiting for restore apply');
        process.exit(0);
      });

      return await reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(400).send({ error: message });
    }
  });
}
