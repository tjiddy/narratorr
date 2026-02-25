import type { FastifyInstance } from 'fastify';
import type { LibraryScanService } from '../services/library-scan.service.js';
import type { ImportConfirmItem, ImportMode } from '../services/library-scan.service.js';
import type { MatchJobService, MatchCandidate } from '../services/match-job.service.js';

export async function libraryScanRoutes(
  app: FastifyInstance,
  libraryScan: LibraryScanService,
  matchJobService: MatchJobService,
): Promise<void> {
  // Scan a single book folder — returns parsed metadata + provider match
  app.post<{ Body: { path: string } }>('/api/library/import/scan-single', async (request, reply) => {
    const { path } = request.body;

    if (!path || typeof path !== 'string') {
      return reply.status(400).send({ error: 'path is required' });
    }

    request.log.info({ path }, 'Scanning single book folder');

    try {
      const result = await libraryScan.scanSingleBook(path);
      return result;
    } catch (error) {
      request.log.warn({ error, path }, 'Single book scan failed');
      return reply.status(400).send({
        error: error instanceof Error ? error.message : 'Scan failed',
      });
    }
  });

  // Import a single book with metadata
  app.post<{ Body: ImportConfirmItem & { mode?: ImportMode } }>('/api/library/import/single', async (request, reply) => {
    const { mode, ...item } = request.body;

    if (!item?.path || !item?.title) {
      return reply.status(400).send({ error: 'path and title are required' });
    }

    request.log.info({ title: item.title, path: item.path, mode }, 'Importing single book');

    try {
      const { metadata, ...importItem } = item;
      const result = await libraryScan.importSingleBook(importItem, metadata ?? undefined, mode);
      return result;
    } catch (error) {
      request.log.error(error, 'Single book import failed');
      return reply.status(500).send({
        error: error instanceof Error ? error.message : 'Import failed',
      });
    }
  });

  // Rescan library — verify book paths exist on disk
  app.post('/api/library/rescan', async (request, reply) => {
    request.log.info('Starting library rescan');
    try {
      const result = await libraryScan.rescanLibrary();
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === 'Scan already in progress') {
        return reply.status(409).send({ error: error.message });
      }
      if (error instanceof Error && (error.message.startsWith('Library path is not') || error.message === 'Library path is not configured')) {
        return reply.status(400).send({ error: error.message });
      }
      request.log.error(error, 'Library rescan failed');
      return reply.status(500).send({
        error: error instanceof Error ? error.message : 'Rescan failed',
      });
    }
  });

  // Bulk scan directory (kept for Library Import #125)
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

  // Bulk confirm import (async — returns 202)
  app.post<{ Body: { books: ImportConfirmItem[]; mode?: ImportMode } }>('/api/library/import/confirm', async (request, reply) => {
    const { books: items, mode } = request.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({ error: 'books array is required' });
    }

    request.log.info({ count: items.length, mode }, 'Confirming library import (async)');

    try {
      const result = await libraryScan.confirmImport(items, mode);
      return await reply.status(202).send(result);
    } catch (error) {
      request.log.error(error, 'Import confirmation failed');
      return reply.status(500).send({
        error: error instanceof Error ? error.message : 'Import failed',
      });
    }
  });

  // Start a match job for discovered books
  app.post<{ Body: { books: MatchCandidate[] } }>('/api/library/import/match', async (request, reply) => {
    const { books: candidates } = request.body;

    if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
      return reply.status(400).send({ error: 'books array is required' });
    }

    request.log.info({ count: candidates.length }, 'Starting match job');
    const jobId = matchJobService.createJob(candidates);
    return { jobId };
  });

  // Poll match job status
  app.get<{ Params: { jobId: string } }>('/api/library/import/match/:jobId', async (request, reply) => {
    const status = matchJobService.getJob(request.params.jobId);
    if (!status) {
      return reply.status(404).send({ error: 'Job not found or expired' });
    }
    return status;
  });

  // Cancel a match job
  app.delete<{ Params: { jobId: string } }>('/api/library/import/match/:jobId', async (request, _reply) => {
    const cancelled = matchJobService.cancelJob(request.params.jobId);
    return { cancelled };
  });
}
