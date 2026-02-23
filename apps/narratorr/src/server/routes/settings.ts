import { z } from 'zod';
import { type FastifyInstance } from 'fastify';
import { probeFfmpeg } from '@narratorr/core/utils/audio-processor';
import { type SettingsService, type AppSettings } from '../services';
import { updateSettingsSchema } from '../../shared/schemas.js';

const ffmpegProbeSchema = z.object({
  path: z.string().min(1, 'Path is required'),
});

export async function settingsRoutes(app: FastifyInstance, settingsService: SettingsService) {
  // GET /api/settings
  app.get('/api/settings', async (request, reply) => {
    try {
      return settingsService.getAll();
    } catch (error) {
      request.log.error(error, 'Failed to fetch settings');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // PUT /api/settings
  app.put(
    '/api/settings',
    {
      schema: {
        body: updateSettingsSchema,
      },
    },
    async (request, reply) => {
      try {
        const data = request.body as Partial<AppSettings>;
        const result = await settingsService.update(data);

        // Apply log level change at runtime
        if (data.general?.logLevel) {
          app.log.level = data.general.logLevel;
          app.log.info({ level: data.general.logLevel }, 'Log level changed');
        }

        request.log.info('Settings updated');

        return result;
      } catch (error) {
        request.log.error(error, 'Failed to update settings');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // POST /api/settings/ffmpeg-probe
  app.post(
    '/api/settings/ffmpeg-probe',
    {
      schema: {
        body: ffmpegProbeSchema,
      },
    },
    async (request, reply) => {
      try {
        const { path } = request.body as z.infer<typeof ffmpegProbeSchema>;
        const version = await probeFfmpeg(path);
        request.log.info({ version, path }, 'ffmpeg probe successful');
        return { version };
      } catch (error) {
        request.log.warn({ error }, 'ffmpeg probe failed');
        return reply.status(400).send({
          error: error instanceof Error ? error.message : 'ffmpeg probe failed',
        });
      }
    }
  );
}
