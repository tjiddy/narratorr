import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { type IndexerSearchService } from '../services/indexer-search.service.js';
import { type IndexerService } from '../services/indexer.service.js';
import { type BlacklistService } from '../services/blacklist.service.js';
import { type SettingsService } from '../services/settings.service.js';
import { type SearchSessionManager } from '../services/search-session.js';
import { postProcessSearchResults } from '../services/search-pipeline.js';
import { cleanIndexerQuery } from '../services/indexer-query.js';
import { buildQueryLadder, runQueryLadder } from '../services/search-query-ladder.js';
import { createRunExclusionPolicy } from '../services/search-run-exclusion.js';
import { searchQuerySchema, type SearchQuery } from '@shared/schemas.js';
import type {
  SearchStartEvent,
  IndexerCompleteEvent,
  IndexerErrorEvent,
  IndexerCancelledEvent,
  SearchResponsePayload,
} from '@shared/schemas/search-stream.js';
import { serializeError } from '../utils/serialize-error.js';
import { SSE_HEARTBEAT_FRAME, startHeartbeat, stopHeartbeat } from '../utils/sse-stream.js';


function writeSSE(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function searchStreamRoutes(
  app: FastifyInstance,
  indexerSearchService: IndexerSearchService,
  blacklistService: BlacklistService,
  settingsService: SettingsService,
  indexerService: IndexerService,
  sessionManager: SearchSessionManager,
): Promise<void> {
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

      // Validate before hijacking so failure remains a normal HTTP response.
      if (!cleanIndexerQuery(q)) {
        return reply.status(400).send({ error: 'Search query is empty after punctuation cleanup' });
      }

      // Resolve indexers before hijacking so lookup failures remain HTTP errors.
      const enabledIndexers = await indexerSearchService.getEnabledIndexers();

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      reply.hijack();

      const session = sessionManager.create(enabledIndexers);

      const startEvent: SearchStartEvent = {
        sessionId: session.sessionId,
        indexers: enabledIndexers,
      };
      writeSSE(reply, 'search-start', startEvent);

      // Slow FlareSolverr searches can cross proxy idle cutoffs; named hb frames keep transport alive.
      // EventSource ignores the unmatched name here while broadcaster clients use it for liveness.
      let heartbeatTimer: NodeJS.Timeout | null = null;
      const stopHeartbeatTimer = (): void => {
        stopHeartbeat(heartbeatTimer);
        heartbeatTimer = null;
      };
      heartbeatTimer = startHeartbeat(() => {
        // Timer callbacks have no caller; self-stop on broken-pipe or post-end writes.
        try {
          reply.raw.write(SSE_HEARTBEAT_FRAME);
        } catch {
          stopHeartbeatTimer();
        }
      });

      request.raw.on('close', () => {
        stopHeartbeatTimer();
        sessionManager.cleanup(session.sessionId);
      });

      // Interactive search runs the full ladder without a floor; the user judges the results.
      // Rung 1 preserves editable q; later rungs derive from canonical title, so no title means no relaxation.
      // Reuse controllers across rungs so cancellation persists; the client replaces per-indexer counts.
      // The run exclusion policy is scoped to this request, exactly like the session's controllers.
      try {
        // `q` has never been cleaned, only validated above, so it is the apostrophe-bearing source.
        const ladder = buildQueryLadder({ title: title ?? '', author, query: q, queryWithApostrophes: q });
        const policy = createRunExclusionPolicy();
        const ran = await runQueryLadder(ladder, async (rung) => {
          let succeeded = 0;
          const results = await indexerSearchService.searchAllStreaming(
            rung.query,
            { limit, author: rung.author, title, rankingAuthor: author, queryWithApostrophes: rung.queryWithApostrophes },
            session.controllers,
            {
              onComplete: (indexerId, name, resultCount, elapsedMs) => {
                succeeded++;
                const event: IndexerCompleteEvent = { indexerId, name, resultCount, elapsedMs };
                writeSSE(reply, 'indexer-complete', event);
              },
              onError: (indexerId, name, error, elapsedMs) => {
                if (!policy.claimReport(indexerId)) return;
                const event: IndexerErrorEvent = { indexerId, name, error, elapsedMs };
                writeSSE(reply, 'indexer-error', event);
              },
              onCancelled: (indexerId, name) => {
                const event: IndexerCancelledEvent = { indexerId, name };
                writeSSE(reply, 'indexer-cancelled', event);
              },
            },
            undefined,
            policy.runOptions,
          );
          return { results, succeeded };
        });

        const processed = await postProcessSearchResults(ran.results, bookDuration, blacklistService, settingsService, indexerService, request.log);
        // ran.index is the last attempted rung even after exhaustion; post-processing may remove every hit.
        // Disclose relaxation only with displayed results: relaxedQuery implies results is non-empty.
        const relaxed = ran.index > 0 && processed.results.length > 0;
        const payload: SearchResponsePayload = relaxed ? { ...processed, relaxedQuery: ran.rung.query } : processed;
        writeSSE(reply, 'search-complete', payload);
      } catch (error: unknown) {
        request.log.error({ error: serializeError(error) }, 'Search stream error');
        writeSSE(reply, 'search-complete', {
          results: [],
          durationUnknown: true,
          unsupportedResults: { count: 0, titles: [] },
        });
      } finally {
        stopHeartbeatTimer();
        reply.raw.end();
        sessionManager.cleanup(session.sessionId);
      }
    },
  );

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
