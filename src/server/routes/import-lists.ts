import { type FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { ImportListService } from '../services/import-list.service.js';
import type { TaskRegistry } from '../services/task-registry.js';
import { createImportListSchema, updateImportListSchema, previewImportListSchema, idParamSchema } from '@shared/schemas.js';
import { registerCrudRoutes } from './crud-routes.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import { makeTestSchema } from '../utils/secret-codec.js';
import { resolveSentinelSettings } from '../utils/sentinel-resolver.js';

type IdParam = z.infer<typeof idParamSchema>;

export async function importListsRoutes(
  app: FastifyInstance,
  importListService: ImportListService,
  taskRegistry: TaskRegistry,
) {
  await registerCrudRoutes(app, {
    basePath: '/api/import-lists',
    entityName: 'Import list',
    service: importListService,
    createSchema: createImportListSchema,
    updateSchema: updateImportListSchema,
    secretEntity: 'importList',
  });

  // The cron cycle and every manual run share one admission flag, so a refusal arrives here as
  // `TaskRegistryError`/`ALREADY_RUNNING`; the error-handler plugin maps it to 409. Catching
  // anything here would swallow that.
  app.post<{ Params: IdParam }>(
    '/api/import-lists/:id/run',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const outcome = await taskRegistry.runExclusive('import-list-sync', () => importListService.runNow(id));
      if (!outcome) return reply.status(404).send({ error: 'Import list not found' });
      if (outcome.status === 'failed') return { success: false, message: outcome.message };
      return { success: true, ...outcome.counts };
    },
  );

  // Resolve edit-mode masked secrets before provider dispatch.
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
