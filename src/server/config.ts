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
  LIBRARY_PATH: z.string().default('./audiobooks').transform((v) => v || './audiobooks'),
  DATABASE_URL: z.string().default('./config/narratorr.db').transform((v) => v || './config/narratorr.db'),
  AUTH_BYPASS: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const portError = parsed.error.issues.find((i) => i.path[0] === 'PORT');
  if (portError) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }
  throw new Error(`Invalid environment config: ${parsed.error.message}`);
}

export const config = {
  port: parsed.data.PORT,
  isDev: parsed.data.NODE_ENV !== 'production',
  corsOrigin: parsed.data.CORS_ORIGIN,
  configPath: parsed.data.CONFIG_PATH,
  libraryPath: parsed.data.LIBRARY_PATH,
  dbPath: parsed.data.DATABASE_URL,
  authBypass: parsed.data.AUTH_BYPASS,
};
