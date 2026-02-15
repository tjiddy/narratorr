import type { FastifyInstance } from 'fastify';
import type { LibraryScanService } from '../services/library-scan.service.js';
import type { ImportConfirmItem } from '../services/library-scan.service.js';

export async function libraryScanRoutes(
  app: FastifyInstance,
  libraryScan: LibraryScanService,
): Promise<void> {
  app.post<{ Body: { path: string } }>('/api/library/import/scan', async (request, reply) => {
    const { path } = request.body;

    if (!path || typeof path !== 'string') {
      return reply.status(400).send({ error: 'path is required' });
    }

    request.log.info({ path }, 'Scanning directory for audiobooks');

    try {
      const result = await libraryScan.scanDirectory(path);
      return result;
    } catch (error) {
      request.log.error(error, 'Directory scan failed');
      return reply.status(500).send({
        error: error instanceof Error ? error.message : 'Scan failed',
      });
    }
  });

  app.post<{ Body: { books: ImportConfirmItem[] } }>('/api/library/import/confirm', async (request, reply) => {
    const { books: items } = request.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({ error: 'books array is required' });
    }

    request.log.info({ count: items.length }, 'Confirming library import');

    try {
      const result = await libraryScan.confirmImport(items);
      return result;
    } catch (error) {
      request.log.error(error, 'Import confirmation failed');
      return reply.status(500).send({
        error: error instanceof Error ? error.message : 'Import failed',
      });
    }
  });
}
