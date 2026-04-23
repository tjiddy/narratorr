import { type FastifyInstance } from 'fastify';
import type { ImportListService } from '../services/import-list.service.js';
import { createImportListSchema, updateImportListSchema, previewImportListSchema } from '../../shared/schemas.js';
import { registerCrudRoutes } from './crud-routes.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';


export async function importListsRoutes(app: FastifyInstance, importListService: ImportListService) {
  await registerCrudRoutes(app, {
    basePath: '/api/import-lists',
    entityName: 'Import list',
    service: importListService,
    createSchema: createImportListSchema,
    updateSchema: updateImportListSchema,
    secretEntity: 'importList',
  });

  // POST /api/import-lists/abs/libraries — fetch ABS libraries for selection
  app.post<{ Body: { serverUrl: string; apiKey: string } }>(
    '/api/import-lists/abs/libraries',
    async (request, reply) => {
      const { serverUrl, apiKey } = request.body;
      if (!serverUrl || !apiKey) {
        return reply.status(400).send({ error: 'serverUrl and apiKey are required' });
      }
      try {
        const url = `${serverUrl.replace(/\/+$/, '')}/api/libraries`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) {
          return await reply.status(502).send({ error: `ABS API returned ${res.status}` });
        }
        const data = await res.json() as { libraries?: Array<{ id: string; name: string }> };
        return { libraries: data.libraries ?? [] };
      } catch (error: unknown) {
        return reply.status(502).send({
          error: `Connection failed: ${getErrorMessage(error)}`,
        });
      }
    },
  );

  // POST /api/import-lists/preview — preview items from unsaved config
  app.post<{ Body: { type: string; settings: Record<string, unknown> } }>(
    '/api/import-lists/preview',
    { schema: { body: previewImportListSchema } },
    async (request, reply) => {
      try {
        const { type, settings } = request.body;
        const result = await importListService.preview({ type, settings: settings as Record<string, unknown> });
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
