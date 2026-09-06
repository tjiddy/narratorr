import { type FastifyInstance } from 'fastify';
import { type DownloadOrchestrator } from '../services/download-orchestrator.js';
import { getErrorMessage } from '../utils/error-message.js';
import { sanitizeLogUrl } from '../utils/sanitize-log-url.js';
import { DuplicateDownloadError, isBookMissingRefusal } from '../services/download-errors.js';
import { DownloadClientError } from '@core/download-clients/errors.js';
import {
  grabBodySchema,
  type GrabInput,
} from '@shared/schemas.js';
import { serializeError } from '../utils/serialize-error.js';


export async function searchRoutes(
  app: FastifyInstance,
  downloadOrchestrator: DownloadOrchestrator,
) {
  app.post<{ Body: GrabInput }>(
    '/api/search/grab',
    {
      schema: {
        body: grabBodySchema,
      },
    },
    async (request, reply) => {
      const data = request.body;

      try {
        request.log.info({ title: data.title, replace: data.replace }, 'Grab requested');
        request.log.debug({ title: data.title, protocol: data.protocol, downloadUrl: sanitizeLogUrl(data.downloadUrl), bookId: data.bookId }, 'Grab details');
        const download = await downloadOrchestrator.grabInternal(data);
        request.log.debug({ downloadId: download.id, status: download.status, externalId: download.externalId }, 'Grab completed');
        return await reply.status(201).send(download);
      } catch (error: unknown) {
        if (error instanceof DuplicateDownloadError) {
          // Build the public conflict solely from classified details; never leak ids or raw errors.
          if ('active' in error.details) {
            const { active } = error.details;
            return reply.status(409).send({ code: 'ACTIVE_DOWNLOAD_EXISTS', active: { title: active.title }, count: active.count });
          }
          return reply.status(409).send({ code: 'PIPELINE_ACTIVE', reason: error.details.reason });
        }
        if (isBookMissingRefusal(error)) {
          // 404, not 409: the referenced resource is gone, matching `books.ts`'s `Book not found`.
          request.log.info({ bookId: data.bookId }, 'Grab refused — book no longer exists');
          return reply.status(404).send({ error: error.message, code: 'book_not_found' });
        }
        if (error instanceof DownloadClientError) {
          // The global handler maps typed client errors to 401, 504, or 502.
          throw error;
        }
        request.log.error({ error: serializeError(error) }, 'Grab failed');
        const message = getErrorMessage(error);
        return reply.status(500).send({ error: message });
      }
    }
  );
}
