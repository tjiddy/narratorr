import type { FastifyInstance } from 'fastify';
import type { EventHistoryService } from '../services';
import { idParamSchema, eventHistoryQuerySchema, paginationParamsSchema, DEFAULT_LIMITS } from '../../shared/schemas.js';
import { z } from 'zod';

type IdParam = z.infer<typeof idParamSchema>;

const eventHistoryListQuerySchema = eventHistoryQuerySchema.merge(paginationParamsSchema);
type EventHistoryListQuery = z.infer<typeof eventHistoryListQuerySchema>;

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
    async (request, reply) => {
      try {
        const { eventType, search, limit, offset } = request.query;
        request.log.debug({ eventType, search, limit, offset }, 'Fetching event history');
        const pagination = { limit: limit ?? DEFAULT_LIMITS.eventHistory, offset };
        return await eventHistoryService.getAll({ eventType, search }, pagination);
      } catch (error) {
        request.log.error(error, 'Failed to fetch event history');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // GET /api/event-history/books/:bookId
  app.get<{ Params: BookIdParam }>(
    '/api/event-history/books/:bookId',
    { schema: { params: bookIdParamSchema } },
    async (request, reply) => {
      try {
        const { bookId } = request.params;
        request.log.debug({ bookId }, 'Fetching book event history');
        return await eventHistoryService.getByBookId(bookId);
      } catch (error) {
        request.log.error(error, 'Failed to fetch book event history');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // DELETE /api/event-history/:id — delete a single event
  app.delete<{ Params: IdParam }>(
    '/api/event-history/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      try {
        const deleted = await eventHistoryService.delete(request.params.id);
        if (!deleted) return await reply.status(404).send({ error: 'Event not found' });
        return { success: true };
      } catch (error) {
        request.log.error(error, 'Failed to delete event');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // DELETE /api/event-history — bulk delete events (optional eventType filter)
  app.delete<{ Querystring: { eventType?: string } }>(
    '/api/event-history',
    { schema: { querystring: z.object({ eventType: eventHistoryQuerySchema.shape.eventType }) } },
    async (request, reply) => {
      try {
        const { eventType } = request.query;
        const filters = eventType ? { eventType } : undefined;
        const deleted = await eventHistoryService.deleteAll(filters);
        return { deleted };
      } catch (error) {
        request.log.error(error, 'Failed to bulk delete events');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // POST /api/event-history/:id/mark-failed
  app.post<{ Params: IdParam }>(
    '/api/event-history/:id/mark-failed',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      try {
        request.log.info({ id }, 'Marking event as failed');
        return await eventHistoryService.markFailed(id);
      } catch (error) {
        request.log.error({ id, error }, 'Mark as failed error');
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (message.includes('not found')) return reply.status(404).send({ error: message });
        if (message.includes('does not support') || message.includes('no associated') || message.includes('no info hash')) {
          return reply.status(400).send({ error: message });
        }
        return reply.status(500).send({ error: message });
      }
    },
  );
}
