import { type FastifyInstance } from 'fastify';
import { type DownloadClientService } from '../services';
import {
  idParamSchema,
  createDownloadClientSchema,
  updateDownloadClientSchema,
  type CreateDownloadClientInput,
  type UpdateDownloadClientInput,
} from '../../shared/schemas.js';

export async function downloadClientsRoutes(
  app: FastifyInstance,
  downloadClientService: DownloadClientService
) {
  // GET /api/download-clients
  app.get('/api/download-clients', async () => {
    return downloadClientService.getAll();
  });

  // GET /api/download-clients/:id
  app.get(
    '/api/download-clients/:id',
    {
      schema: {
        params: idParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const client = await downloadClientService.getById(id);

      if (!client) {
        return reply.status(404).send({ error: 'Download client not found' });
      }

      return client;
    }
  );

  // POST /api/download-clients
  app.post(
    '/api/download-clients',
    {
      schema: {
        body: createDownloadClientSchema,
      },
    },
    async (request, reply) => {
      const data = request.body as CreateDownloadClientInput;
      const client = await downloadClientService.create(data);
      request.log.info({ name: data.name }, 'Download client created');
      return reply.status(201).send(client);
    }
  );

  // PUT /api/download-clients/:id
  app.put(
    '/api/download-clients/:id',
    {
      schema: {
        params: idParamSchema,
        body: updateDownloadClientSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };
      const data = request.body as UpdateDownloadClientInput;
      const client = await downloadClientService.update(id, data);

      if (!client) {
        return reply.status(404).send({ error: 'Download client not found' });
      }

      request.log.debug({ id }, 'Download client updated');
      return client;
    }
  );

  // DELETE /api/download-clients/:id
  app.delete(
    '/api/download-clients/:id',
    {
      schema: {
        params: idParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };

      try {
        const deleted = await downloadClientService.delete(id);

        if (!deleted) {
          return reply.status(404).send({ error: 'Download client not found' });
        }

        return { success: true };
      } catch (error) {
        request.log.error(error, 'Failed to delete download client');
        return reply.status(500).send({
          error: error instanceof Error ? error.message : 'Failed to delete',
        });
      }
    }
  );

  // POST /api/download-clients/:id/test
  app.post(
    '/api/download-clients/:id/test',
    {
      schema: {
        params: idParamSchema,
      },
    },
    async (request) => {
      const { id } = request.params as { id: number };
      const result = await downloadClientService.test(id);
      request.log.debug({ id, success: result.success }, 'Download client test result');
      return result;
    }
  );
}
