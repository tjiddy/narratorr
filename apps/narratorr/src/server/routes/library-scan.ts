import type { FastifyInstance } from 'fastify';
import type { LibraryScanService } from '../services/library-scan.service.js';
import type { ImportConfirmItem } from '../services/library-scan.service.js';
import type { MatchJobService } from '../services/match-job.service.js';
import { type z } from 'zod';
import {
  scanSingleBodySchema,
  scanDirectoryBodySchema,
  importSingleBodySchema,
  importConfirmBodySchema,
  matchStartBodySchema,
  jobIdParamSchema,
} from '../../shared/schemas.js';

type ScanSingleBody = z.infer<typeof scanSingleBodySchema>;
type ScanDirectoryBody = z.infer<typeof scanDirectoryBodySchema>;
type ImportSingleBody = z.infer<typeof importSingleBodySchema>;
type ImportConfirmBody = z.infer<typeof importConfirmBodySchema>;
type MatchStartBody = z.infer<typeof matchStartBodySchema>;
type JobIdParam = z.infer<typeof jobIdParamSchema>;

export async function libraryScanRoutes(
  app: FastifyInstance,
  libraryScan: LibraryScanService,
  matchJobService: MatchJobService,
): Promise<void> {
  // Scan a single book folder — returns parsed metadata + provider match
  app.post<{ Body: ScanSingleBody }>(
    '/api/library/import/scan-single',
    { schema: { body: scanSingleBodySchema } },
    async (request, reply) => {
      const { path } = request.body;

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
    },
  );

  // Import a single book with metadata
  app.post<{ Body: ImportSingleBody }>(
    '/api/library/import/single',
    { schema: { body: importSingleBodySchema } },
    async (request, reply) => {
      const { mode, metadata, ...importItem } = request.body;

      request.log.info({ title: importItem.title, path: importItem.path, mode }, 'Importing single book');

      try {
        const result = await libraryScan.importSingleBook(importItem, metadata as ImportConfirmItem['metadata'], mode);
        return result;
      } catch (error) {
        request.log.error(error, 'Single book import failed');
        return reply.status(500).send({
          error: error instanceof Error ? error.message : 'Import failed',
        });
      }
    },
  );

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
  app.post<{ Body: ScanDirectoryBody }>(
    '/api/library/import/scan',
    { schema: { body: scanDirectoryBodySchema } },
    async (request, reply) => {
      const { path } = request.body;

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
    },
  );

  // Bulk confirm import (async — returns 202)
  app.post<{ Body: ImportConfirmBody }>(
    '/api/library/import/confirm',
    { schema: { body: importConfirmBodySchema } },
    async (request, reply) => {
      const { books: items, mode } = request.body;

      request.log.info({ count: items.length, mode }, 'Confirming library import (async)');

      try {
        const result = await libraryScan.confirmImport(items as ImportConfirmItem[], mode);
        return await reply.status(202).send(result);
      } catch (error) {
        request.log.error(error, 'Import confirmation failed');
        return reply.status(500).send({
          error: error instanceof Error ? error.message : 'Import failed',
        });
      }
    },
  );

  // Start a match job for discovered books
  app.post<{ Body: MatchStartBody }>(
    '/api/library/import/match',
    { schema: { body: matchStartBodySchema } },
    async (request) => {
      const { books: candidates } = request.body;

      request.log.info({ count: candidates.length }, 'Starting match job');
      const jobId = matchJobService.createJob(candidates);
      return { jobId };
    },
  );

  // Poll match job status
  app.get<{ Params: JobIdParam }>(
    '/api/library/import/match/:jobId',
    { schema: { params: jobIdParamSchema } },
    async (request, reply) => {
      const { jobId } = request.params;
      const status = matchJobService.getJob(jobId);
      if (!status) {
        return reply.status(404).send({ error: 'Job not found or expired' });
      }
      return status;
    },
  );

  // Cancel a match job
  app.delete<{ Params: JobIdParam }>(
    '/api/library/import/match/:jobId',
    { schema: { params: jobIdParamSchema } },
    async (request) => {
      const { jobId } = request.params;
      const cancelled = matchJobService.cancelJob(jobId);
      return { cancelled };
    },
  );
}
