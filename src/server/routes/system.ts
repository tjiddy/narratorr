import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db/index.js';
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


export async function systemRoutes(app: FastifyInstance, services: Services, db: Db) {
  // GET /api/system/status — public, minimal payload (#742): { version, status }.
  app.get('/api/system/status', async () => {
    return {
      version: getVersion(),
      status: 'ok',
    };
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
        services.indexer,
        services.eventHistory,
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
        services.indexer,
        services.eventHistory,
        services.eventBroadcaster,
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

  // POST /api/system/backups/:filename/restore — validate and stage a server-side backup for restore
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

  // DELETE /api/system/backups/:filename — delete a server-side backup file
  app.delete<{ Params: { filename: string } }>('/api/system/backups/:filename', (request, reply) =>
    handleDeleteBackup(services, request, reply),
  );

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

/**
 * Validates a raw backup filename and confirms the file exists on disk. Returns the validated
 * absolute path, or sends the error response itself and returns `null`:
 * - falsy `getBackupPath` (traversal/invalid name) → `400 { error: 'Invalid backup filename' }`
 * - `fsp.access` rejection (missing file) → `404 { error: 'Backup not found' }`
 *
 * Call sites short-circuit with `return reply` on `null` to avoid double-sending. Callers that
 * forward the filename to a service (restore/delete) keep passing the raw `filename`, not the
 * returned path — this helper changes validation only, not the value handed downstream.
 */
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

/**
 * DELETE /api/system/backups/:filename handler. Validates the raw filename via getBackupPath
 * (400 on traversal/invalid names) and fsp.access (404 on a missing file), then deletes it.
 * Passes the raw filename to deleteBackup, matching the restore route's filename-passing
 * contract. Returns 200 + JSON `{ success: true }` (not 204): the client fetchApi wrapper
 * always parses response.json() and rejects on an empty body. A staged restore is unaffected —
 * it lives in a separate temp path (PendingRestore.tempPath), not the backups dir.
 */
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
