import { type FastifyInstance } from 'fastify';
import { type z } from 'zod';
import { type DownloadClientService } from '../services';
import { createDownloadClientSchema, updateDownloadClientSchema, idParamSchema, type CreateDownloadClientInput } from '../../shared/schemas.js';
import { registerCrudRoutes } from './crud-routes.js';

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
  app.post<{ Body: CreateDownloadClientInput }>(
    '/api/download-clients/categories',
    { schema: { body: createDownloadClientSchema } },
    async (request) => {
      const data = request.body;
      const result = await downloadClientService.getCategoriesFromConfig({
        type: data.type,
        settings: data.settings,
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
