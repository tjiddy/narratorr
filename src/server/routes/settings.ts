import { z } from 'zod';
import { type FastifyInstance } from 'fastify';
import { type SettingsService, type AppSettings } from '../services';
import { updateSettingsSchema, apiErrorResponseSchema, type UpdateSettingsInput } from '@shared/schemas.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { HealthCheckService } from '../services/health-check.service.js';
import { maskFields, isSentinel } from '../utils/secret-codec.js';
import { SETTINGS_SECRET_MAP } from '../utils/secret-category-map.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import { HardcoverClient } from '@core/metadata/hardcover.js';
import { mapHardcoverError } from '../utils/hardcover-error.js';
import { resolveFfmpegPath, probeFfmpeg } from '@core/utils/audio-processor.js';
import { resolveMutagenDetection, probeMutagen } from '@core/utils/mutagen-resolver.js';
import { triggerCompanionSweep, type CompanionSweepTrigger } from '../services/companion-ebook-trigger.js';
import {
  snapshotCompanionSettings,
  companionSettingsChangeFired,
  recoverCompanionSettingsChange,
} from '../services/companion-ebook-settings-trigger.js';


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

const testHardcoverSchema = z.object({
  apiKey: z.string().optional(),
});

export async function settingsRoutes(
  app: FastifyInstance,
  settingsService: SettingsService,
  indexerService?: IndexerService,
  healthCheckService?: HealthCheckService,
  companionEbook?: CompanionSweepTrigger,
) {
  app.get('/api/settings', async () => {
    const all = await settingsService.getAll();
    return maskSettingsResponse(all);
  });

  app.put<{ Body: UpdateSettingsInput }>(
    '/api/settings',
    {
      schema: {
        body: updateSettingsSchema,
        // Pins the root-gate refusal body; without it the 409 serializes through Fastify's default
        // and nothing fails when the shape drifts.
        response: { 409: apiErrorResponseSchema },
      },
    },
    async (request) => {
      const data = request.body;

      const previousNetwork = data.network && indexerService
        ? await settingsService.get('network')
        : undefined;

      // Updates are nontransactional; a later category can fail after companion settings persist.
      const companionBefore = await snapshotCompanionSettings(settingsService, data);
      const sweep = (): void => triggerCompanionSweep(
        companionEbook, request.log, 'Companion ebook sweep failed after settings update',
      );

      let result: AppSettings;
      try {
        result = await settingsService.update(data);
      } catch (error: unknown) {
        // Recovery must not replace the original settings error.
        if (await recoverCompanionSettingsChange(settingsService, companionBefore, request.log)) sweep();
        throw error;
      }
      if (companionSettingsChangeFired(companionBefore, result)) sweep();

      if (data.general?.logLevel) {
        app.log.level = data.general.logLevel;
        app.log.info({ level: data.general.logLevel }, 'Log level changed');
      }

      // Normalize masked secrets so unchanged credentials do not clear the adapter cache.
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

  // Display status probes the binary; service gates only resolve its stable container path.
  app.get('/api/settings/ffmpeg-status', async (request) => {
    const path = await resolveFfmpegPath();
    if (!path) return { detected: false };
    try {
      const version = await probeFfmpeg(path);
      return { detected: true, version, path };
    } catch (error: unknown) {
      request.log.warn({ error: serializeError(error) }, 'ffmpeg detected but failed to probe');
      return { detected: false };
    }
  });

  // Tag embedding gates on mutagen, not ffmpeg — the two rows in Post Processing now report
  // different binaries, which is the intended end state (#2210 D5/D8).
  app.get('/api/settings/mutagen-status', async (request) => {
    const detection = await resolveMutagenDetection();
    if (!detection) return { detected: false };
    try {
      const version = await probeMutagen(detection.python);
      return { detected: true, version, path: detection.python };
    } catch (error: unknown) {
      request.log.warn({ error: serializeError(error) }, 'mutagen detected but failed to probe');
      return { detected: false };
    }
  });

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

  app.post<{ Body: z.infer<typeof testHardcoverSchema> }>(
    '/api/settings/metadata/hardcover/test',
    {
      schema: {
        body: testHardcoverSchema,
      },
    },
    async (request, reply) => {
      const inputKey = request.body.apiKey;
      const useFallback =
        inputKey === undefined ||
        inputKey.trim().length === 0 ||
        isSentinel(inputKey);

      let resolvedKey: string;
      if (useFallback) {
        const metadata = await settingsService.get('metadata');
        const stored = metadata && typeof metadata === 'object'
          ? (metadata as { hardcoverApiKey?: string | null }).hardcoverApiKey ?? ''
          : '';
        if (stored.trim().length === 0) {
          return reply.status(400).send({ success: false, message: 'No Hardcover API key configured.' });
        }
        resolvedKey = stored;
      } else {
        resolvedKey = inputKey;
      }

      try {
        const client = new HardcoverClient(resolvedKey);
        await client.searchSeries('test');
        request.log.info('Hardcover API key test successful');
        return { success: true, message: 'Connected.' };
      } catch (error: unknown) {
        const message = mapHardcoverError(error);
        request.log.warn({ error: serializeError(error) }, 'Hardcover API key test failed');
        return reply.status(200).send({ success: false, message });
      }
    }
  );
}
