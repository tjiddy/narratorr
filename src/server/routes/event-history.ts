import type { FastifyInstance } from 'fastify';
import type { EventHistoryService } from '../services';
import { idParamSchema, eventHistoryQuerySchema, paginationParamsSchema, DEFAULT_LIMITS } from '../../shared/schemas.js';
import { z } from 'zod';

type IdParam = z.infer<typeof idParamSchema>;

const eventHistoryListQuerySchema = eventHistoryQuerySchema.merge(paginationParamsSchema);
type EventHistoryListQuery = z.infer<typeof eventHistoryListQuerySchema>;

const bulkDeleteQuerySchema = z.object({ eventType: eventHistoryQuerySchema.shape.eventType });
type BulkDeleteQuery = z.infer<typeof bulkDeleteQuerySchema>;

const bookIdParamSchema = z.object({
  bookId: z.string().transform((val, ctx) => {
    const parsed = parseInt(val, 10);
    if (isNaN(parsed)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid book ID' });
      return z.NEVER;
    }
    return parsed;
  }),
});

type BookIdParam = z.infer<typeof bookIdParamSchema>;

export async function eventHistoryRoutes(app: FastifyInstance, eventHistoryService: EventHistoryService) {
  // GET /api/event-history
  app.get<{ Querystring: EventHistoryListQuery }>(
    '/api/event-history',
    { schema: { querystring: eventHistoryListQuerySchema } },
    async (request) => {
      const { eventType, search, limit, offset } = request.query;
      request.log.debug({ eventType, search, limit, offset }, 'Fetching event history');
      const pagination = { limit: limit ?? DEFAULT_LIMITS.eventHistory, ...(offset !== undefined && { offset }) };
      return eventHistoryService.getAll({ ...(eventType !== undefined && { eventType }), ...(search !== undefined && { search }) }, pagination);
    },
  );

  // GET /api/event-history/books/:bookId
  app.get<{ Params: BookIdParam }>(
    '/api/event-history/books/:bookId',
    { schema: { params: bookIdParamSchema } },
    async (request) => {
      const { bookId } = request.params;
      request.log.debug({ bookId }, 'Fetching book event history');
      return eventHistoryService.getByBookId(bookId);
    },
  );

  // DELETE /api/event-history/:id — delete a single event
  app.delete<{ Params: IdParam }>(
    '/api/event-history/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const deleted = await eventHistoryService.delete(request.params.id);
      if (!deleted) return reply.status(404).send({ error: 'Event not found' });
      return { success: true };
    },
  );

  // DELETE /api/event-history — bulk delete events (optional eventType filter)
  app.delete<{ Querystring: BulkDeleteQuery }>(
    '/api/event-history',
    { schema: { querystring: bulkDeleteQuerySchema } },
    async (request) => {
      const { eventType } = request.query;
      const filters = eventType ? { eventType } : undefined;
      const deleted = await eventHistoryService.deleteAll(filters);
      return { deleted };
    },
  );

  // POST /api/event-history/:id/mark-failed
  app.post<{ Params: IdParam }>(
    '/api/event-history/:id/mark-failed',
    { schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params;

      request.log.info({ id }, 'Marking event as failed');
      return eventHistoryService.markFailed(id);
    },
  );
}
