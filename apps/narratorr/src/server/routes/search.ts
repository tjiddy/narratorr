import { type FastifyInstance } from 'fastify';
import { type IndexerService } from '../services';
import { type DownloadService } from '../services';
import {
  searchQuerySchema,
  grabSchema,
  type SearchQuery,
  type GrabInput,
} from '../../shared/schemas.js';

export async function searchRoutes(
  app: FastifyInstance,
  indexerService: IndexerService,
  downloadService: DownloadService
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
      const { q, limit } = request.query as SearchQuery;
      return indexerService.searchAll(q, { limit });
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
        const download = await downloadService.grab(data);
        return reply.status(201).send(download);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    }
  );
}
