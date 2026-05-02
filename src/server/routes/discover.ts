import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { suggestionReasonSchema, type SuggestionRowResponse } from '../../shared/schemas/discovery.js';
import type { DiscoveryService, SettingsService } from '../services/index.js';
import type { TaskRegistry } from '../services/task-registry.js';
import type { SuggestionRow } from '../services/types.js';

/** Maps a DB suggestion row to the API response contract. */
function toSuggestionResponse(row: SuggestionRow): SuggestionRowResponse {
  return {
    id: row.id,
    asin: row.asin,
    title: row.title,
    authorName: row.authorName,
    authorAsin: row.authorAsin,
    narratorName: row.narratorName,
    coverUrl: row.coverUrl,
    duration: row.duration,
    publishedDate: row.publishedDate,
    language: row.language,
    genres: row.genres,
    seriesName: row.seriesName,
    seriesPosition: row.seriesPosition,
    reason: row.reason,
    reasonContext: row.reasonContext,
    score: row.score,
    status: row.status,
    refreshedAt: row.refreshedAt.toISOString(),
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    snoozeUntil: row.snoozeUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

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
      const rows = await discoveryService.getSuggestions(Object.keys(filters).length > 0 ? filters : undefined);
      return rows.map(toSuggestionResponse);
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
      return toSuggestionResponse(result);
    },
  );

  // POST /api/discover/suggestions/:id/mark-added — status flip only (#524)
  app.post<{ Params: IdParam }>(
    '/api/discover/suggestions/:id/mark-added',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const result = await discoveryService.markSuggestionAdded(request.params.id);
      if (!result) {
        return reply.status(404).send({ error: 'Suggestion not found' });
      }
      if (result.alreadyAdded) {
        return reply.status(409).send({ error: 'Suggestion already added' });
      }
      if (result.invalidStatus) {
        return reply.status(409).send({ error: 'Suggestion is not pending' });
      }
      return { suggestion: toSuggestionResponse(result.suggestion) };
    },
  );

  // POST /api/discover/refresh
  app.post('/api/discover/refresh', async (_request, reply) => {
    const settings = await settingsService.get('discovery');
    if (!settings.enabled) {
      return reply.status(409).send({ error: 'Discovery is disabled' });
    }
    return taskRegistry.runExclusive('discovery', () => discoveryService.refreshSuggestions());
  });
}
