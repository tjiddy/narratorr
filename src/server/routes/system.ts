import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '@db/index.js';
import { sql } from 'drizzle-orm';
import type { Services } from './index.js';
import { runSearchJob, searchAllWanted } from '../jobs/search.js';
import { runBackupJob } from '../jobs/backup.js';
import { healthRoutes } from './health-routes.js';
import { getVersion } from '../utils/version.js';
import { getErrorMessage } from '../utils/error-message.js';
import { RestoreUploadError } from '../services/backup.service.js';
import fs from 'fs';
import fsp from 'fs/promises';
import { serializeError } from '../utils/serialize-error.js';
import { config } from '../config.js';


export async function systemRoutes(app: FastifyInstance, services: Services, db: Db) {
  // Keep this public payload minimal and omit instanceBadge when unconfigured.
  app.get('/api/system/status', async () => {
    return {
      version: getVersion(),
      status: 'ok',
      ...(config.instanceBadge ? { instanceBadge: config.instanceBadge } : {}),
    };
  });

  // Public probe exposes only up/down, not build or error details.
  app.get('/api/health', async (request, reply) => {
    try {
      await db.run(sql`SELECT 1`);
      return { status: 'ok' };
    } catch (error: unknown) {
      request.log.warn({ error: serializeError(error) }, 'Health check DB probe failed');
      return reply.status(503).send({ status: 'error' });
    }
  });

  // Preserved for external callers; new integrations use /api/system/tasks/:name/run.
  app.post('/api/system/tasks/search', async (request) => {
    return services.taskRegistry.runExclusive('search', () =>
      runSearchJob(
        services.settings,
        services.bookList,
        services.indexerSearch,
        services.downloadOrchestrator,
        request.log,
        services.blacklist,
        services.indexer,
        services.eventHistory,
        services.retryBudget,
        services.eventBroadcaster,
        services.searchLadderCooldown,
      ),
    );
  });

  app.post('/api/system/tasks/search-all-wanted', async (request) => {
    return services.taskRegistry.runExclusive('search', () =>
      searchAllWanted(
        services.settings,
        services.bookList,
        services.indexerSearch,
        services.downloadOrchestrator,
        request.log,
        services.blacklist,
        services.indexer,
        services.eventHistory,
        services.eventBroadcaster,
      ),
    );
  });

  app.get('/api/system/backups', async () => {
    return services.backup.list();
  });

  app.post('/api/system/backups/create', async (request) => {
    return services.taskRegistry.runExclusive('backup', () =>
      runBackupJob(services.backup, request.log),
    );
  });

  app.get<{ Params: { filename: string } }>('/api/system/backups/:filename/download', async (request, reply) => {
    const filePath = await resolveExistingBackup(services, request.params.filename, reply);
    if (!filePath) {
      return reply;
    }

    const stream = fs.createReadStream(filePath);
    const safeFilename = request.params.filename.replace(/[^a-zA-Z0-9._-]/g, '-');
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${safeFilename}"`)
      .send(stream);
  });

  app.post<{ Params: { filename: string } }>('/api/system/backups/:filename/restore', async (request, reply) => {
    const filePath = await resolveExistingBackup(services, request.params.filename, reply);
    if (!filePath) {
      return reply;
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

  app.delete<{ Params: { filename: string } }>('/api/system/backups/:filename', (request, reply) =>
    handleDeleteBackup(services, request, reply),
  );

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

  await healthRoutes(app, services, db);

  app.post('/api/system/restore/confirm', async (request, reply) => {
    try {
      await services.backup.confirmRestore();

      // Flush the response before the supervisor restarts us to apply the staged restore.
      reply.send({ message: 'Restore confirmed. Server will restart to apply.' });

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

/** Return an existing backup path after sending any 400/404 response. */
async function resolveExistingBackup(
  services: Services,
  filename: string,
  reply: FastifyReply,
): Promise<string | null> {
  const filePath = services.backup.getBackupPath(filename);
  if (!filePath) {
    await reply.status(400).send({ error: 'Invalid backup filename' });
    return null;
  }

  try {
    await fsp.access(filePath);
  } catch {
    await reply.status(404).send({ error: 'Backup not found' });
    return null;
  }

  return filePath;
}

// Return JSON, not 204: fetchApi always parses response.json().
async function handleDeleteBackup(
  services: Services,
  request: FastifyRequest<{ Params: { filename: string } }>,
  reply: FastifyReply,
) {
  const filePath = await resolveExistingBackup(services, request.params.filename, reply);
  if (!filePath) {
    return reply;
  }

  try {
    await services.backup.deleteBackup(request.params.filename);
    return await reply.send({ success: true });
  } catch (error: unknown) {
    request.log.error({ error: serializeError(error) }, 'Delete backup failed');
    return reply.status(500).send({ error: 'Failed to delete backup' });
  }
}
