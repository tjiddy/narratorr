import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { BlacklistService } from '../services';
import type { SettingsService } from '../services/settings.service.js';
import {
  idParamSchema,
  paginationParamsSchema,
  createBlacklistSchema,
  toggleBlacklistTypeSchema,
  type CreateBlacklistInput,
} from '../../shared/schemas.js';

type IdParam = z.infer<typeof idParamSchema>;
type ToggleBody = z.infer<typeof toggleBlacklistTypeSchema>;

const blacklistListQuerySchema = paginationParamsSchema;
type BlacklistListQuery = z.infer<typeof blacklistListQuerySchema>;

export async function blacklistRoutes(app: FastifyInstance, blacklistService: BlacklistService, _settingsService?: SettingsService) {
  // GET /api/blacklist
  app.get<{ Querystring: BlacklistListQuery }>(
    '/api/blacklist',
    { schema: { querystring: blacklistListQuerySchema } },
    async (request) => {
      const { limit, offset } = request.query;
      request.log.debug({ limit, offset }, 'Fetching blacklist');
      const pagination = limit !== undefined || offset !== undefined ? { limit, offset } : undefined;
      return blacklistService.getAll(pagination);
    },
  );

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

  // PATCH /api/blacklist/:id — toggle temporary/permanent
  app.patch<{ Params: IdParam; Body: ToggleBody }>(
    '/api/blacklist/:id',
    {
      schema: { params: idParamSchema, body: toggleBlacklistTypeSchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { blacklistType } = request.body;

      try {
        const updated = await blacklistService.toggleType(id, blacklistType);
        if (!updated) {
          return await reply.status(404).send({ error: 'Blacklist entry not found' });
        }
        return updated;
      } catch (error) {
        request.log.error(error, 'Failed to toggle blacklist type');
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
