import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BulkOperationService } from '../services/bulk-operation.service.js';
import { BulkOpError } from '../services/bulk-operation.service.js';

const jobIdParamsSchema = z.object({ jobId: z.string() });
type JobIdParams = z.infer<typeof jobIdParamsSchema>;

export async function bulkOperationsRoutes(
  app: FastifyInstance,
  bulkOperationService: BulkOperationService,
): Promise<void> {
  // Count endpoints
  app.get('/api/books/bulk/rename/count', async () => {
    return bulkOperationService.countRenameEligible();
  });

  app.get('/api/books/bulk/retag/count', async () => {
    return bulkOperationService.countRetagEligible();
  });

  app.get('/api/books/bulk/convert/count', async () => {
    return bulkOperationService.countConvertEligible();
  });

  // Active job discovery
  app.get('/api/books/bulk/active', async () => {
    return bulkOperationService.getActiveJob();
  });

  // Start jobs
  app.post('/api/books/bulk/rename', async (request, reply) => {
    try {
      const jobId = await bulkOperationService.startRenameJob();
      return await reply.status(202).send({ jobId });
    } catch (error: unknown) {
      if (error instanceof BulkOpError) {
        if (error.code === 'LIBRARY_NOT_CONFIGURED') return reply.status(400).send({ error: error.message });
        if (error.code === 'BULK_OP_IN_PROGRESS') return reply.status(409).send({ error: error.message });
      }
      request.log.error(error, 'Failed to start bulk rename job');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/api/books/bulk/retag', async (request, reply) => {
    try {
      const jobId = await bulkOperationService.startRetagJob();
      return await reply.status(202).send({ jobId });
    } catch (error: unknown) {
      if (error instanceof BulkOpError) {
        if (error.code === 'BULK_OP_IN_PROGRESS') return reply.status(409).send({ error: error.message });
      }
      request.log.error(error, 'Failed to start bulk retag job');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  app.post('/api/books/bulk/convert', async (request, reply) => {
    try {
      const jobId = await bulkOperationService.startConvertJob();
      return await reply.status(202).send({ jobId });
    } catch (error: unknown) {
      if (error instanceof BulkOpError) {
        if (error.code === 'FFMPEG_NOT_CONFIGURED') return reply.status(503).send({ error: error.message });
        if (error.code === 'BULK_OP_IN_PROGRESS') return reply.status(409).send({ error: error.message });
      }
      request.log.error(error, 'Failed to start bulk convert job');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // Poll job status
  app.get<{ Params: JobIdParams }>(
    '/api/books/bulk/:jobId',
    { schema: { params: jobIdParamsSchema } },
    async (request, reply) => {
      const { jobId } = request.params;
      const status = bulkOperationService.getJob(jobId);
      if (!status) {
        return reply.status(404).send({ error: 'Job not found or expired' });
      }
      return status;
    },
  );
}
