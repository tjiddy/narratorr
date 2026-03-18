import { type FastifyInstance } from 'fastify';
import { type z, type ZodTypeAny } from 'zod';
import { idParamSchema } from '../../shared/schemas.js';
import { maskFields, type SecretEntity } from '../utils/secret-codec.js';
import { getErrorMessage } from '../utils/error-message.js';

type IdParam = z.infer<typeof idParamSchema>;

interface CrudService {
  getAll(): Promise<unknown[]>;
  getById(id: number): Promise<unknown | null>;
  create(data: unknown): Promise<unknown>;
  update(id: number, data: unknown): Promise<unknown | null>;
  delete(id: number): Promise<boolean>;
  test(id: number): Promise<{ success: boolean; message?: string; ip?: string }>;
  testConfig(data: { type: string; settings: Record<string, unknown> }): Promise<{ success: boolean; message?: string; ip?: string }>;
}

interface CrudRouteOptions {
  basePath: string;
  entityName: string;
  service: CrudService;
  createSchema: ZodTypeAny;
  updateSchema: ZodTypeAny;
  /** When set, masks secret fields in the `settings` JSON blob of API responses. */
  secretEntity?: SecretEntity;
}

/** Mask the `settings` blob in a row if secretEntity is configured. */
function maskRow(row: unknown, entity?: SecretEntity): unknown {
  if (!entity || !row || typeof row !== 'object') return row;
  const r = row as Record<string, unknown>;
  if (r.settings && typeof r.settings === 'object') {
    return { ...r, settings: maskFields(entity, { ...(r.settings as Record<string, unknown>) }) };
  }
  return row;
}

export async function registerCrudRoutes(
  app: FastifyInstance,
  { basePath, entityName, service, createSchema, updateSchema, secretEntity }: CrudRouteOptions,
) {
  const lower = entityName.toLowerCase();

  // GET /api/<resource>
  app.get(basePath, async () => {
    const items = await service.getAll();
    return items.map((item) => maskRow(item, secretEntity));
  });

  // GET /api/<resource>/:id
  app.get<{ Params: IdParam }>(
    `${basePath}/:id`,
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const item = await service.getById(id);
      if (!item) {
        return reply.status(404).send({ error: `${entityName} not found` });
      }
      return maskRow(item, secretEntity);
    },
  );

  // POST /api/<resource>
  app.post<{ Body: Record<string, unknown> }>(
    basePath,
    { schema: { body: createSchema } },
    async (request, reply) => {
      const data = request.body;
      const item = await service.create(data);
      request.log.info({ name: data.name }, `${entityName} created`);
      return reply.status(201).send(maskRow(item, secretEntity));
    },
  );

  // PUT /api/<resource>/:id
  app.put<{ Params: IdParam }>(
    `${basePath}/:id`,
    { schema: { params: idParamSchema, body: updateSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const item = await service.update(id, request.body);
      if (!item) {
        return reply.status(404).send({ error: `${entityName} not found` });
      }
      request.log.info({ id }, `${entityName} updated`);
      return maskRow(item, secretEntity);
    },
  );

  // DELETE /api/<resource>/:id
  app.delete<{ Params: IdParam }>(
    `${basePath}/:id`,
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const deleted = await service.delete(id);
        if (!deleted) {
          return await reply.status(404).send({ error: `${entityName} not found` });
        }
        request.log.info({ id }, `${entityName} deleted`);
        return { success: true };
      } catch (error) {
        request.log.error({ id, error }, `Failed to delete ${lower}`);
        return reply.status(500).send({
          error: getErrorMessage(error, 'Failed to delete'),
        });
      }
    },
  );

  // POST /api/<resource>/test
  app.post<{ Body: { type: string; settings: Record<string, unknown> } }>(
    `${basePath}/test`,
    { schema: { body: createSchema } },
    async (request) => {
      const data = request.body;
      const result = await service.testConfig({
        type: data.type,
        settings: data.settings,
      });
      if (result.success) {
        request.log.info({ type: data.type }, `${entityName} config test passed`);
      } else {
        request.log.warn({ type: data.type, message: result.message }, `${entityName} config test failed`);
      }
      return result;
    },
  );

  // POST /api/<resource>/:id/test
  app.post<{ Params: IdParam }>(
    `${basePath}/:id/test`,
    { schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params;
      const result = await service.test(id);
      if (result.success) {
        request.log.info({ id }, `${entityName} test passed`);
      } else {
        request.log.warn({ id, message: result.message }, `${entityName} test failed`);
      }
      return result;
    },
  );
}
