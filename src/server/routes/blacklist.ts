import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { BlacklistService } from '../services';
import {
  idParamSchema,
  createBlacklistSchema,
  type CreateBlacklistInput,
} from '../../shared/schemas.js';

type IdParam = z.infer<typeof idParamSchema>;

export async function blacklistRoutes(app: FastifyInstance, blacklistService: BlacklistService) {
  // GET /api/blacklist
  app.get('/api/blacklist', async (request) => {
    request.log.debug('Fetching blacklist');
    return blacklistService.getAll();
  });

  // POST /api/blacklist
  app.post<{ Body: CreateBlacklistInput }>(
    '/api/blacklist',
    {
      schema: { body: createBlacklistSchema },
    },
    async (request, reply) => {
      const data = request.body;
      try {
        const entry = await blacklistService.create(data);
        return await reply.status(201).send(entry);
      } catch (error) {
        request.log.error(error, 'Failed to add to blacklist');
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    },
  );

  // DELETE /api/blacklist/:id
  app.delete<{ Params: IdParam }>(
    '/api/blacklist/:id',
    {
      schema: { params: idParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const deleted = await blacklistService.delete(id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Blacklist entry not found' });
      }
      request.log.info({ id }, 'Blacklist entry removed');
      return { success: true };
    },
  );
}
