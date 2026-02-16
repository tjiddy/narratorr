import { type FastifyInstance } from 'fastify';
import { type ZodTypeAny } from 'zod';
import { idParamSchema } from '../../shared/schemas.js';

interface CrudService {
  getAll(): Promise<unknown[]>;
  getById(id: number): Promise<unknown | null>;
  create(data: unknown): Promise<unknown>;
  update(id: number, data: unknown): Promise<unknown | null>;
  delete(id: number): Promise<boolean>;
  test(id: number): Promise<{ success: boolean; message?: string }>;
  testConfig(data: { type: string; settings: Record<string, unknown> }): Promise<{ success: boolean; message?: string }>;
}

interface CrudRouteOptions {
  basePath: string;
  entityName: string;
  service: CrudService;
  createSchema: ZodTypeAny;
  updateSchema: ZodTypeAny;
}

export async function registerCrudRoutes(
  app: FastifyInstance,
  { basePath, entityName, service, createSchema, updateSchema }: CrudRouteOptions,
) {
  const lower = entityName.toLowerCase();

  // GET /api/<resource>
  app.get(basePath, async (request, reply) => {
    try {
      return service.getAll();
    } catch (error) {
      request.log.error(error, `Failed to fetch ${lower}s`);
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /api/<resource>/:id
  app.get(
    `${basePath}/:id`,
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: number };
        const item = await service.getById(id);
        if (!item) {
          return reply.status(404).send({ error: `${entityName} not found` });
        }
        return item;
      } catch (error) {
        request.log.error(error, `Failed to fetch ${lower}`);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // POST /api/<resource>
  app.post(
    basePath,
    { schema: { body: createSchema } },
    async (request, reply) => {
      try {
        const data = request.body as Record<string, unknown>;
        const item = await service.create(data);
        request.log.info({ name: data.name }, `${entityName} created`);
        return reply.status(201).send(item);
      } catch (error) {
        request.log.error(error, `Failed to create ${lower}`);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // PUT /api/<resource>/:id
  app.put(
    `${basePath}/:id`,
    { schema: { params: idParamSchema, body: updateSchema } },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: number };
        const item = await service.update(id, request.body);
        if (!item) {
          return reply.status(404).send({ error: `${entityName} not found` });
        }
        request.log.info({ id }, `${entityName} updated`);
        return item;
      } catch (error) {
        request.log.error(error, `Failed to update ${lower}`);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // DELETE /api/<resource>/:id
  app.delete(
    `${basePath}/:id`,
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      try {
        const deleted = await service.delete(id);
        if (!deleted) {
          return reply.status(404).send({ error: `${entityName} not found` });
        }
        request.log.info({ id }, `${entityName} deleted`);
        return { success: true };
      } catch (error) {
        request.log.error({ id, error }, `Failed to delete ${lower}`);
        return reply.status(500).send({
          error: error instanceof Error ? error.message : 'Failed to delete',
        });
      }
    },
  );

  // POST /api/<resource>/test
  app.post(
    `${basePath}/test`,
    { schema: { body: createSchema } },
    async (request, reply) => {
      try {
        const data = request.body as { type: string; settings: Record<string, unknown> };
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
      } catch (error) {
        request.log.error(error, `${entityName} config test error`);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // POST /api/<resource>/:id/test
  app.post(
    `${basePath}/:id/test`,
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: number };
        const result = await service.test(id);
        if (result.success) {
          request.log.info({ id }, `${entityName} test passed`);
        } else {
          request.log.warn({ id, message: result.message }, `${entityName} test failed`);
        }
        return result;
      } catch (error) {
        request.log.error(error, `${entityName} test error`);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );
}
