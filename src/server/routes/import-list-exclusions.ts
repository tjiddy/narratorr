import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { ImportListExclusionService } from '../services';
import { getErrorMessage } from '../utils/error-message.js';
import { idParamSchema, paginationParamsSchema, DEFAULT_LIMITS } from '@shared/schemas.js';
import { serializeError } from '../utils/serialize-error.js';

type IdParam = z.infer<typeof idParamSchema>;

const exclusionListQuerySchema = paginationParamsSchema;
type ExclusionListQuery = z.infer<typeof exclusionListQuerySchema>;

/**
 * List and undo only. Exclusions have exactly one writer — the book-deletion path — so no create
 * endpoint exists and no client-supplied identity contract needs specifying.
 */
export async function importListExclusionsRoutes(
  app: FastifyInstance,
  exclusionService: ImportListExclusionService,
) {
  app.get<{ Querystring: ExclusionListQuery }>(
    '/api/import-list-exclusions',
    { schema: { querystring: exclusionListQuerySchema } },
    async (request) => {
      const { limit, offset } = request.query;
      request.log.debug({ limit, offset }, 'Fetching import list exclusions');
      const pagination = {
        limit: limit ?? DEFAULT_LIMITS.importListExclusions,
        ...(offset !== undefined && { offset }),
      };
      return exclusionService.getAll(pagination);
    },
  );

  app.delete<{ Params: IdParam }>(
    '/api/import-list-exclusions/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const deleted = await exclusionService.delete(id);
        if (!deleted) {
          return await reply.status(404).send({ error: 'Import list exclusion not found' });
        }
        request.log.info({ id }, 'Import list exclusion removed');
        return { success: true };
      } catch (error: unknown) {
        request.log.error({ error: serializeError(error) }, 'Failed to remove import list exclusion');
        return reply.status(500).send({ error: getErrorMessage(error) });
      }
    },
  );
}
