import type { FastifyInstance } from 'fastify';
import type { Services } from './index.js';
import { runSearchJob } from '../jobs/search.js';

export async function systemRoutes(app: FastifyInstance, services: Services) {
  // GET /api/system/status
  app.get('/api/system/status', async () => {
    return {
      version: '0.1.0',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  });

  // GET /api/health
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
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
