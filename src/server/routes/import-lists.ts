import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ImportListService } from '../services/import-list.service.js';
import { createImportListSchema, updateImportListSchema, previewImportListSchema } from '../../shared/schemas.js';
import { registerCrudRoutes } from './crud-routes.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import { makeTestSchema } from '../utils/secret-codec.js';
import { resolveSentinelSettings } from '../utils/sentinel-resolver.js';
import { sanitizeLogUrl } from '../utils/sanitize-log-url.js';
import { absLibrariesResponseSchema } from '../../core/import-lists/abs-provider.js';
import { formatZodError } from '../../core/import-lists/format-zod-error.js';
import { fetchWithTimeout } from '../../core/utils/network-service.js';
import { IMPORT_LIST_TIMEOUT_MS } from '../../core/utils/constants.js';

const SENTINEL = '********';

// `apiKey` accepts the masked sentinel so edit-mode forms can re-submit
// without re-entering the saved key. The route preflight resolves it against
// the persisted record before forwarding to ABS. `serverUrl` also unions the
// sentinel — not because we resolve it (it's not a secret), but so the
// resolver consistently rejects sentinel-on-non-secret with HTTP 400 instead
// of letting Zod's URL validator emit a less-specific 400.
const absLibrariesBodySchema = z.object({
  serverUrl: z.union([z.literal(SENTINEL), z.string().trim().url()]),
  apiKey: z.union([z.literal(SENTINEL), z.string().trim().min(1)]),
  id: z.number().int().positive().optional(),
}).strict();

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
  app.post<{ Body: z.infer<typeof absLibrariesBodySchema> }>(
    '/api/import-lists/abs/libraries',
    { schema: { body: absLibrariesBodySchema } },
    async (request, reply) => {
      const { serverUrl, apiKey, id } = request.body;
      const resolution = await resolveSentinelSettings({
        entity: 'importList',
        incoming: { serverUrl, apiKey },
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
      const resolvedApiKey = resolution.settings.apiKey as string;
      const resolvedServerUrl = resolution.settings.serverUrl as string;
      const logUrl = sanitizeLogUrl(resolvedServerUrl);
      try {
        const url = `${resolvedServerUrl.replace(/\/+$/, '')}/api/libraries`;
        const res = await fetchWithTimeout(url, {
          headers: { Authorization: `Bearer ${resolvedApiKey}` },
        }, IMPORT_LIST_TIMEOUT_MS);
        if (!res.ok) {
          request.log.warn(
            { url: logUrl, status: res.status, error: serializeError(new Error(`ABS API returned ${res.status}`)) },
            'ABS library fetch failed (non-OK status)',
          );
          return await reply.status(502).send({ error: `ABS API returned ${res.status}` });
        }
        let raw: unknown;
        try {
          raw = await res.json();
        } catch (error: unknown) {
          request.log.warn(
            { url: logUrl, error: serializeError(error) },
            'ABS library fetch returned non-JSON body',
          );
          return await reply.status(502).send({
            error: 'ABS returned a non-JSON response (check reverse-proxy/auth configuration)',
          });
        }
        const parsed = absLibrariesResponseSchema.safeParse(raw);
        if (!parsed.success) {
          request.log.warn(
            { url: logUrl, error: serializeError(parsed.error) },
            'ABS library fetch failed schema validation',
          );
          return await reply.status(502).send({
            error: `ABS API returned an unexpected response: ${formatZodError(parsed.error)}`,
          });
        }
        return { libraries: parsed.data.libraries };
      } catch (error: unknown) {
        request.log.warn(
          { url: logUrl, error: serializeError(error) },
          'ABS library fetch failed (transport)',
        );
        return reply.status(502).send({
          error: `Connection failed: ${getErrorMessage(error)}`,
        });
      }
    },
  );

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
