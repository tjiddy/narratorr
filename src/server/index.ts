import os from 'os';
import path from 'path';
import fs from 'fs';
import { serializeError } from './utils/serialize-error.js';
import { logCrash } from './utils/crash-logger.js';

// Register before imports; logCrash bypasses Pino buffering so fatal output survives exit.
process.on('uncaughtException', (err) => {
  logCrash('Uncaught exception — process will exit', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logCrash('Unhandled promise rejection — process will exit', reason);
  process.exit(1);
});

// Synchronously log every exit so otherwise silent terminations remain visible.
process.on('exit', (code) => {
  try {
    process.stderr.write(JSON.stringify({
      level: 60,
      time: Date.now(),
      pid: process.pid,
      hostname: os.hostname(),
      code,
      msg: 'process exit event',
    }) + '\n');
  } catch {
    /* stderr unavailable */
  }
});

// Capture callers that hard-exit and bypass exception handlers and Node reports.
const __originalExit = process.exit.bind(process);
process.exit = ((code?: number): never => {
  try {
    process.stderr.write(JSON.stringify({
      level: 60,
      time: Date.now(),
      pid: process.pid,
      hostname: os.hostname(),
      code: code ?? 0,
      stack: new Error('process.exit called').stack,
      msg: 'process.exit() invoked — capturing caller',
    }) + '\n');
  } catch {
    /* stderr unavailable */
  }
  return __originalExit(code);
}) as typeof process.exit;


// Production does not ship .env, so absence is expected.
try { process.loadEnvFile('.env'); } catch { /* expected */ }

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { buildCorsOptions } from './cors-config.js';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createDb, runMigrations } from '@db/index.js';
import { config } from './config.js';
import { createServices, registerRoutes } from './routes';
import { startRuntime } from './startup.js';
import multipart from '@fastify/multipart';
import authPlugin from './plugins/auth.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { registerSecurityPlugins } from './plugins/security-plugins.js';
import { registerStaticAndSpa, listenWithRetry } from './server-utils.js';
import { applyPendingRestore } from './services/backup.service.js';
import { loadEncryptionKey, initializeKey } from './utils/secret-codec.js';
import { migrateSecretsToEncrypted } from './utils/secret-migration.js';
import { warnIfAuthBypassWithUser, checkReverseProxyBootConfig } from './boot-warnings.js';
import { checkFfmpegVersionAtBoot } from './boot-ffmpeg-version.js';
import { checkMutagenVersionAtBoot } from './boot-mutagen-version.js';
import { checkCrashForensicsAtBoot, pruneCrashArtifactsAtBoot } from './boot-crash-forensics.js';
import { buildFastifyOptions } from './fastify-options.js';
import { registerRequestTraceLogging } from './request-trace-logging.js';
import { registerV1OpenApi } from './routes/v1/openapi.js';
import { gracefulShutdown } from './shutdown.js';

async function main() {
  const app = Fastify(buildFastifyOptions()).withTypeProvider<ZodTypeProvider>();

  registerRequestTraceLogging(app);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Never reflect arbitrary origins with credentials; hostile pages could read localhost responses.
  await app.register(cors, buildCorsOptions(config));

  await registerSecurityPlugins(app, config.isDev);

  // Rate limits are opt-in per route.
  await app.register(rateLimit, { global: false });

  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });

  const configDir = path.dirname(config.dbPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Before every other write to /config: cores are GB-scale and share the volume with the
  // database, so on a segfault crashloop a later prune would never run — migrations would fail
  // first for want of space, on precisely the loop the bound exists to break.
  await pruneCrashArtifactsAtBoot(app.log);

  // Check for pending restore before DB is opened
  applyPendingRestore(config.configPath, config.dbPath, app.log);

  app.log.info({ dbPath: config.dbPath }, 'Initializing database');
  await runMigrations(config.dbPath);
  const db = createDb(config.dbPath);

  const keyResult = loadEncryptionKey(process.env.NARRATORR_SECRET_KEY, config.configPath);
  initializeKey(keyResult.key);
  if (keyResult.source === 'generated') {
    app.log.info({ path: path.join(config.configPath, 'secret.key') }, 'Generated new encryption key');
  } else {
    app.log.info({ source: keyResult.source }, 'Encryption key loaded');
  }
  await migrateSecretsToEncrypted(db, keyResult.key, app.log);

  const services = await createServices(db, app.log);

  try {
    const generalSettings = await services.settings.get('general');
    if (generalSettings?.logLevel) {
      app.log.level = generalSettings.logLevel;
    }
  } catch (error: unknown) {
    app.log.warn({ error: serializeError(error) }, 'Failed to load log level setting, using default');
  }

  await services.auth.initialize();

  await warnIfAuthBypassWithUser(config.authBypass, services.auth, app.log);

  await checkReverseProxyBootConfig(services.auth, config.trustedProxies, app.log);

  await checkFfmpegVersionAtBoot(app.log, services.settings);
  await checkMutagenVersionAtBoot(app.log);
  await checkCrashForensicsAtBoot(app.log);
  await app.register(cookie);
  await app.register(authPlugin, { authService: services.auth, urlBase: config.urlBase });
  await app.register(errorHandlerPlugin);

  // URL_BASE scopes routes and the SPA; root maps to Fastify's empty prefix.
  const urlBasePrefix = config.urlBase === '/' ? '' : config.urlBase;

  // Register before routes so Swagger's onRoute hook captures v1; docs remain public.
  await registerV1OpenApi(app, urlBasePrefix);

  await app.register(async (scoped) => {
    await registerRoutes(scoped, services, db);
  }, { prefix: urlBasePrefix || '/' });

  if (!config.isDev) {
    await registerStaticAndSpa(app, urlBasePrefix);
  }

  const jobScheduler = await startRuntime(app, services, db);

  const shutdown = async () => {
    await gracefulShutdown(app, services, jobScheduler);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await listenWithRetry(app, config.port);

  app.log.info({ port: config.port }, 'Server running');
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
