import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import type { Services } from './index.js';
import { runSearchJob } from '../jobs/search.js';

export async function systemRoutes(app: FastifyInstance, services: Services, db: Db) {
  // GET /api/system/status
  app.get('/api/system/status', async () => {
    return {
      version: '0.1.0',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  });

  // GET /api/health — DB-aware health probe for Docker/k8s/load balancers
  app.get('/api/health', async (request, reply) => {
    try {
      await db.run(sql`SELECT 1`);
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      request.log.warn(error, 'Health check DB probe failed');
      return reply.status(503).send({
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Database unreachable',
      });
    }
  });

  // POST /api/system/tasks/search — manually trigger a search cycle
  app.post('/api/system/tasks/search', async (request) => {
    const result = await runSearchJob(
      services.settings,
      services.book,
      services.indexer,
      services.download,
      request.log,
    );
    return result;
  });
}
