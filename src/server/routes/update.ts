import type { FastifyInstance } from 'fastify';
import type { SettingsService } from '../services/settings.service.js';

export async function updateRoutes(app: FastifyInstance, settings: SettingsService) {
  // PUT /api/system/update/dismiss
  app.put<{ Body: { version: string } }>('/api/system/update/dismiss', async (request, reply) => {
    const { version } = request.body ?? {};
    if (!version || typeof version !== 'string') {
      return reply.status(400).send({ error: 'version is required' });
    }
    const current = await settings.get('system');
    await settings.set('system', { ...current, dismissedUpdateVersion: version });
    return { ok: true };
  });
}
