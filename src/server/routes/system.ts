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
import { getErrorMessage } from '../utils/error-message.js';
import { RestoreUploadError } from '../services/backup.service.js';
import fs from 'fs';
import fsp from 'fs/promises';
import { serializeError } from '../utils/serialize-error.js';


export async function systemRoutes(app: FastifyInstance, services: Services, db: Db) {
  // GET /api/system/status — public, minimal payload (#742): { version, status }.
  // Update info moved to authenticated GET /api/system/update-status.
  app.get('/api/system/status', async () => {
    return {
      version: getVersion(),
      status: 'ok',
    };
  });

  // GET /api/system/update-status — protected, returns dashboard update info.
  app.get('/api/system/update-status', async () => {
    const systemSettings = await services.settings.get('system');
    const dismissedVersion = systemSettings?.dismissedUpdateVersion ?? '';
    const update = getUpdateStatus(dismissedVersion);
    return { update: update ?? null };
  });

  // GET /api/health — DB-aware health probe for Docker/k8s/load balancers.
  // Public, intentionally minimal — UP/DOWN only, no version/commit/error fields.
  app.get('/api/health', async (request, reply) => {
    try {
      await db.run(sql`SELECT 1`);
      return { status: 'ok' };
    } catch (error: unknown) {
      request.log.warn({ error: serializeError(error) }, 'Health check DB probe failed');
      return reply.status(503).send({ status: 'error' });
    }
  });

  // POST /api/system/tasks/search — manually trigger a search cycle.
  // Preserved for external API compatibility — do not remove without external API review.
  // The generic POST /api/system/tasks/:name/run replaces this for new integrations,
  // but external scripts may still target this dedicated path. See SECURITY.md
  // ("Public-compatibility API surfaces") for the full list of preserved endpoints.
  app.post('/api/system/tasks/search', async (request) => {
    return services.taskRegistry.runExclusive('search', () =>
      runSearchJob(
        services.settings,
        services.bookList,
        services.indexerSearch,
        services.downloadOrchestrator,
        request.log,
        services.blacklist,
        services.retryBudget,
        services.eventBroadcaster,
      ),
    );
  });

  // POST /api/system/tasks/search-all-wanted — search all wanted books
  // Shares the 'search' lock with the scheduled search job (same underlying contention).
  app.post('/api/system/tasks/search-all-wanted', async (request) => {
    return services.taskRegistry.runExclusive('search', () =>
      searchAllWanted(
        services.settings,
        services.bookList,
        services.indexerSearch,
        services.downloadOrchestrator,
        request.log,
        services.blacklist,
        services.eventBroadcaster,
      ),
    );
  });

  // POST /api/system/tasks/rss — manually trigger an RSS sync cycle
  app.post('/api/system/tasks/rss', async (request) => {
    return services.taskRegistry.runExclusive('rss', () =>
      runRssJob(
        services.settings,
        services.bookList,
        services.indexerSearch,
        services.downloadOrchestrator,
        services.blacklist,
        request.log,
      ),
    );
  });

  // GET /api/system/backups — list all backups
  app.get('/api/system/backups', async () => {
    return services.backup.list();
  });

  // POST /api/system/backups/create — manually trigger a backup
  app.post('/api/system/backups/create', async (request) => {
    return services.taskRegistry.runExclusive('backup', () =>
      runBackupJob(services.backup, request.log),
    );
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
    const safeFilename = request.params.filename.replace(/[^a-zA-Z0-9._-]/g, '-');
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${safeFilename}"`)
      .send(stream);
  });

  // POST /api/system/backups/:filename/restore — validate and stage a server-side backup for restore
  app.post<{ Params: { filename: string } }>('/api/system/backups/:filename/restore', async (request, reply) => {
    const filePath = services.backup.getBackupPath(request.params.filename);
    if (!filePath) {
      return reply.status(400).send({ error: 'Invalid backup filename' });
    }

    try {
      await fsp.access(filePath);
    } catch {
      return reply.status(404).send({ error: 'Backup not found' });
    }

    try {
      return await services.backup.restoreServerBackup(request.params.filename);
    } catch (error: unknown) {
      if (error instanceof RestoreUploadError) {
        return reply.status(400).send({ error: error.message });
      }
      request.log.error({ error: serializeError(error) }, 'Restore from backup failed');
      return reply.status(500).send({ error: 'Failed to restore from backup' });
    }
  });

  // POST /api/system/restore — upload and validate a restore file
  app.post('/api/system/restore', async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    try {
      return await services.backup.processRestoreUpload(data.file);
    } catch (error: unknown) {
      if (error instanceof RestoreUploadError) {
        return reply.status(400).send({ error: error.message });
      }
      request.log.error({ error: serializeError(error) }, 'Restore upload failed');
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
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      return reply.status(400).send({ error: message });
    }
  });
}
