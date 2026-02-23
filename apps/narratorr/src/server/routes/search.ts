import { type FastifyInstance } from 'fastify';
import { type IndexerService } from '../services';
import { type DownloadService } from '../services';
import { type BlacklistService } from '../services';
import {
  searchQuerySchema,
  grabSchema,
  type SearchQuery,
  type GrabInput,
} from '../../shared/schemas.js';

export async function searchRoutes(
  app: FastifyInstance,
  indexerService: IndexerService,
  downloadService: DownloadService,
  blacklistService: BlacklistService,
) {
  // GET /api/search
  app.get(
    '/api/search',
    {
      schema: {
        querystring: searchQuerySchema,
      },
    },
    async (request) => {
      const { q, limit, author, title } = request.query as SearchQuery;
      request.log.debug({ q, author, title }, 'Search request');
      const results = await indexerService.searchAll(q, { limit, author, title });
      const hashes = results
        .map((r: { infoHash?: string }) => r.infoHash)
        .filter((h): h is string => !!h);
      if (hashes.length === 0) return results;
      const blacklisted = await blacklistService.getBlacklistedHashes(hashes);
      return results.filter((r: { infoHash?: string }) => !r.infoHash || !blacklisted.has(r.infoHash));
    }
  );

  // POST /api/search/grab
  app.post(
    '/api/search/grab',
    {
      schema: {
        body: grabSchema,
      },
    },
    async (request, reply) => {
      const data = request.body as GrabInput;

      try {
        request.log.info({ title: data.title }, 'Grab requested');
        request.log.debug({ title: data.title, protocol: data.protocol, downloadUrl: data.downloadUrl, bookId: data.bookId }, 'Grab details');
        const download = await downloadService.grab(data);
        request.log.debug({ downloadId: download.id, status: download.status, externalId: download.externalId }, 'Grab completed');
        return reply.status(201).send(download);
      } catch (error) {
        request.log.error(error, 'Grab failed');
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    }
  );
}
