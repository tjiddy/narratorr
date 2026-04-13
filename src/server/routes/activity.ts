import type { FastifyInstance } from 'fastify';
import type { DownloadService } from '../services';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { QualityGateService } from '../services/quality-gate.service.js';
import type { QualityGateOrchestrator } from '../services/quality-gate-orchestrator.js';
import type { ImportService } from '../services/import.service.js';
import type { ImportOrchestrator } from '../services/import-orchestrator.js';
import { idParamSchema, paginationParamsSchema, DEFAULT_LIMITS } from '../../shared/schemas.js';
import { z } from 'zod';

type IdParam = z.infer<typeof idParamSchema>;

const activityListQuerySchema = z.object({
  status: z.string().optional(),
  section: z.enum(['queue', 'history']).optional(),
}).merge(paginationParamsSchema);

type ActivityListQuery = z.infer<typeof activityListQuerySchema>;

export async function activityRoutes(app: FastifyInstance, downloadService: DownloadService, downloadOrchestrator: DownloadOrchestrator, qualityGateService: QualityGateService, qualityGateOrchestrator: QualityGateOrchestrator, importService: ImportService, importOrchestrator: ImportOrchestrator) {
  // GET /api/activity
  app.get<{ Querystring: ActivityListQuery }>(
    '/api/activity',
    { schema: { querystring: activityListQuerySchema } },
    async (request) => {
      const { status, section, limit, offset } = request.query;
      request.log.debug({ status, section, limit, offset }, 'Fetching activity');
      const pagination = { limit: limit ?? DEFAULT_LIMITS.activity, offset };
      const result = await downloadService.getAll(status, pagination, section);

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
    },
  );

  // GET /api/activity/active
  app.get('/api/activity/active', async () => {
    return downloadService.getActive();
  });

  // GET /api/activity/counts
  app.get('/api/activity/counts', async (request) => {
    request.log.debug('Fetching activity counts');
    return downloadService.getCounts();
  });

  // GET /api/activity/:id
  app.get<{ Params: IdParam }>(
    '/api/activity/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const download = await downloadService.getById(id);

      if (!download) {
        return reply.status(404).send({ error: 'Download not found' });
      }

      return download;
    },
  );

  // DELETE /api/activity/history (bulk clear)
  app.delete('/api/activity/history', async (request) => {
    request.log.info('Bulk deleting download history');
    return downloadService.deleteHistory();
  });

  // DELETE /api/activity/:id/history (single history delete)
  app.delete<{ Params: IdParam }>(
    '/api/activity/:id/history',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      const deleted = await downloadService.delete(id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Download not found' });
      }
      request.log.info({ id }, 'Download history item deleted');
      return { success: true };
    },
  );

  // DELETE /api/activity/:id (cancel)
  app.delete<{ Params: IdParam }>(
    '/api/activity/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const cancelled = await downloadOrchestrator.cancel(id);

      if (!cancelled) {
        return reply.status(404).send({ error: 'Download not found' });
      }

      request.log.info({ id }, 'Download cancelled');
      return { success: true };
    },
  );

  // POST /api/activity/:id/retry (search-based retry)
  app.post<{ Params: IdParam }>(
    '/api/activity/:id/retry',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      request.log.info({ id }, 'Download retry');
      const result = await downloadOrchestrator.retry(id);

      switch (result.status) {
        case 'retried':
          return reply.status(201).send(result.download);
        case 'no_candidates':
          return reply.status(200).send({ status: 'no_candidates' });
        case 'retry_error':
          return reply.status(200).send({ status: 'retry_error' });
      }
    },
  );

  // POST /api/activity/:id/approve (quality gate approval)
  app.post<{ Params: IdParam }>(
    '/api/activity/:id/approve',
    { schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params;

      request.log.info({ id }, 'Download approved');
      const result = await qualityGateOrchestrator.approve(id);

      // Try to acquire a concurrency slot for immediate import
      if (importService.tryAcquireSlot()) {
        // Slot available — fire-and-forget import with guaranteed slot release
        importOrchestrator.importDownload(id)
          .catch((err) => {
            request.log.error({ id, error: err }, 'Import after approve failed');
          })
          .finally(() => {
            importService.releaseSlot();
            importOrchestrator.drainQueuedImports().catch((error: unknown) => {
              request.log.error({ error }, 'Approve: queued import drain failed');
            });
          });
        return result;
      } else {
        // No slot available — queue for next tick
        request.log.info({ id }, 'Concurrency limit reached, queuing approved download');
        await importService.setProcessingQueued(id);
        return { ...result, status: 'processing_queued' };
      }
    },
  );

  // POST /api/activity/:id/reject (quality gate rejection)
  const rejectBodySchema = z.object({ retry: z.boolean().optional().default(false) });

  app.post<{ Params: IdParam }>(
    '/api/activity/:id/reject',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const parsed = rejectBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues });
      }
      const { retry } = parsed.data;

      request.log.info({ id, retry }, 'Download rejected');
      return qualityGateOrchestrator.reject(id, { retry });
    },
  );
}
