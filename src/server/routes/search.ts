import { type FastifyInstance } from 'fastify';
import { type IndexerService } from '../services';
import { type DownloadOrchestrator } from '../services/download-orchestrator.js';
import { type BlacklistService } from '../services';
import { type SettingsService } from '../services';
import { getErrorMessage } from '../utils/error-message.js';
import { DuplicateDownloadError } from '../services/download.service.js';
import { postProcessSearchResults } from '../services/search-pipeline.js';
import {
  searchQuerySchema,
  grabSchema,
  type SearchQuery,
  type GrabInput,
} from '../../shared/schemas.js';

export async function searchRoutes(
  app: FastifyInstance,
  indexerService: IndexerService,
  downloadOrchestrator: DownloadOrchestrator,
  blacklistService: BlacklistService,
  settingsService: SettingsService,
) {
  // GET /api/search
  app.get<{ Querystring: SearchQuery }>(
    '/api/search',
    {
      schema: {
        querystring: searchQuerySchema,
      },
    },
    async (request, reply) => {
      const { q, limit, author, title, bookDuration } = request.query;

      // Reject invalid bookDuration (transformed to null by schema)
      if (bookDuration === null) {
        return reply.status(400).send({ error: 'bookDuration must be a positive number' });
      }

      request.log.debug({ q, author, title, bookDuration }, 'Search request');
      const allResults = await indexerService.searchAll(q, { limit, author, title });

      return postProcessSearchResults(allResults, bookDuration, blacklistService, settingsService);
    }
  );

  // POST /api/search/grab
  app.post<{ Body: GrabInput }>(
    '/api/search/grab',
    {
      schema: {
        body: grabSchema,
      },
    },
    async (request, reply) => {
      const data = request.body;

      try {
        request.log.info({ title: data.title }, 'Grab requested');
        request.log.debug({ title: data.title, protocol: data.protocol, downloadUrl: data.downloadUrl, bookId: data.bookId }, 'Grab details');
        const download = await downloadOrchestrator.grab(data);
        request.log.debug({ downloadId: download.id, status: download.status, externalId: download.externalId }, 'Grab completed');
        return await reply.status(201).send(download);
      } catch (error: unknown) {
        if (error instanceof DuplicateDownloadError) {
          if (error.code === 'ACTIVE_DOWNLOAD_EXISTS') {
            return reply.status(409).send({ code: 'ACTIVE_DOWNLOAD_EXISTS' });
          }
          // PIPELINE_ACTIVE — propagate to error-handler plugin (returns 409 { error: message })
          throw error;
        }
        request.log.error(error, 'Grab failed');
        const message = getErrorMessage(error);
        return reply.status(500).send({ error: message });
      }
    }
  );
}
