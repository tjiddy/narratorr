import { type FastifyInstance } from 'fastify';
import { type IndexerService } from '../services';
import {
  idParamSchema,
  createIndexerSchema,
  updateIndexerSchema,
  type CreateIndexerInput,
  type UpdateIndexerInput,
} from '../../shared/schemas.js';

export async function indexersRoutes(app: FastifyInstance, indexerService: IndexerService) {
  // GET /api/indexers
  app.get('/api/indexers', async (request, reply) => {
    try {
      return indexerService.getAll();
    } catch (error) {
      request.log.error(error, 'Failed to fetch indexers');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /api/indexers/:id
  app.get(
    '/api/indexers/:id',
    {
      schema: {
        params: idParamSchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: number };
        const indexer = await indexerService.getById(id);

        if (!indexer) {
          return reply.status(404).send({ error: 'Indexer not found' });
        }

        return indexer;
      } catch (error) {
        request.log.error(error, 'Failed to fetch indexer');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // POST /api/indexers
  app.post(
    '/api/indexers',
    {
      schema: {
        body: createIndexerSchema,
      },
    },
    async (request, reply) => {
      try {
        const data = request.body as CreateIndexerInput;
        const indexer = await indexerService.create(data);
        request.log.info({ name: data.name }, 'Indexer created');
        return reply.status(201).send(indexer);
      } catch (error) {
        request.log.error(error, 'Failed to create indexer');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // PUT /api/indexers/:id
  app.put(
    '/api/indexers/:id',
    {
      schema: {
        params: idParamSchema,
        body: updateIndexerSchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: number };
        const data = request.body as UpdateIndexerInput;
        const indexer = await indexerService.update(id, data);

        if (!indexer) {
          return reply.status(404).send({ error: 'Indexer not found' });
        }

        request.log.info({ id }, 'Indexer updated');
        return indexer;
      } catch (error) {
        request.log.error(error, 'Failed to update indexer');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // DELETE /api/indexers/:id
  app.delete(
    '/api/indexers/:id',
    {
      schema: {
        params: idParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: number };

      try {
        const deleted = await indexerService.delete(id);

        if (!deleted) {
          return reply.status(404).send({ error: 'Indexer not found' });
        }

        request.log.info({ id }, 'Indexer deleted');
        return { success: true };
      } catch (error) {
        request.log.error({ id, error }, 'Failed to delete indexer');
        return reply.status(500).send({
          error: error instanceof Error ? error.message : 'Failed to delete',
        });
      }
    }
  );

  // POST /api/indexers/test (test config without persisting)
  app.post(
    '/api/indexers/test',
    {
      schema: {
        body: createIndexerSchema,
      },
    },
    async (request) => {
      const data = request.body as CreateIndexerInput;
      const result = await indexerService.testConfig({
        type: data.type,
        settings: data.settings as Record<string, unknown>,
      });
      request.log.debug({ type: data.type, success: result.success }, 'Indexer config test result');
      return result;
    }
  );

  // POST /api/indexers/:id/test
  app.post(
    '/api/indexers/:id/test',
    {
      schema: {
        params: idParamSchema,
      },
    },
    async (request) => {
      const { id } = request.params as { id: number };
      const result = await indexerService.test(id);
      request.log.debug({ id, success: result.success }, 'Indexer test result');
      return result;
    }
  );
}
