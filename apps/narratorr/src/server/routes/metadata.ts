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
    async (request) => {
      const { q } = request.query as { q: string };
      return metadataService.search(q);
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
      const { asin } = request.params as { asin: string };
      const author = await metadataService.getAuthor(asin);

      if (!author) {
        return reply.status(404).send({ error: 'Author not found' });
      }

      return author;
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
    async (request) => {
      const { asin } = request.params as { asin: string };
      return metadataService.getAuthorBooks(asin);
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
      const { asin } = request.params as { asin: string };
      const book = await metadataService.getBook(asin);

      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      return book;
    }
  );

  // GET /api/metadata/test
  app.get('/api/metadata/test', async () => {
    return metadataService.testProviders();
  });

  // GET /api/metadata/providers
  app.get('/api/metadata/providers', async () => {
    return metadataService.getProviders();
  });
}
