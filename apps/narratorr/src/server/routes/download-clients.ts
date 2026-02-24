import { type FastifyInstance } from 'fastify';
import { type DownloadClientService } from '../services';
import { createDownloadClientSchema, updateDownloadClientSchema, idParamSchema } from '../../shared/schemas.js';
import { registerCrudRoutes } from './crud-routes.js';

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
  });

  // POST /api/download-clients/categories — fetch categories from unsaved config
  app.post(
    '/api/download-clients/categories',
    { schema: { body: createDownloadClientSchema } },
    async (request, reply) => {
      try {
        const data = request.body as { type: string; settings: Record<string, unknown> };
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
      } catch (error) {
        request.log.error(error, 'Category fetch from config error');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // POST /api/download-clients/:id/categories — fetch categories from saved client
  app.post(
    '/api/download-clients/:id/categories',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: number };
        const result = await downloadClientService.getCategories(id);
        if (result.error) {
          request.log.warn({ id, error: result.error }, 'Category fetch failed');
        } else {
          request.log.debug({ id, count: result.categories.length }, 'Categories fetched');
        }
        return result;
      } catch (error) {
        request.log.error(error, 'Category fetch error');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );
}
