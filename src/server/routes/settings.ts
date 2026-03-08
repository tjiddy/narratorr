import { z } from 'zod';
import { type FastifyInstance } from 'fastify';
import { probeFfmpeg } from '../../core/utils/audio-processor.js';
import { type SettingsService, type AppSettings } from '../services';
import { updateSettingsSchema } from '../../shared/schemas.js';
import type { IndexerService } from '../services/indexer.service.js';
import { resolveProxyIp } from '../../core/indexers/proxy.js';

function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

const ffmpegProbeSchema = z.object({
  path: z.string().min(1, 'Path is required'),
});

const testProxySchema = z.object({
  proxyUrl: z.string().min(1, 'Proxy URL is required').refine((val) => {
    try {
      const url = new URL(val);
      return ['http:', 'https:', 'socks5:'].includes(url.protocol);
    } catch {
      return false;
    }
  }, { message: 'Must be a valid URL with http, https, or socks5 scheme' }),
});

export async function settingsRoutes(
  app: FastifyInstance,
  settingsService: SettingsService,
  indexerService?: IndexerService,
) {
  // GET /api/settings
  app.get('/api/settings', async (request, reply) => {
    try {
      return await settingsService.getAll();
    } catch (error) {
      request.log.error(error, 'Failed to fetch settings');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // PUT /api/settings
  app.put<{ Body: Partial<AppSettings> }>(
    '/api/settings',
    {
      schema: {
        body: updateSettingsSchema,
      },
    },
    async (request, reply) => {
      try {
        const data = request.body;

        // Snapshot current network settings before update to detect actual changes
        const previousNetwork = data.network && indexerService
          ? await settingsService.get('network')
          : undefined;

        const result = await settingsService.update(data);

        // Apply log level change at runtime
        if (data.general?.logLevel) {
          app.log.level = data.general.logLevel;
          app.log.info({ level: data.general.logLevel }, 'Log level changed');
        }

        // Clear indexer adapter cache only when network settings actually changed
        // so proxy URL changes take effect on next request
        if (previousNetwork && indexerService &&
            JSON.stringify(data.network) !== JSON.stringify(previousNetwork)) {
          indexerService.clearAdapterCache();
          request.log.info('Indexer adapter cache cleared (network settings changed)');
        }

        request.log.info('Settings updated');

        return result;
      } catch (error) {
        request.log.error(error, 'Failed to update settings');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // POST /api/settings/ffmpeg-probe
  app.post<{ Body: z.infer<typeof ffmpegProbeSchema> }>(
    '/api/settings/ffmpeg-probe',
    {
      schema: {
        body: ffmpegProbeSchema,
      },
    },
    async (request, reply) => {
      try {
        const { path } = request.body;
        const version = await probeFfmpeg(path);
        request.log.info({ version, path }, 'ffmpeg probe successful');
        return { version };
      } catch (error) {
        request.log.warn({ error }, 'ffmpeg probe failed');
        return reply.status(400).send({
          error: error instanceof Error ? error.message : 'ffmpeg probe failed',
        });
      }
    }
  );

  // POST /api/settings/test-proxy
  app.post<{ Body: z.infer<typeof testProxySchema> }>(
    '/api/settings/test-proxy',
    {
      schema: {
        body: testProxySchema,
      },
    },
    async (request, reply) => {
      try {
        const { proxyUrl } = request.body;
        const ip = await resolveProxyIp(proxyUrl);
        request.log.info({ ip, proxyUrl: redactProxyUrl(proxyUrl) }, 'Proxy test successful');
        return { success: true, ip };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Proxy test failed';
        request.log.warn({ error, proxyUrl: redactProxyUrl(request.body.proxyUrl) }, 'Proxy test failed');
        return reply.status(200).send({ success: false, message });
      }
    }
  );
}
