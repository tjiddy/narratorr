import { type FastifyInstance } from 'fastify';
import { type SettingsService, type AppSettings } from '../services';
import { updateSettingsSchema } from '../../shared/schemas.js';

export async function settingsRoutes(app: FastifyInstance, settingsService: SettingsService) {
  // GET /api/settings
  app.get('/api/settings', async () => {
    return settingsService.getAll();
  });

  // PUT /api/settings
  app.put(
    '/api/settings',
    {
      schema: {
        body: updateSettingsSchema,
      },
    },
    async (request) => {
      // Type assertion is safe here as Zod validates the input
      const data = request.body as Partial<AppSettings>;
      return settingsService.update(data);
    }
  );
}
