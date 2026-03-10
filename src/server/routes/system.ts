import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import type { Services } from './index.js';
import { runSearchJob, searchAllWanted } from '../jobs/search.js';
import { runRssJob } from '../jobs/rss.js';
import { runBackupJob } from '../jobs/backup.js';
import { healthRoutes } from './health-routes.js';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import unzipper from 'unzipper';

export async function systemRoutes(app: FastifyInstance, services: Services, db: Db) {
  // GET /api/system/status
  app.get('/api/system/status', async () => {
    return {
      version: '0.1.0',
      status: 'ok',
      timestamp: new Date().toISOString(),
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

    // Extract .db from uploaded zip to a temp file
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'narratorr-restore-'));
    const tempDbPath = path.join(tempDir, 'narratorr-restore.db');

    try {
      let found = false;

      await new Promise<void>((resolve, reject) => {
        const zipStream = data.file.pipe(unzipper.Parse());
        zipStream.on('entry', (entry: { path: string; autodrain: () => void; pipe: (dest: NodeJS.WritableStream) => void }) => {
          if (entry.path === 'narratorr.db') {
            found = true;
            const writeStream = fs.createWriteStream(tempDbPath);
            entry.pipe(writeStream);
            writeStream.on('finish', () => {});
            writeStream.on('error', reject);
          } else {
            entry.autodrain();
          }
        });
        zipStream.on('close', resolve);
        zipStream.on('error', reject);
      });

      if (!found) {
        await fsp.rm(tempDir, { recursive: true }).catch(() => {});
        return await reply.status(400).send({ error: 'Zip does not contain narratorr.db' });
      }

      const validation = await services.backup.validateRestore(tempDbPath);

      if (!validation.valid) {
        await fsp.rm(tempDir, { recursive: true }).catch(() => {});
        return await reply.status(400).send({ error: validation.error });
      }

      // Stage as pending restore (takes ownership of tempDbPath; confirmRestore cleans up dir)
      await services.backup.setPendingRestore(tempDbPath);

      return {
        valid: true,
        backupMigrationCount: validation.backupMigrationCount,
        appMigrationCount: validation.appMigrationCount,
      };
    } catch (error) {
      await fsp.rm(tempDir, { recursive: true }).catch(() => {});
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Unzipper throws on malformed/non-zip input — surface as client error
      if (message.includes('signature') || message.includes('invalid') || message.includes('Not a valid') || message.includes('end of central directory')) {
        return reply.status(400).send({ error: 'File is not a valid zip archive' });
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
