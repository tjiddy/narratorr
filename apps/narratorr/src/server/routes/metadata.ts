import { type FastifyInstance } from 'fastify';
import { type MetadataService } from '../services/metadata.service.js';
import { metadataSearchQuerySchema, providerIdParamSchema } from '../../shared/schemas.js';

export async function metadataRoutes(app: FastifyInstance, metadataService: MetadataService) {
  // GET /api/metadata/search?q=
  app.get(
    '/api/metadata/search',
    {
      schema: {
        querystring: metadataSearchQuerySchema,
      },
    },
    async (request, reply) => {
      try {
        const { q } = request.query as { q: string };
        request.log.debug({ q }, 'Metadata search');
        return await metadataService.search(q);
      } catch (error) {
        request.log.error(error, 'Metadata search failed');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // GET /api/metadata/authors/:id
  app.get(
    '/api/metadata/authors/:id',
    {
      schema: {
        params: providerIdParamSchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        request.log.debug({ id }, 'Fetching author metadata');
        const author = await metadataService.getAuthor(id);

        if (!author) {
          return reply.status(404).send({ error: 'Author not found' });
        }

        return author;
      } catch (error) {
        request.log.error(error, 'Failed to fetch author metadata');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // GET /api/metadata/authors/:id/books
  app.get(
    '/api/metadata/authors/:id/books',
    {
      schema: {
        params: providerIdParamSchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        request.log.debug({ id }, 'Fetching author books');
        return await metadataService.getAuthorBooks(id);
      } catch (error) {
        request.log.error(error, 'Failed to fetch author books');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // GET /api/metadata/books/:id
  app.get(
    '/api/metadata/books/:id',
    {
      schema: {
        params: providerIdParamSchema,
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        request.log.debug({ id }, 'Fetching book metadata');
        const book = await metadataService.getBook(id);

        if (!book) {
          return reply.status(404).send({ error: 'Book not found' });
        }

        return book;
      } catch (error) {
        request.log.error(error, 'Failed to fetch book metadata');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // GET /api/metadata/test
  app.get('/api/metadata/test', async (request, reply) => {
    try {
      return await metadataService.testProviders();
    } catch (error) {
      request.log.error(error, 'Metadata provider test failed');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /api/metadata/providers
  app.get('/api/metadata/providers', async (request, reply) => {
    try {
      return await metadataService.getProviders();
    } catch (error) {
      request.log.error(error, 'Failed to fetch metadata providers');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
