import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { SettingsService } from '../../services/settings.service.js';
import { capabilitiesV1Schema } from '@shared/schemas/v1/capabilities.js';
import { serializeError } from '../../utils/serialize-error.js';
import { v1ErrorHandler } from './_helpers.js';

export interface V1CapabilitiesRouteDeps {
  settingsService: SettingsService;
}

/** Authenticated 404 means unsupported; 401 means bad auth. Settings failures fail closed. */
export async function v1CapabilitiesRoutes(app: FastifyInstance, deps: V1CapabilitiesRouteDeps): Promise<void> {
  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);
      const typed = v1.withTypeProvider<ZodTypeProvider>();

      typed.get(
        '/capabilities',
        {
          schema: {
            response: { 200: capabilitiesV1Schema },
          },
        },
        async (request) => {
          let enabled = false;
          try {
            enabled = (await deps.settingsService.get('companionEpub')).enabled;
          } catch (error: unknown) {
            request.log.warn(
              { error: serializeError(error) },
              'v1 capabilities: companionEpub settings read failed — reporting the feature as disabled',
            );
          }
          return { companionEpub: { enabled } };
        },
      );
    },
    { prefix: '/api/v1' },
  );
}
