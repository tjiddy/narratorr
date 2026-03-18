import type { FastifyInstance } from 'fastify';
import type { ProwlarrSyncService } from '../services/prowlarr-sync.service.js';
import {
  prowlarrTestSchema,
  prowlarrConfigSchema,
  prowlarrSyncApplySchema,
  type ProwlarrConfigInput,
  type ProwlarrSyncApplyInput,
} from '../../shared/schemas.js';
import { maskFields, resolveSentinelFields } from '../utils/secret-codec.js';
import { getErrorMessage } from '../utils/error-message.js';

interface TestBody {
  url: string;
  apiKey: string;
}

export async function prowlarrRoutes(
  app: FastifyInstance,
  prowlarrSync: ProwlarrSyncService,
): Promise<void> {
  // Test Prowlarr connection
  app.post<{ Body: TestBody }>(
    '/api/prowlarr/test',
    { schema: { body: prowlarrTestSchema } },
    async (request, reply) => {
      try {
        const result = await prowlarrSync.testConnection(request.body.url, request.body.apiKey);
        return result;
      } catch (error) {
        request.log.error(error, 'Prowlarr connection test failed');
        return reply.status(500).send({
          success: false,
          message: getErrorMessage(error, 'Connection test failed'),
        });
      }
    },
  );

  // Get Prowlarr config
  app.get('/api/prowlarr/config', async (_request, reply) => {
    const config = await prowlarrSync.getConfig();
    if (!config) {
      return reply.status(404).send({ error: 'Prowlarr not configured' });
    }
    return maskFields('prowlarr', { ...config } as Record<string, unknown>);
  });

  // Save Prowlarr config
  app.put<{ Body: ProwlarrConfigInput }>(
    '/api/prowlarr/config',
    { schema: { body: prowlarrConfigSchema } },
    async (request) => {
      const data = { ...request.body };
      const existingConfig = await prowlarrSync.getConfig();
      resolveSentinelFields(data as Record<string, unknown>, existingConfig as Record<string, unknown> | null);

      await prowlarrSync.saveConfig(data);
      request.log.info('Prowlarr config updated');
      return maskFields('prowlarr', { ...data } as Record<string, unknown>);
    },
  );

  // Preview sync (fetch from Prowlarr, diff against local)
  app.post('/api/prowlarr/preview', async (request, reply) => {
    const config = await prowlarrSync.getConfig();
    if (!config) {
      return reply.status(400).send({ error: 'Prowlarr not configured. Save config first.' });
    }

    try {
      const preview = await prowlarrSync.preview(config);
      return preview;
    } catch (error) {
      request.log.error(error, 'Prowlarr preview failed');
      return reply.status(500).send({
        error: getErrorMessage(error, 'Preview failed'),
      });
    }
  });

  // Apply sync (create/update/remove selected indexers)
  app.post<{ Body: ProwlarrSyncApplyInput }>(
    '/api/prowlarr/sync',
    { schema: { body: prowlarrSyncApplySchema } },
    async (request, reply) => {
      const config = await prowlarrSync.getConfig();
      if (!config) {
        return reply.status(400).send({ error: 'Prowlarr not configured' });
      }

      try {
        const result = await prowlarrSync.apply(config, request.body);
        request.log.info(result, 'Prowlarr sync completed');
        return result;
      } catch (error) {
        request.log.error(error, 'Prowlarr sync failed');
        return reply.status(500).send({
          error: getErrorMessage(error, 'Sync failed'),
        });
      }
    },
  );
}
