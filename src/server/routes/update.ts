import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SettingsService } from '../services/settings.service.js';

const dismissBodySchema = z.object({
  version: z.string().trim().min(1),
}).strict();

export async function updateRoutes(app: FastifyInstance, settings: SettingsService) {
  // PUT /api/system/update/dismiss
  app.put<{ Body: z.infer<typeof dismissBodySchema> }>(
    '/api/system/update/dismiss',
    { schema: { body: dismissBodySchema } },
    async (request) => {
      const { version } = request.body;
      await settings.patch('system', { dismissedUpdateVersion: version });
      return { ok: true };
    },
  );
}
