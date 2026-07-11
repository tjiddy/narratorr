import { type FastifyInstance } from 'fastify';
import { type DownloadOrchestrator } from '../services/download-orchestrator.js';
import { getErrorMessage } from '../utils/error-message.js';
import { sanitizeLogUrl } from '../utils/sanitize-log-url.js';
import { DuplicateDownloadError } from '../services/download-errors.js';
import { DownloadClientError } from '../../core/download-clients/errors.js';
import {
  grabBodySchema,
  type GrabInput,
} from '../../shared/schemas.js';
import { serializeError } from '../utils/serialize-error.js';


export async function searchRoutes(
  app: FastifyInstance,
  downloadOrchestrator: DownloadOrchestrator,
) {
  // POST /api/search/grab
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
          // Shape both conflict codes from the structured error `details` the
          // gatherAllBlockers classification populated — no internal ids, no raw
          // messages, no re-querying (the decision stayed in the service, #1857 F60).
          if (error.code === 'ACTIVE_DOWNLOAD_EXISTS') {
            const active = error.details?.active ?? { title: data.title, count: 1 };
            return reply.status(409).send({ code: 'ACTIVE_DOWNLOAD_EXISTS', active: { title: active.title }, count: active.count });
          }
          return reply.status(409).send({ code: 'PIPELINE_ACTIVE', reason: error.details?.reason ?? 'processing' });
        }
        if (error instanceof DownloadClientError) {
          // Typed download-client errors propagate to error-handler plugin
          // (DownloadClientAuthError → 401, DownloadClientTimeoutError → 504, DownloadClientError → 502)
          throw error;
        }
        request.log.error({ error: serializeError(error) }, 'Grab failed');
        const message = getErrorMessage(error);
        return reply.status(500).send({ error: message });
      }
    }
  );
}
