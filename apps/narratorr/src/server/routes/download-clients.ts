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
  app.get('/api/download-clients', async (request, reply) => {
    try {
      return downloadClientService.getAll();
    } catch (error) {
      request.log.error(error, 'Failed to fetch download clients');
      return reply.status(500).send({ error: 'Internal server error' });
    }
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
      try {
        const { id } = request.params as { id: number };
        const client = await downloadClientService.getById(id);

        if (!client) {
          return reply.status(404).send({ error: 'Download client not found' });
        }

        return client;
      } catch (error) {
        request.log.error(error, 'Failed to fetch download client');
        return reply.status(500).send({ error: 'Internal server error' });
      }
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
      try {
        const data = request.body as CreateDownloadClientInput;
        const client = await downloadClientService.create(data);
        request.log.info({ name: data.name }, 'Download client created');
        return reply.status(201).send(client);
      } catch (error) {
        request.log.error(error, 'Failed to create download client');
        return reply.status(500).send({ error: 'Internal server error' });
      }
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
      try {
        const { id } = request.params as { id: number };
        const data = request.body as UpdateDownloadClientInput;
        const client = await downloadClientService.update(id, data);

        if (!client) {
          return reply.status(404).send({ error: 'Download client not found' });
        }

        request.log.info({ id }, 'Download client updated');
        return client;
      } catch (error) {
        request.log.error(error, 'Failed to update download client');
        return reply.status(500).send({ error: 'Internal server error' });
      }
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

        request.log.info({ id }, 'Download client deleted');
        return { success: true };
      } catch (error) {
        request.log.error({ id, error }, 'Failed to delete download client');
        return reply.status(500).send({
          error: error instanceof Error ? error.message : 'Failed to delete',
        });
      }
    }
  );

  // POST /api/download-clients/test (test config without persisting)
  app.post(
    '/api/download-clients/test',
    {
      schema: {
        body: createDownloadClientSchema,
      },
    },
    async (request) => {
      const data = request.body as CreateDownloadClientInput;
      const result = await downloadClientService.testConfig({
        type: data.type,
        settings: data.settings as Record<string, unknown>,
      });
      request.log.debug({ type: data.type, success: result.success }, 'Download client config test result');
      return result;
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
