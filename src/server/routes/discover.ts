import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { suggestionReasonSchema } from '../../shared/schemas/discovery.js';
import type { DiscoveryService, SettingsService } from '../services/index.js';
import type { TaskRegistry } from '../services/task-registry.js';
import { getErrorMessage } from '../utils/error-message.js';

export interface DiscoverRouteDeps {
  discoveryService: DiscoveryService;
  settingsService: SettingsService;
  taskRegistry: TaskRegistry;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
type IdParam = z.infer<typeof idParamSchema>;

const suggestionsQuerySchema = z.object({
  reason: suggestionReasonSchema.optional(),
  author: z.string().optional(),
});
type SuggestionsQuery = z.infer<typeof suggestionsQuerySchema>;

export async function discoverRoutes(app: FastifyInstance, deps: DiscoverRouteDeps) {
  const { discoveryService, settingsService, taskRegistry } = deps;

  // GET /api/discover/suggestions
  app.get<{ Querystring: SuggestionsQuery }>(
    '/api/discover/suggestions',
    { schema: { querystring: suggestionsQuerySchema } },
    async (request) => {
      const { reason, author } = request.query;
      const filters: { reason?: SuggestionsQuery['reason']; author?: string } = {};
      if (reason) filters.reason = reason;
      if (author) filters.author = author;
      return discoveryService.getSuggestions(Object.keys(filters).length > 0 ? filters : undefined);
    },
  );

  // POST /api/discover/suggestions/:id/dismiss
  app.post<{ Params: IdParam }>(
    '/api/discover/suggestions/:id/dismiss',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const result = await discoveryService.dismissSuggestion(request.params.id);
      if (!result) {
        return reply.status(404).send({ error: 'Suggestion not found' });
      }
      return result;
    },
  );

  // POST /api/discover/suggestions/:id/add
  app.post<{ Params: IdParam }>(
    '/api/discover/suggestions/:id/add',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const result = await discoveryService.addSuggestion(request.params.id);
      if (!result) {
        return reply.status(404).send({ error: 'Suggestion not found' });
      }
      if (result.alreadyAdded) {
        return reply.status(409).send({ error: 'Suggestion already added' });
      }
      if (result.duplicate) {
        return { suggestion: result.suggestion, book: result.book, duplicate: true };
      }
      return { suggestion: result.suggestion, book: result.book };
    },
  );

  // POST /api/discover/suggestions/:id/snooze
  const snoozeBodySchema = z.object({ durationDays: z.number().int().min(1).max(365) });
  type SnoozeBody = z.infer<typeof snoozeBodySchema>;

  app.post<{ Params: IdParam; Body: SnoozeBody }>(
    '/api/discover/suggestions/:id/snooze',
    { schema: { params: idParamSchema, body: snoozeBodySchema } },
    async (request, reply) => {
      const result = await discoveryService.snoozeSuggestion(request.params.id, request.body.durationDays);
      if (result === null) {
        return reply.status(404).send({ error: 'Suggestion not found' });
      }
      if (result === 'conflict') {
        return reply.status(409).send({ error: 'Suggestion is not in pending status' });
      }
      return result;
    },
  );

  // POST /api/discover/refresh
  app.post('/api/discover/refresh', async (_request, reply) => {
    const settings = await settingsService.get('discovery');
    if (!settings.enabled) {
      return reply.status(409).send({ error: 'Discovery is disabled' });
    }
    try {
      const result = await taskRegistry.runExclusive('discovery', () => discoveryService.refreshSuggestions());
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.includes('already running')) {
        return reply.status(409).send({ error: message });
      }
      return reply.status(500).send({ error: message });
    }
  });

  // GET /api/discover/stats
  app.get('/api/discover/stats', async () => {
    return discoveryService.getStats();
  });
}
