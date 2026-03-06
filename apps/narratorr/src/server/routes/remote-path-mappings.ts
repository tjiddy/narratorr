import { type FastifyInstance } from 'fastify';
import { type z } from 'zod';
import { type RemotePathMappingService } from '../services/remote-path-mapping.service.js';
import { createRemotePathMappingSchema, updateRemotePathMappingSchema, idParamSchema, type CreateRemotePathMappingInput, type UpdateRemotePathMappingInput } from '../../shared/schemas.js';

type IdParam = z.infer<typeof idParamSchema>;

export async function remotePathMappingRoutes(
  app: FastifyInstance,
  remotePathMappingService: RemotePathMappingService,
) {
  // GET /api/remote-path-mappings — list all, optionally filter by downloadClientId
  app.get<{ Querystring: { downloadClientId?: string } }>(
    '/api/remote-path-mappings',
    async (request, reply) => {
      try {
        const { downloadClientId } = request.query;
        if (downloadClientId) {
          const id = parseInt(downloadClientId, 10);
          if (!isNaN(id)) {
            return await remotePathMappingService.getByClientId(id);
          }
        }
        return await remotePathMappingService.getAll();
      } catch (error) {
        request.log.error(error, 'Failed to fetch remote path mappings');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // GET /api/remote-path-mappings/:id
  app.get<{ Params: IdParam }>(
    '/api/remote-path-mappings/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const item = await remotePathMappingService.getById(id);
        if (!item) {
          return await reply.status(404).send({ error: 'Remote path mapping not found' });
        }
        return item;
      } catch (error) {
        request.log.error(error, 'Failed to fetch remote path mapping');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // POST /api/remote-path-mappings
  app.post<{ Body: CreateRemotePathMappingInput }>(
    '/api/remote-path-mappings',
    { schema: { body: createRemotePathMappingSchema } },
    async (request, reply) => {
      try {
        const data = request.body;
        const item = await remotePathMappingService.create(data);
        request.log.info({ downloadClientId: data.downloadClientId }, 'Remote path mapping created');
        return await reply.status(201).send(item);
      } catch (error) {
        request.log.error(error, 'Failed to create remote path mapping');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // PUT /api/remote-path-mappings/:id
  app.put<{ Params: IdParam; Body: UpdateRemotePathMappingInput }>(
    '/api/remote-path-mappings/:id',
    { schema: { params: idParamSchema, body: updateRemotePathMappingSchema } },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const item = await remotePathMappingService.update(id, request.body);
        if (!item) {
          return await reply.status(404).send({ error: 'Remote path mapping not found' });
        }
        request.log.info({ id }, 'Remote path mapping updated');
        return item;
      } catch (error) {
        request.log.error(error, 'Failed to update remote path mapping');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // DELETE /api/remote-path-mappings/:id
  app.delete<{ Params: IdParam }>(
    '/api/remote-path-mappings/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const deleted = await remotePathMappingService.delete(id);
        if (!deleted) {
          return await reply.status(404).send({ error: 'Remote path mapping not found' });
        }
        request.log.info({ id }, 'Remote path mapping deleted');
        return { success: true };
      } catch (error) {
        request.log.error({ id, error }, 'Failed to delete remote path mapping');
        return reply.status(500).send({
          error: error instanceof Error ? error.message : 'Failed to delete',
        });
      }
    },
  );
}
