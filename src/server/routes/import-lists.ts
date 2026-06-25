import { type FastifyInstance } from 'fastify';
import type { ImportListService } from '../services/import-list.service.js';
import { createImportListSchema, updateImportListSchema, previewImportListSchema } from '../../shared/schemas.js';
import { registerCrudRoutes } from './crud-routes.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import { makeTestSchema } from '../utils/secret-codec.js';
import { resolveSentinelSettings } from '../utils/sentinel-resolver.js';

export async function importListsRoutes(app: FastifyInstance, importListService: ImportListService) {
  await registerCrudRoutes(app, {
    basePath: '/api/import-lists',
    entityName: 'Import list',
    service: importListService,
    createSchema: createImportListSchema,
    updateSchema: updateImportListSchema,
    secretEntity: 'importList',
  });

  // POST /api/import-lists/preview — preview items from unsaved config
  // Sentinel-aware: edit-mode forms send masked apiKey + id so the route can
  // resolve against the persisted record before dispatching to the provider.
  const previewSchema = makeTestSchema(previewImportListSchema, 'importList');
  app.post<{ Body: { type: string; settings: Record<string, unknown>; id?: number } }>(
    '/api/import-lists/preview',
    { schema: { body: previewSchema } },
    async (request, reply) => {
      const { type, settings, id } = request.body;
      const resolution = await resolveSentinelSettings({
        entity: 'importList',
        incoming: { ...settings },
        id,
        loadExisting: async () => {
          const row = await importListService.getById(id!);
          return row ? (row.settings as Record<string, unknown>) : null;
        },
        notFoundMessage: 'Import list not found',
      });
      if (!resolution.ok) {
        return reply.status(resolution.status).send({ error: resolution.message });
      }
      try {
        const result = await importListService.preview({ type, settings: resolution.settings });
        return result;
      } catch (error: unknown) {
        request.log.error({ error: serializeError(error) }, 'Import list preview failed');
        return reply.status(500).send({
          error: getErrorMessage(error),
        });
      }
    },
  );
}
