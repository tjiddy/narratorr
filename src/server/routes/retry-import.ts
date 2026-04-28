import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BookService } from '../services/book.service.js';

const paramsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export async function retryImportRoute(
  app: FastifyInstance,
  bookService: BookService,
  nudgeImportWorker: () => void,
): Promise<void> {
  app.get<{ Params: z.infer<typeof paramsSchema> }>(
    '/api/books/:id/retry-import',
    { schema: { params: paramsSchema } },
    async (request) => {
      const result = await bookService.getRetryAvailability(request.params.id);
      return { available: result.retryable };
    },
  );

  app.post<{ Params: z.infer<typeof paramsSchema> }>(
    '/api/books/:id/retry-import',
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const result = await bookService.retryImport(request.params.id, nudgeImportWorker);
      if ('error' in result) {
        return reply.status(result.status).send({ error: result.error });
      }
      return reply.status(202).send({ jobId: result.jobId });
    },
  );
}
