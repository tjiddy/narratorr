import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RecyclingBinError } from '../services/recycling-bin.service.js';
import type { RecyclingBinService } from '../services/recycling-bin.service.js';

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export async function recyclingBinRoutes(app: FastifyInstance, recyclingBinService: RecyclingBinService) {
  // GET /api/system/recycling-bin — list all entries
  app.get('/api/system/recycling-bin', async () => {
    return recyclingBinService.list();
  });

  // POST /api/system/recycling-bin/:id/restore — restore an entry
  app.post<{ Params: { id: number } }>(
    '/api/system/recycling-bin/:id/restore',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      try {
        const result = await recyclingBinService.restore(request.params.id);
        return result;
      } catch (error) {
        if (error instanceof RecyclingBinError) {
          const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : 500;
          return reply.status(status).send({ error: error.message });
        }
        request.log.error(error, 'Failed to restore recycling bin entry');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // DELETE /api/system/recycling-bin/:id — permanently delete an entry
  app.delete<{ Params: { id: number } }>(
    '/api/system/recycling-bin/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const deleted = await recyclingBinService.purge(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Recycling bin entry not found' });
      }
      return reply.status(204).send();
    },
  );

  // POST /api/system/recycling-bin/empty — purge all entries
  app.post('/api/system/recycling-bin/empty', async () => {
    return recyclingBinService.purgeAll();
  });
}
