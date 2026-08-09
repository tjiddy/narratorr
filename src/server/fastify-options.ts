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

export function buildFastifyOptions() {
  return {
    logger: buildLoggerConfig(),
    disableRequestLogging: true,
    trustProxy: config.trustedProxies,
    // Preview tokens exceed Fastify's 100-character default; match the route schema's cap.
    routerOptions: { maxParamLength: 2048 },
  } as const;
}
