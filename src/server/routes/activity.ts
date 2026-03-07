import type { FastifyInstance } from 'fastify';
import type { DownloadService } from '../services';
import { idParamSchema } from '../../shared/schemas.js';
import { z } from 'zod';

type IdParam = z.infer<typeof idParamSchema>;

const activityListQuerySchema = z.object({
  status: z.string().optional(),
});

export async function activityRoutes(app: FastifyInstance, downloadService: DownloadService) {
  // GET /api/activity
  app.get<{ Querystring: z.infer<typeof activityListQuerySchema> }>(
    '/api/activity',
    { schema: { querystring: activityListQuerySchema } },
    async (request, reply) => {
      try {
        const { status } = request.query;
        request.log.debug({ status }, 'Fetching activity');
        return await downloadService.getAll(status);
      } catch (error) {
        request.log.error(error, 'Failed to fetch activity');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // GET /api/activity/active
  app.get('/api/activity/active', async (request, reply) => {
    try {
      return await downloadService.getActive();
    } catch (error) {
      request.log.error(error, 'Failed to fetch active downloads');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /api/activity/counts
  app.get('/api/activity/counts', async (request, reply) => {
    try {
      request.log.debug('Fetching activity counts');
      return await downloadService.getCounts();
    } catch (error) {
      request.log.error(error, 'Failed to fetch activity counts');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /api/activity/:id
  app.get<{ Params: IdParam }>(
    '/api/activity/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const download = await downloadService.getById(id);

        if (!download) {
          return await reply.status(404).send({ error: 'Download not found' });
        }

        return download;
      } catch (error) {
        request.log.error(error, 'Failed to fetch download');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // DELETE /api/activity/:id (cancel)
  app.delete<{ Params: IdParam }>(
    '/api/activity/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const cancelled = await downloadService.cancel(id);

        if (!cancelled) {
          return await reply.status(404).send({ error: 'Download not found' });
        }

        request.log.info({ id }, 'Download cancelled');
        return { success: true };
      } catch (error) {
        request.log.error({ error }, 'Failed to cancel download');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // POST /api/activity/:id/retry
  app.post<{ Params: IdParam }>(
    '/api/activity/:id/retry',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      try {
        request.log.info({ id }, 'Download retry');
        const newDownload = await downloadService.retry(id);
        return newDownload;
      } catch (error) {
        request.log.error({ id, error }, 'Retry failed');
        const message = error instanceof Error ? error.message : 'Unknown error';
        // Map service-level validation errors to appropriate HTTP status
        if (message.includes('not found')) return reply.status(404).send({ error: message });
        if (message.includes('not in failed state') || message.includes('no download URL')) return reply.status(400).send({ error: message });
        return reply.status(500).send({ error: message });
      }
    },
  );
}
