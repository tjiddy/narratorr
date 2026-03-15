import type { FastifyInstance } from 'fastify';
import type { DownloadService } from '../services';
import type { QualityGateService } from '../services/quality-gate.service.js';
import type { ImportService } from '../services/import.service.js';
import { idParamSchema, paginationParamsSchema } from '../../shared/schemas.js';
import { z } from 'zod';

type IdParam = z.infer<typeof idParamSchema>;

const activityListQuerySchema = z.object({
  status: z.string().optional(),
}).merge(paginationParamsSchema);

type ActivityListQuery = z.infer<typeof activityListQuerySchema>;

// eslint-disable-next-line max-lines-per-function -- linear route registration
export async function activityRoutes(app: FastifyInstance, downloadService: DownloadService, qualityGateService: QualityGateService, importService: ImportService) {
  // GET /api/activity
  app.get<{ Querystring: ActivityListQuery }>(
    '/api/activity',
    { schema: { querystring: activityListQuerySchema } },
    async (request, reply) => {
      try {
        const { status, limit, offset } = request.query;
        request.log.debug({ status, limit, offset }, 'Fetching activity');
        const pagination = limit !== undefined || offset !== undefined ? { limit, offset } : undefined;
        const result = await downloadService.getAll(status, pagination);

        // Augment pending_review downloads with quality gate comparison data (batch)
        const pendingIds = result.data
          .filter((dl) => dl.status === 'pending_review')
          .map((dl) => dl.id);

        const gateMap = pendingIds.length > 0
          ? await qualityGateService.getQualityGateDataBatch(pendingIds)
          : new Map<number, null>();

        const augmented = result.data.map((dl) => {
          const qualityGate = gateMap.get(dl.id);
          return qualityGate ? { ...dl, qualityGate } : dl;
        });

        return { data: augmented, total: result.total };
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

  // POST /api/activity/:id/retry (search-based retry)
  app.post<{ Params: IdParam }>(
    '/api/activity/:id/retry',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      try {
        request.log.info({ id }, 'Download retry');
        const result = await downloadService.retry(id);

        switch (result.status) {
          case 'retried':
            return await reply.status(201).send(result.download);
          case 'no_candidates':
            return await reply.status(200).send({ status: 'no_candidates' });
          case 'retry_error':
            return await reply.status(200).send({ status: 'retry_error' });
        }
      } catch (error) {
        request.log.error({ id, error }, 'Retry failed');
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (message.includes('not found') || message.includes('no book linked')) return reply.status(404).send({ error: message });
        if (message.includes('not in failed state')) return reply.status(400).send({ error: message });
        return reply.status(500).send({ error: message });
      }
    },
  );

  // POST /api/activity/:id/approve (quality gate approval)
  app.post<{ Params: IdParam }>(
    '/api/activity/:id/approve',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      try {
        request.log.info({ id }, 'Download approved');
        const result = await qualityGateService.approve(id);

        // Try to acquire a concurrency slot for immediate import
        if (importService.tryAcquireSlot()) {
          // Slot available — fire-and-forget import with guaranteed slot release
          importService.importDownload(id)
            .catch((err) => {
              request.log.error({ id, error: err }, 'Import after approve failed');
            })
            .finally(() => {
              importService.releaseSlot();
            });
          return result;
        } else {
          // No slot available — queue for next tick
          request.log.info({ id }, 'Concurrency limit reached, queuing approved download');
          await importService.setProcessingQueued(id);
          return { ...result, status: 'processing_queued' };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (message === 'not found') return reply.status(404).send({ error: 'Download not found' });
        if (message === 'not pending_review') return reply.status(409).send({ error: 'Download is not pending review' });
        request.log.error({ id, error }, 'Approve failed');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // POST /api/activity/:id/reject (quality gate rejection)
  app.post<{ Params: IdParam }>(
    '/api/activity/:id/reject',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body as { reason?: string } | undefined;
      const reason = body?.reason;

      try {
        request.log.info({ id }, 'Download rejected');
        const result = await qualityGateService.reject(id, reason);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (message === 'not found') return reply.status(404).send({ error: 'Download not found' });
        if (message === 'not pending_review') return reply.status(409).send({ error: 'Download is not pending review' });
        request.log.error({ id, error }, 'Reject failed');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );
}
