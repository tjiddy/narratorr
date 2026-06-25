import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type ConnectorService } from '../services';
import { createConnectorSchema, makeUpdateConnectorSchema, connectorSettingsSchemas, connectorTargetsSettingsSchemas, connectorTypeSchema } from '../../shared/schemas.js';
import { idParamSchema } from '../../shared/schemas.js';
import { makeTestSchema, loosenSettingsSchemas } from '../utils/secret-codec.js';
import { registerCrudRoutes } from './crud-routes.js';

type IdParam = z.infer<typeof idParamSchema>;

// Targets validate an arbitrary connector config (no name required, unlike the
// CRUD create schema). Sentinel-aware so the masked apiKey resolves against the
// saved row when an `id` is supplied.
const connectorConfigSchema = z.object({
  type: connectorTypeSchema,
  settings: z.record(z.string(), z.unknown()),
});

// Sentinel-aware update schema: the strict per-type schemas now reject the
// masked '********' on baseUrl (it is not a valid URL), so a masked baseUrl /
// apiKey / token edit must round-trip through the sentinel-loosened settings
// map. Real (non-sentinel) values are still validated strictly. Built here on
// the server because the loosening machinery (loosenSettingsSchemas) lives with
// the secret-field registry, not in the shared schema layer.
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

  // POST /api/connectors/targets — populate the dropdown from an UNSAVED config.
  // Sentinel-aware schema (with optional id) so masked secrets resolve against the
  // saved row. Uses the targets-scoped settings map so the selector field
  // (libraryId/sectionId) — the very thing this fetch populates — is NOT required
  // on a brand-new connector (#1523). Real connect fields are still validated.
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
      // Success → bare ConnectorTarget[]; failure → field-scoped envelope.
      return result.success ? result.targets : result;
    },
  );

  // GET /api/connectors/:id/targets — populate the dropdown from a SAVED connector.
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
