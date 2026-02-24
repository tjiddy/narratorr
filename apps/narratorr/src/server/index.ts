import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from monorepo root (4 levels up: server/ → src/ → narratorr/ → apps/ → root)
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createDb, runMigrations } from '@narratorr/db';
import { config } from './config.js';
import { createServices, registerRoutes } from './routes';
import { startJobs } from './jobs';
import authPlugin from './plugins/auth.js';

function hasPinoPretty(): boolean {
  try { import.meta.resolve('pino-pretty'); return true; } catch { return false; }
}

async function main() {
  const app = Fastify({
    logger: config.isDev && hasPinoPretty()
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : true,
  }).withTypeProvider<ZodTypeProvider>();

  // Set up Zod validation
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS
  await app.register(cors, {
    origin: config.isDev ? true : config.corsOrigin,
    credentials: true,
  });

  // Ensure config directory exists
  const configDir = path.dirname(config.dbPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Initialize database with migrations
  app.log.info({ dbPath: config.dbPath }, 'Initializing database');
  await runMigrations(config.dbPath);
  const db = createDb(config.dbPath);

  // Create services (async — reads settings from DB for provider config)
  const services = await createServices(db, app.log);

  // Apply persisted log level
  try {
    const generalSettings = await services.settings.get('general');
    if (generalSettings?.logLevel) {
      app.log.level = generalSettings.logLevel;
    }
  } catch (err) {
    app.log.warn(err, 'Failed to load log level setting, using default');
  }

  // Initialize auth and register cookie/auth plugins
  await services.auth.initialize();
  await app.register(cookie);
  await app.register(authPlugin, { authService: services.auth });

  // Register API routes
  await registerRoutes(app, services, db);

  // Serve static files in production
  if (!config.isDev) {
    const clientPath = path.join(__dirname, '../client');
    if (fs.existsSync(clientPath)) {
      await app.register(fastifyStatic, {
        root: clientPath,
        prefix: '/',
      });

      // SPA fallback - serve index.html for non-API routes
      app.setNotFoundHandler((request, reply) => {
        if (!request.url.startsWith('/api/')) {
          return reply.sendFile('index.html');
        }
        return reply.status(404).send({ error: 'Not found' });
      });
    }
  }

  // Start background jobs
  startJobs(db, services, app.log);

  // Graceful shutdown — ensures port is released on tsx watch restarts
  const shutdown = async () => {
    app.log.info('Shutting down server…');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Start server (retry on EADDRINUSE — handles tsx watch race on Windows
  // where the previous process hasn't released the port yet)
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await app.listen({ port: config.port, host: '0.0.0.0' });
      break;
    } catch (err: unknown) {
      const isAddrInUse = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (isAddrInUse && attempt < maxRetries) {
        app.log.warn({ port: config.port, attempt }, 'Port in use, retrying…');
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }

  app.log.info({ port: config.port }, 'Server running');
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
