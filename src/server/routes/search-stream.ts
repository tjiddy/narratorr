import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { type IndexerService } from '../services/indexer.service.js';
import { type BlacklistService } from '../services/blacklist.service.js';
import { type SettingsService } from '../services/settings.service.js';
import { type SearchSessionManager } from '../services/search-session.js';
import { postProcessSearchResults } from '../services/search-pipeline.js';
import { searchQuerySchema, type SearchQuery } from '../../shared/schemas.js';
import type {
  SearchStartEvent,
  IndexerCompleteEvent,
  IndexerErrorEvent,
  IndexerCancelledEvent,
} from '../../shared/schemas/search-stream.js';

function writeSSE(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function searchStreamRoutes(
  app: FastifyInstance,
  indexerService: IndexerService,
  blacklistService: BlacklistService,
  settingsService: SettingsService,
  sessionManager: SearchSessionManager,
): Promise<void> {
  // GET /api/search/stream — SSE endpoint
  app.get<{ Querystring: SearchQuery }>(
    '/api/search/stream',
    {
      schema: {
        querystring: searchQuerySchema,
      },
    },
    async (request: FastifyRequest<{ Querystring: SearchQuery }>, reply: FastifyReply) => {
      const { q, limit, author, title, bookDuration } = request.query;

      if (bookDuration === null) {
        return reply.status(400).send({ error: 'bookDuration must be a positive number' });
      }

      // Query enabled indexers before starting SSE stream
      const enabledIndexers = await indexerService.getEnabledIndexers();

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      reply.hijack();

      // Create session with actual indexer list so controllers are populated
      const session = sessionManager.create(enabledIndexers);

      const startEvent: SearchStartEvent = {
        sessionId: session.sessionId,
        indexers: enabledIndexers,
      };
      writeSSE(reply, 'search-start', startEvent);

      // Register cleanup on client disconnect
      request.raw.on('close', () => {
        sessionManager.cleanup(session.sessionId);
      });

      // Run streaming search
      try {
        const allResults = await indexerService.searchAllStreaming(
          q,
          { limit, author, title },
          session.controllers,
          {
            onComplete: (indexerId, name, resultCount, elapsedMs) => {
              const event: IndexerCompleteEvent = { indexerId, name, resultCount, elapsedMs };
              writeSSE(reply, 'indexer-complete', event);
            },
            onError: (indexerId, name, error, elapsedMs) => {
              const event: IndexerErrorEvent = { indexerId, name, error, elapsedMs };
              writeSSE(reply, 'indexer-error', event);
            },
            onCancelled: (indexerId, name) => {
              const event: IndexerCancelledEvent = { indexerId, name };
              writeSSE(reply, 'indexer-cancelled', event);
            },
          },
        );

        const processed = await postProcessSearchResults(allResults, bookDuration, blacklistService, settingsService, request.log);
        writeSSE(reply, 'search-complete', processed);
      } catch (error: unknown) {
        request.log.error(error, 'Search stream error');
        writeSSE(reply, 'search-complete', {
          results: [],
          durationUnknown: true,
          unsupportedResults: { count: 0, titles: [] },
        });
      } finally {
        reply.raw.end();
        sessionManager.cleanup(session.sessionId);
      }
    },
  );

  // POST /api/search/stream/:sessionId/cancel/:indexerId
  app.post<{ Params: { sessionId: string; indexerId: string } }>(
    '/api/search/stream/:sessionId/cancel/:indexerId',
    async (request: FastifyRequest<{ Params: { sessionId: string; indexerId: string } }>, reply: FastifyReply) => {
      const { sessionId, indexerId: indexerIdStr } = request.params;
      const indexerId = parseInt(indexerIdStr, 10);

      const cancelled = sessionManager.cancel(sessionId, indexerId);

      if (!cancelled) {
        const session = sessionManager.get(sessionId);
        if (!session) {
          return reply.status(404).send({ error: 'Search session not found' });
        }
        return reply.status(404).send({ error: 'Indexer not found in session' });
      }

      request.log.debug({ sessionId, indexerId }, 'Indexer search cancelled');
      return reply.send({ cancelled: true });
    },
  );
}
