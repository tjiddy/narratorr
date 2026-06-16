import { z } from 'zod';
import { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import { type SettingsService, type AppSettings } from '../services';
import { updateSettingsSchema, type UpdateSettingsInput } from '../../shared/schemas.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { HealthCheckService } from '../services/health-check.service.js';
import { maskFields, isSentinel, type SecretEntity } from '../utils/secret-codec.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import { HardcoverClient } from '../../core/metadata/hardcover.js';
import { mapHardcoverError } from '../utils/hardcover-error.js';
import { fetchWithTimeout } from '../../core/utils/network-service.js';


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
  ['metadata', 'metadata'],
  ['earwitness', 'earwitness'],
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

const testHardcoverSchema = z.object({
  apiKey: z.string().optional(),
});

// earwitness Test-Connection probe contract (see issue #1526):
// GET <baseUrl>/api/v1/health with `X-Api-Key`, 5s timeout. baseUrl is NOT a
// secret, so the body must carry a real URL (the sentinel '********' fails URL
// validation → 400); apiKey is optional and resolves against the stored value.
const EARWITNESS_HEALTH_PATH = '/api/v1/health';
const EARWITNESS_PROBE_TIMEOUT_MS = 5000;

const testEarwitnessSchema = z.object({
  baseUrl: z.string().trim().min(1, 'Base URL is required').refine((val) => {
    try {
      return ['http:', 'https:'].includes(new URL(val).protocol);
    } catch {
      return false;
    }
  }, { message: 'Must be a valid http(s) URL' }),
  apiKey: z.string().optional(),
});

interface EarwitnessProbeResult {
  success: boolean;
  message?: string;
}

/**
 * Probe GET <baseUrl>/api/v1/health with the X-Api-Key header per the #1526
 * Test-Connection contract. Returns a plain result object (the route maps it to
 * the HTTP 200 envelope) so all expected failures stay non-throwing.
 */
async function probeEarwitness(
  baseUrl: string,
  apiKey: string,
  log: FastifyBaseLogger,
): Promise<EarwitnessProbeResult> {
  // String join (not new URL(path, base)) so a pathful baseUrl like
  // https://host/earwitness/ keeps its prefix → .../earwitness/api/v1/health.
  const url = baseUrl.replace(/\/+$/, '') + EARWITNESS_HEALTH_PATH;
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { 'X-Api-Key': apiKey } },
      EARWITNESS_PROBE_TIMEOUT_MS,
    );
    if (res.status >= 200 && res.status < 300) {
      return { success: true };
    }
    if (res.status === 401 || res.status === 403) {
      return { success: false, message: 'Invalid API key' };
    }
    log.debug({ status: res.status }, 'earwitness health probe returned non-2xx');
    return { success: false, message: 'Unable to reach server' };
  } catch (error: unknown) {
    log.debug({ error: serializeError(error) }, 'earwitness health probe failed');
    return { success: false, message: 'Unable to reach server' };
  }
}

/**
 * Resolve the apiKey to probe with: a real input key is used as-is; an omitted,
 * empty, or sentinel key falls back to the stored (decrypted) earwitness key so
 * Test works without re-entering the masked credential. Returns null when no
 * usable key exists (the route maps that to HTTP 400).
 */
async function resolveEarwitnessApiKey(
  settingsService: SettingsService,
  inputKey: string | undefined,
): Promise<string | null> {
  const useFallback =
    inputKey === undefined || inputKey.trim().length === 0 || isSentinel(inputKey);
  if (!useFallback) return inputKey;
  const earwitness = await settingsService.get('earwitness');
  const stored = earwitness && typeof earwitness === 'object'
    ? (earwitness as { apiKey?: string | null }).apiKey ?? ''
    : '';
  return stored.trim().length === 0 ? null : stored;
}

// POST /api/settings/earwitness/test
// Probes GET <baseUrl>/api/v1/health with the X-Api-Key header per the
// Test-Connection probe contract. Always returns an HTTP 200 envelope:
// expected failures (bad key, unreachable host) are { success: false, message }
// rather than 4xx/5xx, mirroring the proxy/Hardcover test handlers.
function registerEarwitnessTestRoute(app: FastifyInstance, settingsService: SettingsService): void {
  app.post<{ Body: z.infer<typeof testEarwitnessSchema> }>(
    '/api/settings/earwitness/test',
    { schema: { body: testEarwitnessSchema } },
    async (request, reply) => {
      const resolvedKey = await resolveEarwitnessApiKey(settingsService, request.body.apiKey);
      if (resolvedKey === null) {
        return reply.status(400).send({ success: false, message: 'No earwitness API key configured.' });
      }
      const result = await probeEarwitness(request.body.baseUrl, resolvedKey, request.log);
      if (result.success) {
        request.log.info('earwitness connection test successful');
      }
      return result;
    },
  );
}

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

  // POST /api/settings/metadata/hardcover/test
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

  registerEarwitnessTestRoute(app, settingsService);
}
