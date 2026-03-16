import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DiscoveryService, SettingsService } from '../services/index.js';

export interface DiscoverRouteDeps {
  discoveryService: DiscoveryService;
  settingsService: SettingsService;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
type IdParam = z.infer<typeof idParamSchema>;

const suggestionsQuerySchema = z.object({
  reason: z.enum(['author', 'series', 'genre', 'narrator']).optional(),
  author: z.string().optional(),
});
type SuggestionsQuery = z.infer<typeof suggestionsQuerySchema>;

export async function discoverRoutes(app: FastifyInstance, deps: DiscoverRouteDeps) {
  const { discoveryService, settingsService } = deps;

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

  // POST /api/discover/refresh
  app.post('/api/discover/refresh', async (_request, reply) => {
    const settings = await settingsService.get('discovery');
    if (!settings.enabled) {
      return reply.status(409).send({ error: 'Discovery is disabled' });
    }
    const result = await discoveryService.refreshSuggestions();
    return result;
  });

  // GET /api/discover/stats
  app.get('/api/discover/stats', async () => {
    return discoveryService.getStats();
  });
}
