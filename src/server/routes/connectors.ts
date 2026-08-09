import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type ConnectorService } from '../services';
import { createConnectorSchema, makeUpdateConnectorSchema, connectorSettingsSchemas, connectorTargetsSettingsSchemas, connectorTypeSchema } from '@shared/schemas.js';
import { idParamSchema } from '@shared/schemas.js';
import { makeTestSchema, loosenSettingsSchemas } from '../utils/secret-codec.js';
import { registerCrudRoutes } from './crud-routes.js';

type IdParam = z.infer<typeof idParamSchema>;

// Target discovery accepts unsaved configs; an optional id resolves masked secrets from storage.
const connectorConfigSchema = z.object({
  type: connectorTypeSchema,
  settings: z.record(z.string(), z.unknown()),
});

// Permit masked sentinels to round-trip while validating every real value strictly.
const sentinelAwareUpdateSchema = makeUpdateConnectorSchema(
  loosenSettingsSchemas(connectorSettingsSchemas, 'connector'),
);

export async function connectorsRoutes(app: FastifyInstance, connectorService: ConnectorService) {
  await registerCrudRoutes(app, {
    basePath: '/api/connectors',
    entityName: 'Connector',
    service: connectorService,
    createSchema: createConnectorSchema,
    updateSchema: sentinelAwareUpdateSchema,
    secretEntity: 'connector',
  });

  // Selector fields stay optional because this request discovers their available values.
  const targetsSchema = makeTestSchema(connectorConfigSchema, 'connector', connectorTargetsSettingsSchemas);
  app.post<{ Body: { type: string; settings: Record<string, unknown>; id?: number } }>(
    '/api/connectors/targets',
    { schema: { body: targetsSchema } },
    async (request) => {
      const data = request.body;
      const payload: { type: string; settings: Record<string, unknown>; id?: number } = {
        type: data.type,
        settings: data.settings,
      };
      if (data.id != null) payload.id = data.id;
      const result = await connectorService.listTargetsConfig(payload);
      return result.success ? result.targets : result;
    },
  );

  app.get<{ Params: IdParam }>(
    '/api/connectors/:id/targets',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const existing = await connectorService.getById(id);
      if (!existing) {
        return reply.status(404).send({ error: 'Connector not found' });
      }
      const result = await connectorService.listTargets(id);
      return result.success ? result.targets : result;
    },
  );
}
