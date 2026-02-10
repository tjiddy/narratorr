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
      const data = request.body as Partial<AppSettings>;
      const result = await settingsService.update(data);

      // Apply log level change at runtime
      if (data.general?.logLevel) {
        app.log.level = data.general.logLevel;
        app.log.info({ level: data.general.logLevel }, 'Log level changed');
      }

      request.log.info('Settings updated');

      return result;
    }
  );
}
