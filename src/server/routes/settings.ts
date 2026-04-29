import { z } from 'zod';
import { type FastifyInstance } from 'fastify';
import { type SettingsService, type AppSettings } from '../services';
import { updateSettingsSchema, type UpdateSettingsInput } from '../../shared/schemas.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { HealthCheckService } from '../services/health-check.service.js';
import { maskFields, isSentinel, type SecretEntity } from '../utils/secret-codec.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';


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

/** Mask secret fields in settings categories that contain secrets. */
const SETTINGS_SECRET_MAP: [string, SecretEntity][] = [
  ['prowlarr', 'prowlarr'],
  ['auth', 'auth'],
  ['network', 'network'],
];

function maskSettingsResponse(all: AppSettings): AppSettings {
  const masked = { ...all };
  for (const [key, entity] of SETTINGS_SECRET_MAP) {
    const cat = masked[key as keyof AppSettings];
    if (cat && typeof cat === 'object') {
      (masked as Record<string, unknown>)[key] = maskFields(entity, { ...(cat as Record<string, unknown>) });
    }
  }
  return masked;
}

const ffmpegProbeSchema = z.object({
  path: z.string().trim().min(1, 'Path is required'),
});

const testProxySchema = z.object({
  proxyUrl: z.string().trim().min(1, 'Proxy URL is required').refine((val) => {
    if (isSentinel(val)) return true;
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
  healthCheckService?: HealthCheckService,
) {
  // GET /api/settings
  app.get('/api/settings', async () => {
    const all = await settingsService.getAll();
    return maskSettingsResponse(all);
  });

  // PUT /api/settings
  app.put<{ Body: UpdateSettingsInput }>(
    '/api/settings',
    {
      schema: {
        body: updateSettingsSchema,
      },
    },
    async (request) => {
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
      // so proxy URL changes take effect on next request.
      // Normalize sentinel values before comparison — '********' means "unchanged",
      // so replace sentinels with the previous values to avoid false positives.
      if (previousNetwork && indexerService && data.network) {
        const normalized = { ...data.network } as Record<string, unknown>;
        const prev = previousNetwork as Record<string, unknown>;
        for (const [k, v] of Object.entries(normalized)) {
          if (typeof v === 'string' && isSentinel(v)) {
            normalized[k] = prev[k];
          }
        }
        if (JSON.stringify(normalized) !== JSON.stringify(previousNetwork)) {
          indexerService.clearAdapterCache();
          request.log.info('Indexer adapter cache cleared (network settings changed)');
        }
      }

      request.log.info('Settings updated');

      return maskSettingsResponse(result);
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
        const version = await healthCheckService!.probeFfmpeg(path);
        request.log.info({ version, path }, 'ffmpeg probe successful');
        return { version };
      } catch (error: unknown) {
        request.log.warn({ error: serializeError(error) }, 'ffmpeg probe failed');
        return reply.status(400).send({
          error: getErrorMessage(error),
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
      let { proxyUrl } = request.body;
      if (isSentinel(proxyUrl)) {
        const network = await settingsService.get('network');
        const saved = network && typeof network === 'object'
          ? (network as { proxyUrl?: string | null }).proxyUrl
          : null;
        if (!saved) {
          return reply.status(400).send({ error: 'No saved proxy URL to test' });
        }
        proxyUrl = saved;
      }
      try {
        const ip = await healthCheckService!.probeProxy(proxyUrl);
        request.log.info({ ip, proxyUrl: redactProxyUrl(proxyUrl) }, 'Proxy test successful');
        return { success: true, ip };
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        request.log.warn({ error: serializeError(error), proxyUrl: redactProxyUrl(proxyUrl) }, 'Proxy test failed');
        return reply.status(200).send({ success: false, message });
      }
    }
  );
}
