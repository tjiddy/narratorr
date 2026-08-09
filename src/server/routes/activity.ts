import type { FastifyInstance } from 'fastify';
import type { DownloadService } from '../services';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { QualityGateService } from '../services/quality-gate.service.js';
import type { QualityGateOrchestrator } from '../services/quality-gate-orchestrator.js';
import type { BookImportService } from '../services/book-import.service.js';
import { idParamSchema, paginationParamsSchema, DEFAULT_LIMITS } from '@shared/schemas.js';
import { z } from 'zod';
import { enqueueAutoImport } from '../utils/enqueue-auto-import.js';


type IdParam = z.infer<typeof idParamSchema>;

const activityListQuerySchema = z.object({
  status: z.string().optional(),
  section: z.enum(['queue', 'history']).optional(),
}).merge(paginationParamsSchema);

type ActivityListQuery = z.infer<typeof activityListQuerySchema>;

export async function activityRoutes(app: FastifyInstance, downloadService: DownloadService, downloadOrchestrator: DownloadOrchestrator, qualityGateService: QualityGateService, qualityGateOrchestrator: QualityGateOrchestrator, bookImportService: BookImportService, nudgeImportWorker: () => void) {
  app.get<{ Querystring: ActivityListQuery }>(
    '/api/activity',
    { schema: { querystring: activityListQuerySchema } },
    async (request) => {
      const { status, section, limit, offset } = request.query;
      request.log.debug({ status, section, limit, offset }, 'Fetching activity');
      const pagination = { limit: limit ?? DEFAULT_LIMITS.activity, ...(offset !== undefined && { offset }) };
      const result = await downloadService.getAll(status, pagination, section);

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

  app.get('/api/activity/active', async () => {
    return downloadService.getActive();
  });

  app.get('/api/activity/counts', async (request) => {
    request.log.debug('Fetching activity counts');
    return downloadService.getCounts();
  });

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

  app.delete('/api/activity/history', async (request) => {
    request.log.info('Bulk deleting download history');
    return downloadService.deleteHistory();
  });

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
        case 'already_active':
          // A grab blocker already serves this book; retry is idempotently satisfied.
          return reply.status(200).send({ status: 'already_active' });
        case 'retry_error':
          return reply.status(200).send({ status: 'retry_error' });
      }
    },
  );

  app.post<{ Params: IdParam }>(
    '/api/activity/:id/approve',
    { schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params;

      request.log.info({ id }, 'Download approved');
      const result = await qualityGateOrchestrator.approve(id);

      // An existing import job is a benign race because approval already succeeded.
      if (result.bookId) {
        await enqueueAutoImport(bookImportService, id, result.bookId, nudgeImportWorker, request.log);
      }

      return result;
    },
  );

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
