import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idParamSchema } from '../../shared/schemas.js';
import type { BookService, SeriesCardService } from '../services/index.js';

type IdParam = z.infer<typeof idParamSchema>;

const seriesSearchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Query is required').max(500),
});
type SeriesSearchQuery = z.infer<typeof seriesSearchQuerySchema>;

const bindSeriesBodySchema = z.object({
  hardcoverSeriesId: z.number().int().positive(),
});
type BindSeriesBody = z.infer<typeof bindSeriesBodySchema>;

export function registerSeriesRoutes(app: FastifyInstance, bookService: BookService, seriesCardService: SeriesCardService) {
  app.get<{ Params: IdParam }>(
    '/api/books/:id/series',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const book = await bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }
      const card = await seriesCardService.getSeriesForBook(id);
      return { series: card };
    },
  );

  app.post<{ Params: IdParam }>(
    '/api/books/:id/series/refresh',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const book = await bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }
      const card = await seriesCardService.refreshSeriesForBook(id);
      return { series: card };
    },
  );

  // GET /api/books/:id/series/search?q= — proxy HardcoverClient.searchSeries
  // for the manual Fix Series picker. Degrades to an empty list when no key
  // is configured (never a 500).
  app.get<{ Params: IdParam; Querystring: SeriesSearchQuery }>(
    '/api/books/:id/series/search',
    { schema: { params: idParamSchema, querystring: seriesSearchQuerySchema } },
    async (request, reply) => {
      const { id } = request.params;
      const book = await bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }
      const candidates = await seriesCardService.searchSeriesCandidates(request.query.q);
      return { candidates };
    },
  );

  // POST /api/books/:id/series/bind — persist the chosen Hardcover series id
  // and sync the book display fields. Returns the rebuilt (id-sourced) card.
  app.post<{ Params: IdParam; Body: BindSeriesBody }>(
    '/api/books/:id/series/bind',
    { schema: { params: idParamSchema, body: bindSeriesBodySchema } },
    async (request, reply) => {
      const { id } = request.params;
      const book = await bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }
      const card = await seriesCardService.bindHardcoverSeries(id, request.body.hardcoverSeriesId);
      if (!card) {
        return reply.status(502).send({ error: 'Failed to bind Hardcover series' });
      }
      request.log.info({ id, hardcoverSeriesId: request.body.hardcoverSeriesId }, 'Series bound to book');
      return { series: card };
    },
  );
}
