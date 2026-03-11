import type { FastifyInstance } from 'fastify';
import type { ProwlarrSyncService } from '../services/prowlarr-sync.service.js';
import {
  prowlarrTestSchema,
  prowlarrConfigSchema,
  prowlarrSyncApplySchema,
  type ProwlarrConfigInput,
  type ProwlarrSyncApplyInput,
} from '../../shared/schemas.js';
import { maskFields, isSentinel } from '../utils/secret-codec.js';

interface TestBody {
  url: string;
  apiKey: string;
}

export async function prowlarrRoutes(
  app: FastifyInstance,
  prowlarrSync: ProwlarrSyncService,
): Promise<void> {
  // Test Prowlarr connection
  app.post<{ Body: TestBody }>('/api/prowlarr/test', async (request, reply) => {
    const parsed = prowlarrTestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid input' });
    }

    try {
      const result = await prowlarrSync.testConnection(parsed.data.url, parsed.data.apiKey);
      return result;
    } catch (error) {
      request.log.error(error, 'Prowlarr connection test failed');
      return reply.status(500).send({
        success: false,
        message: error instanceof Error ? error.message : 'Connection test failed',
      });
    }
  });

  // Get Prowlarr config
  app.get('/api/prowlarr/config', async (_request, reply) => {
    const config = await prowlarrSync.getConfig();
    if (!config) {
      return reply.status(404).send({ error: 'Prowlarr not configured' });
    }
    return maskFields('prowlarr', { ...config } as Record<string, unknown>);
  });

  // Save Prowlarr config
  app.put<{ Body: ProwlarrConfigInput }>('/api/prowlarr/config', async (request, reply) => {
    const parsed = prowlarrConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid input' });
    }

    // Sentinel passthrough: if apiKey is '********', preserve existing encrypted value
    const data = { ...parsed.data };
    if (isSentinel(data.apiKey)) {
      const existing = await prowlarrSync.getConfig();
      if (existing) {
        data.apiKey = existing.apiKey; // Already-decrypted value from getConfig
      }
    }

    await prowlarrSync.saveConfig(data);
    request.log.info('Prowlarr config updated');
    return maskFields('prowlarr', { ...data } as Record<string, unknown>);
  });

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
        error: error instanceof Error ? error.message : 'Preview failed',
      });
    }
  });

  // Apply sync (create/update/remove selected indexers)
  app.post<{ Body: ProwlarrSyncApplyInput }>('/api/prowlarr/sync', async (request, reply) => {
    const parsed = prowlarrSyncApplySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid input' });
    }

    const config = await prowlarrSync.getConfig();
    if (!config) {
      return reply.status(400).send({ error: 'Prowlarr not configured' });
    }

    try {
      const result = await prowlarrSync.apply(config, parsed.data);
      request.log.info(result, 'Prowlarr sync completed');
      return result;
    } catch (error) {
      request.log.error(error, 'Prowlarr sync failed');
      return reply.status(500).send({
        error: error instanceof Error ? error.message : 'Sync failed',
      });
    }
  });
}
