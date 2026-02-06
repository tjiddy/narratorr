import type { FastifyInstance } from 'fastify';

export async function systemRoutes(app: FastifyInstance) {
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
}
