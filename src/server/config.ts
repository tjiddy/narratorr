import { z } from 'zod';

const envSchema = z.object({
  PORT: z
    .string()
    .default('3000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(1).max(65535)),
  NODE_ENV: z.string().default(''),
  CORS_ORIGIN: z.string().default('http://localhost:5173').transform((v) => v || 'http://localhost:5173'),
  CONFIG_PATH: z.string().default('./config').transform((v) => v || './config'),
  DATABASE_URL: z
    .string()
    .default('./config/narratorr.db')
    .transform((v) => v || './config/narratorr.db')
    .transform((v) => (v.startsWith('file:') ? v.slice(5) : v)),
  AUTH_BYPASS: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
  URL_BASE: z
    .string()
    .default('/')
    .transform((v) => {
      // Normalize empty string to /
      if (!v || v === '/') return '/';
      // Strip trailing slash
      return v.endsWith('/') ? v.slice(0, -1) : v;
    }),
  // Monitor poll cadence. Default is 30s (production). E2E harness overrides to '*/2 * * * * *' so
  // the test doesn't spend 30 seconds of every run waiting for one poll cycle.
  MONITOR_INTERVAL_CRON: z
    .string()
    .default('*/30 * * * * *')
    .transform((v) => v || '*/30 * * * * *'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const portError = parsed.error.issues.find((i) => i.path[0] === 'PORT');
  if (portError) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }
  throw new Error(`Invalid environment config: ${parsed.error.message}`);
}

// Validate URL_BASE format after transform (must start with / unless it's the default /)
if (parsed.data.URL_BASE !== '/' && !parsed.data.URL_BASE.startsWith('/')) {
  throw new Error(`Invalid URL_BASE: "${process.env.URL_BASE}" — must start with /`);
}

export const config = {
  port: parsed.data.PORT,
  isDev: parsed.data.NODE_ENV !== 'production',
  corsOrigin: parsed.data.CORS_ORIGIN,
  configPath: parsed.data.CONFIG_PATH,
  dbPath: parsed.data.DATABASE_URL,
  authBypass: parsed.data.AUTH_BYPASS,
  urlBase: parsed.data.URL_BASE,
  monitorIntervalCron: parsed.data.MONITOR_INTERVAL_CRON,
};
