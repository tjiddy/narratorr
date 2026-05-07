import { config } from './config.js';

function buildLoggerConfig(): { level: string } | { level: string; transport: { target: string; options: Record<string, unknown> } } {
  if (!config.isDev) return { level: config.logLevel };
  try {
    import.meta.resolve('pino-pretty');
    return {
      level: config.logLevel,
      transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    };
  } catch {
    return { level: config.logLevel };
  }
}

/**
 * Fastify constructor options for the production server. Exported so a unit test
 * can verify that `routerOptions.maxParamLength` is bumped above the framework's
 * 100-char default — preview tokens are base64url(JSON payload) + '.' + base64url(HMAC sig),
 * typically 200-300 chars, and would silently 404 at the default cap.
 */
export function buildFastifyOptions() {
  return {
    logger: buildLoggerConfig(),
    disableRequestLogging: true,
    trustProxy: config.trustedProxies,
    // Audio-preview tokens are base64url(JSON payload) + '.' + base64url(HMAC sig) —
    // typically 200-300 chars. Fastify's default 100-char path-param cap rejects them
    // with a "route not found" 404. 2048 matches the Zod params-schema cap on the route.
    routerOptions: { maxParamLength: 2048 },
  } as const;
}
