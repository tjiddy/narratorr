import { type FastifyInstance } from 'fastify';
import { type DownloadClientService } from '../services';
import { createDownloadClientSchema, updateDownloadClientSchema } from '../../shared/schemas.js';
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
}
