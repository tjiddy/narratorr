import { type FastifyInstance } from 'fastify';
import { type MetadataService } from '../services/metadata.service.js';
import { metadataSearchQuerySchema, asinParamSchema } from '../../shared/schemas.js';

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
        return metadataService.search(q);
      } catch (error) {
        request.log.error(error, 'Metadata search failed');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // GET /api/metadata/authors/:asin
  app.get(
    '/api/metadata/authors/:asin',
    {
      schema: {
        params: asinParamSchema,
      },
    },
    async (request, reply) => {
      try {
        const { asin } = request.params as { asin: string };
        request.log.debug({ asin }, 'Fetching author metadata');
        const author = await metadataService.getAuthor(asin);

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

  // GET /api/metadata/authors/:asin/books
  app.get(
    '/api/metadata/authors/:asin/books',
    {
      schema: {
        params: asinParamSchema,
      },
    },
    async (request, reply) => {
      try {
        const { asin } = request.params as { asin: string };
        request.log.debug({ asin }, 'Fetching author books');
        return metadataService.getAuthorBooks(asin);
      } catch (error) {
        request.log.error(error, 'Failed to fetch author books');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // GET /api/metadata/books/:asin
  app.get(
    '/api/metadata/books/:asin',
    {
      schema: {
        params: asinParamSchema,
      },
    },
    async (request, reply) => {
      try {
        const { asin } = request.params as { asin: string };
        request.log.debug({ asin }, 'Fetching book metadata');
        const book = await metadataService.getBook(asin);

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
      return metadataService.testProviders();
    } catch (error) {
      request.log.error(error, 'Metadata provider test failed');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /api/metadata/providers
  app.get('/api/metadata/providers', async (request, reply) => {
    try {
      return metadataService.getProviders();
    } catch (error) {
      request.log.error(error, 'Failed to fetch metadata providers');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}
