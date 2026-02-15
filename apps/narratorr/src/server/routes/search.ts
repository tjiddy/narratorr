import { type FastifyInstance } from 'fastify';
import { type IndexerService } from '../services';
import { type DownloadService } from '../services';
import { type NotifierService } from '../services';
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
  notifierService: NotifierService
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
      request.log.debug({ q }, 'Search request');
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
        request.log.info({ title: data.title }, 'Grab requested');
        request.log.debug({ title: data.title, protocol: data.protocol, downloadUrl: data.downloadUrl, bookId: data.bookId }, 'Grab details');
        const download = await downloadService.grab(data);
        request.log.debug({ downloadId: download.id, status: download.status, externalId: download.externalId }, 'Grab completed');

        // Fire notification (fire-and-forget)
        Promise.resolve(notifierService.notify('on_grab', {
          event: 'on_grab',
          book: { title: data.title },
          release: {
            title: data.title,
            size: data.size,
          },
        })).catch((err) => request.log.warn(err, 'Failed to send grab notification'));

        return reply.status(201).send(download);
      } catch (error) {
        request.log.error(error, 'Grab failed');
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    }
  );
}
