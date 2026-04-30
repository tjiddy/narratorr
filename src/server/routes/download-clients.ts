import { type FastifyInstance } from 'fastify';
import { type z } from 'zod';
import { type DownloadClientService } from '../services';
import { createDownloadClientSchema, updateDownloadClientSchema, idParamSchema, type CreateDownloadClientInput } from '../../shared/schemas.js';
import { registerCrudRoutes } from './crud-routes.js';
import { makeTestSchema } from '../utils/secret-codec.js';
import { resolveSentinelSettings } from '../utils/sentinel-resolver.js';

type IdParam = z.infer<typeof idParamSchema>;

export async function downloadClientsRoutes(
  app: FastifyInstance,
  downloadClientService: DownloadClientService,
) {
  await registerCrudRoutes(app, {
    basePath: '/api/download-clients',
    entityName: 'Download client',
    service: downloadClientService,
    createSchema: createDownloadClientSchema,
    updateSchema: updateDownloadClientSchema,
    secretEntity: 'downloadClient',
  });

  // POST /api/download-clients/categories — fetch categories from unsaved config
  // Sentinel-aware: edit-mode forms send masked secrets + id so the route can
  // resolve against the persisted record before dispatching to the adapter.
  const categoriesSchema = makeTestSchema(createDownloadClientSchema, 'downloadClient');
  app.post<{ Body: CreateDownloadClientInput & { id?: number } }>(
    '/api/download-clients/categories',
    { schema: { body: categoriesSchema } },
    async (request, reply) => {
      const data = request.body;
      const resolution = await resolveSentinelSettings({
        entity: 'downloadClient',
        incoming: { ...data.settings },
        id: data.id,
        loadExisting: async () => {
          const row = await downloadClientService.getById(data.id!);
          return row ? (row.settings as Record<string, unknown>) : null;
        },
        notFoundMessage: 'Download client not found',
      });
      if (!resolution.ok) {
        return reply.status(resolution.status).send({ error: resolution.message });
      }
      const result = await downloadClientService.getCategoriesFromConfig({
        type: data.type,
        settings: resolution.settings,
      });
      if (result.error) {
        request.log.warn({ type: data.type, error: result.error }, 'Category fetch from config failed');
      } else {
        request.log.debug({ type: data.type, count: result.categories.length }, 'Categories fetched from config');
      }
      return result;
    },
  );

  // POST /api/download-clients/:id/categories — fetch categories from saved client
  app.post<{ Params: IdParam }>(
    '/api/download-clients/:id/categories',
    { schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params;
      const result = await downloadClientService.getCategories(id);
      if (result.error) {
        request.log.warn({ id, error: result.error }, 'Category fetch failed');
      } else {
        request.log.debug({ id, count: result.categories.length }, 'Categories fetched');
      }
      return result;
    },
  );
}
