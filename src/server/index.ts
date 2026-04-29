import dotenv from 'dotenv';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { serializeError } from './utils/serialize-error.js';
import { logCrash } from './utils/crash-logger.js';

// Crash handlers registered at module load so they catch errors during the
// import phase too. logCrash bypasses Pino's async buffer (sonic-boom) so
// fatal logs flush before process.exit() actually terminates.
process.on('uncaughtException', (err) => {
  logCrash('Uncaught exception — process will exit', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logCrash('Unhandled promise rejection — process will exit', reason);
  process.exit(1);
});

// Log every process exit (including external process.exit() calls) so silent
// terminations surface in the logs. Synchronous stderr.write so output flushes
// before Node actually leaves.
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

// Wrap process.exit to capture call site of any code that hard-exits the process.
// Some libraries (especially older CLI-style ones or broken native modules) call
// process.exit() directly on errors, bypassing JS exception handlers AND Node's
// --report-* writers. This wrapper logs who's calling exit and with what code.
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


const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from repo root (2 levels up: server/ → src/ → root)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createDb, runMigrations } from '../db/index.js';
import { config } from './config.js';
import { createServices, registerRoutes } from './routes';
import { startJobs } from './jobs';
import multipart from '@fastify/multipart';
import authPlugin from './plugins/auth.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { registerSecurityPlugins } from './plugins/security-plugins.js';
import { registerStaticAndSpa, listenWithRetry } from './server-utils.js';
import { applyPendingRestore } from './services/backup.service.js';
import { loadEncryptionKey, initializeKey } from './utils/secret-codec.js';
import { migrateSecretsToEncrypted } from './utils/secret-migration.js';
import { warnIfAuthBypassWithUser } from './boot-warnings.js';

function buildLoggerConfig(): boolean | { transport: { target: string; options: Record<string, unknown> } } {
  if (!config.isDev) return true;
  try {
    import.meta.resolve('pino-pretty');
    return { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } };
  } catch {
    return true;
  }
}

async function main() {
  const app = Fastify({
    logger: buildLoggerConfig(),
    disableRequestLogging: true,
    trustProxy: config.trustedProxies,
  }).withTypeProvider<ZodTypeProvider>();

  // Request logging at trace level (Fastify defaults to info which is too noisy)
  app.addHook('onRequest', (request, _reply, done) => {
    request.log.trace({ url: request.url, method: request.method, reqId: request.id }, 'incoming request');
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    request.log.trace({ url: request.url, method: request.method, statusCode: reply.statusCode, responseTime: reply.elapsedTime }, 'request completed');
    done();
  });

  // Set up Zod validation
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS — dev uses an explicit allowlist (vite client + server self-origin); prod uses configured origin.
  // Reflecting any origin (`origin: true`) with credentials would let any malicious page visited during
  // local dev read authenticated responses from localhost.
  const devCorsOrigins = ['http://localhost:5173', 'http://localhost:3000'];
  await app.register(cors, {
    origin: config.isDev ? devCorsOrigins : config.corsOrigin,
    credentials: true,
  });

  // Security headers
  await registerSecurityPlugins(app, config.isDev);

  // Rate limiting (per-route only — global: false prevents auto-applying to all routes)
  await app.register(rateLimit, { global: false });

  // Multipart support for file uploads (restore)
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });

  // Ensure config directory exists
  const configDir = path.dirname(config.dbPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Check for pending restore before DB is opened
  applyPendingRestore(config.configPath, config.dbPath, app.log);

  // Initialize database with migrations
  app.log.info({ dbPath: config.dbPath }, 'Initializing database');
  await runMigrations(config.dbPath);
  const db = createDb(config.dbPath);

  // Initialize encryption key and migrate plaintext secrets
  const keyResult = loadEncryptionKey(process.env.NARRATORR_SECRET_KEY, config.configPath);
  initializeKey(keyResult.key);
  if (keyResult.source === 'generated') {
    app.log.info({ path: path.join(config.configPath, 'secret.key') }, 'Generated new encryption key');
  } else {
    app.log.info({ source: keyResult.source }, 'Encryption key loaded');
  }
  await migrateSecretsToEncrypted(db, keyResult.key, app.log);

  // Create services (async — reads settings from DB for provider config)
  const services = await createServices(db, app.log);

  // Apply persisted log level
  try {
    const generalSettings = await services.settings.get('general');
    if (generalSettings?.logLevel) {
      app.log.level = generalSettings.logLevel;
    }
  } catch (error: unknown) {
    app.log.warn({ error: serializeError(error) }, 'Failed to load log level setting, using default');
  }

  // Initialize auth and register cookie/auth plugins
  await services.auth.initialize();

  // Loud boot warning when AUTH_BYPASS is on with a real user account (#742).
  await warnIfAuthBypassWithUser(config.authBypass, services.auth, app.log);
  await app.register(cookie);
  await app.register(authPlugin, { authService: services.auth, urlBase: config.urlBase });
  await app.register(errorHandlerPlugin);

  // URL_BASE prefix — routes, static files, and SPA fallback are scoped under urlBase
  const urlBasePrefix = config.urlBase === '/' ? '' : config.urlBase;

  // Register API routes under URL_BASE scope
  await app.register(async (scoped) => {
    await registerRoutes(scoped, services, db);
  }, { prefix: urlBasePrefix || '/' });

  // Serve static files and SPA fallback in production
  if (!config.isDev) {
    await registerStaticAndSpa(app, urlBasePrefix);
  }

  // Start import queue worker first (boot recovery marks orphaned jobs as failed BEFORE download recovery)
  await services.importQueueWorker.start();

  // Start background jobs (includes download startup recovery which may re-enqueue downloads)
  startJobs(db, services, app.log);

  // Graceful shutdown — ensures port is released on tsx watch restarts
  const shutdown = async () => {
    app.log.info('Shutting down server…');
    await services.importQueueWorker.stop();
    await app.close();
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
