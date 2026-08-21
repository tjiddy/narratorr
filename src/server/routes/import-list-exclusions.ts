import type { FastifyInstance } from 'fastify';
import { type z } from 'zod';
import type { ImportListExclusionService } from '../services';
import { getErrorMessage } from '../utils/error-message.js';
import { idParamSchema, paginationParamsSchema, importListExclusionKindSchema, DEFAULT_LIMITS } from '@shared/schemas.js';
import { serializeError } from '../utils/serialize-error.js';

type IdParam = z.infer<typeof idParamSchema>;

/**
 * The FILTER vocabulary, reusing the shared enum so the two cannot drift. It is deliberately not
 * the storage guard: no route writes a `kind`, so the persisted value's integrity lives at the
 * service write boundary instead.
 */
const exclusionListQuerySchema = paginationParamsSchema.extend({
  kind: importListExclusionKindSchema.optional(),
});
type ExclusionListQuery = z.infer<typeof exclusionListQuerySchema>;

/**
 * List and undo only. Every exclusion writer is a service, so no create endpoint exists and no
 * client-supplied identity contract needs specifying.
 */
export async function importListExclusionsRoutes(
  app: FastifyInstance,
  exclusionService: ImportListExclusionService,
) {
  app.get<{ Querystring: ExclusionListQuery }>(
    '/api/import-list-exclusions',
    { schema: { querystring: exclusionListQuerySchema } },
    async (request) => {
      const { limit, offset, kind } = request.query;
      request.log.debug({ limit, offset, kind }, 'Fetching import list exclusions');
      const pagination = {
        limit: limit ?? DEFAULT_LIMITS.importListExclusions,
        ...(offset !== undefined && { offset }),
        ...(kind !== undefined && { kind }),
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
