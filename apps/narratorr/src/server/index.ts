import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createDb, runMigrations } from '@narratorr/db';
import { config } from './config.js';
import { createServices, registerRoutes } from './routes';
import { startJobs } from './jobs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({
    logger: true,
  }).withTypeProvider<ZodTypeProvider>();

  // Set up Zod validation
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS
  await app.register(cors, {
    origin: config.isDev ? true : config.corsOrigin,
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

  // Create services
  const services = createServices(db, app.log);

  // Apply persisted log level
  const generalSettings = await services.settings.get('general');
  if (generalSettings?.logLevel) {
    app.log.level = generalSettings.logLevel;
  }

  // Register API routes
  await registerRoutes(app, services);

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
  startJobs(db, services.downloadClient, app.log);

  // Start server
  await app.listen({
    port: config.port,
    host: '0.0.0.0',
  });

  app.log.info({ port: config.port }, 'Server running');
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
