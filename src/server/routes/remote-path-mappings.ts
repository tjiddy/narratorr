import { type FastifyInstance } from 'fastify';
import { type z } from 'zod';
import { type RemotePathMappingService } from '../services/remote-path-mapping.service.js';
import { createRemotePathMappingSchema, updateRemotePathMappingSchema, idParamSchema, type CreateRemotePathMappingInput, type UpdateRemotePathMappingInput } from '../../shared/schemas.js';
import { getErrorMessage } from '../utils/error-message.js';

type IdParam = z.infer<typeof idParamSchema>;

export async function remotePathMappingRoutes(
  app: FastifyInstance,
  remotePathMappingService: RemotePathMappingService,
) {
  // GET /api/remote-path-mappings — list all, optionally filter by downloadClientId
  app.get<{ Querystring: { downloadClientId?: string } }>(
    '/api/remote-path-mappings',
    async (request) => {
      const { downloadClientId } = request.query;
      if (downloadClientId) {
        const id = parseInt(downloadClientId, 10);
        if (!isNaN(id)) {
          return remotePathMappingService.getByClientId(id);
        }
      }
      return remotePathMappingService.getAll();
    },
  );

  // GET /api/remote-path-mappings/:id
  app.get<{ Params: IdParam }>(
    '/api/remote-path-mappings/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const item = await remotePathMappingService.getById(id);
      if (!item) {
        return reply.status(404).send({ error: 'Remote path mapping not found' });
      }
      return item;
    },
  );

  // POST /api/remote-path-mappings
  app.post<{ Body: CreateRemotePathMappingInput }>(
    '/api/remote-path-mappings',
    { schema: { body: createRemotePathMappingSchema } },
    async (request, reply) => {
      const data = request.body;
      const item = await remotePathMappingService.create(data);
      request.log.info({ downloadClientId: data.downloadClientId }, 'Remote path mapping created');
      return reply.status(201).send(item);
    },
  );

  // PUT /api/remote-path-mappings/:id
  app.put<{ Params: IdParam; Body: UpdateRemotePathMappingInput }>(
    '/api/remote-path-mappings/:id',
    { schema: { params: idParamSchema, body: updateRemotePathMappingSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const item = await remotePathMappingService.update(id, request.body);
      if (!item) {
        return reply.status(404).send({ error: 'Remote path mapping not found' });
      }
      request.log.info({ id }, 'Remote path mapping updated');
      return item;
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
          error: getErrorMessage(error, 'Failed to delete'),
        });
      }
    },
  );
}
