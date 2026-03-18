import { type FastifyInstance } from 'fastify';
import { type z } from 'zod';
import { type MetadataService } from '../services/metadata.service.js';
import { metadataSearchQuerySchema, providerIdParamSchema, type MetadataSearchQuery } from '../../shared/schemas.js';

type ProviderIdParam = z.infer<typeof providerIdParamSchema>;

export async function metadataRoutes(app: FastifyInstance, metadataService: MetadataService) {
  // GET /api/metadata/search?q=
  app.get<{ Querystring: MetadataSearchQuery }>(
    '/api/metadata/search',
    {
      schema: {
        querystring: metadataSearchQuerySchema,
      },
    },
    async (request) => {
      const { q } = request.query;
      request.log.debug({ q }, 'Metadata search');
      return metadataService.search(q);
    }
  );

  // GET /api/metadata/authors/:id
  app.get<{ Params: ProviderIdParam }>(
    '/api/metadata/authors/:id',
    {
      schema: {
        params: providerIdParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      request.log.debug({ id }, 'Fetching author metadata');
      const author = await metadataService.getAuthor(id);

      if (!author) {
        return reply.status(404).send({ error: 'Author not found' });
      }

      return author;
    }
  );

  // GET /api/metadata/authors/:id/books
  app.get<{ Params: ProviderIdParam }>(
    '/api/metadata/authors/:id/books',
    {
      schema: {
        params: providerIdParamSchema,
      },
    },
    async (request) => {
      const { id } = request.params;
      request.log.debug({ id }, 'Fetching author books');
      return metadataService.getAuthorBooks(id);
    }
  );

  // GET /api/metadata/books/:id
  app.get<{ Params: ProviderIdParam }>(
    '/api/metadata/books/:id',
    {
      schema: {
        params: providerIdParamSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      request.log.debug({ id }, 'Fetching book metadata');
      const book = await metadataService.getBook(id);

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
  app.get('/api/metadata/providers', () => {
    return metadataService.getProviders();
  });
}
