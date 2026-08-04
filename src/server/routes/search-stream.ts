import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { type IndexerSearchService } from '../services/indexer-search.service.js';
import { type IndexerService } from '../services/indexer.service.js';
import { type BlacklistService } from '../services/blacklist.service.js';
import { type SettingsService } from '../services/settings.service.js';
import { type SearchSessionManager } from '../services/search-session.js';
import { postProcessSearchResults } from '../services/search-pipeline.js';
import { cleanIndexerQuery } from '../services/indexer-query.js';
import { buildQueryLadder, runQueryLadder } from '../services/search-query-ladder.js';
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

      // Reject queries that collapse to empty after punctuation cleanup before
      // we open the SSE stream — keeps the failure as a normal HTTP response.
      if (!cleanIndexerQuery(q)) {
        return reply.status(400).send({ error: 'Search query is empty after punctuation cleanup' });
      }

      // Query enabled indexers before starting SSE stream
      const enabledIndexers = await indexerSearchService.getEnabledIndexers();

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

      // Keep the stream warm while the search is in flight (#1799). A single slow
      // FlareSolverr-routed indexer can idle the connection toward the ~60s proxy
      // cutoff with no interim frames; the shared heartbeat frame prevents that.
      // The frame is a named `hb` event (#1798) which this stream has no client-side
      // listener for — EventSource ignores unmatched named events, so it stays a
      // pure keepalive here while doubling as the broadcaster's liveness signal.
      let heartbeatTimer: NodeJS.Timeout | null = null;
      const stopHeartbeatTimer = (): void => {
        stopHeartbeat(heartbeatTimer);
        heartbeatTimer = null;
      };
      heartbeatTimer = startHeartbeat(() => {
        // Runs from a setInterval callback with no caller on the stack — a throw
        // here (broken pipe / a tick after reply.raw.end()) would crash the
        // process, so guard the write and self-stop on failure (mirrors the
        // broadcaster's writeToAll pruning).
        try {
          reply.raw.write(SSE_HEARTBEAT_FRAME);
        } catch {
          stopHeartbeatTimer();
        }
      });

      // Register cleanup on client disconnect
      request.raw.on('close', () => {
        stopHeartbeatTimer();
        sessionManager.cleanup(session.sessionId);
      });

      // Run the streaming search through the query ladder (#2104).
      //
      // The interactive surface runs the FULL ladder with NO floor — the user is
      // reading the results and makes the call, so corroboration is theirs to
      // do. Rung 1 is the user's `q` VERBATIM: `deriveQuery` prefills
      // "{title} {author}" but the query is editable, and relaxing a string the
      // user typed would be a surprise. Relaxed rungs relax the CANONICAL
      // `title`, sent separately — so an edited query that returns hits never
      // fires the ladder at all, and when `title` is absent entirely there is
      // nothing to relax and only rung 1 runs.
      //
      // `session.controllers` is the same map on every rung, so an indexer the
      // user cancels stays cancelled: `searchAllStreaming`'s pre-adapter abort
      // guard skips it without emitting a duplicate frame. Per-indexer counts
      // need no buffering either — the client replaces its entry by `indexerId`,
      // so the winning rung's numbers are the ones left on screen.
      try {
        const ladder = buildQueryLadder({ title: title ?? '', author, query: q });
        const ran = await runQueryLadder(ladder, async (rung) => {
          let succeeded = 0;
          const results = await indexerSearchService.searchAllStreaming(
            rung.query,
            { limit, author: rung.author, title, rankingAuthor: author },
            session.controllers,
            {
              onComplete: (indexerId, name, resultCount, elapsedMs) => {
                succeeded++;
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
          return { results, succeeded };
        });

        const processed = await postProcessSearchResults(ran.results, bookDuration, blacklistService, settingsService, indexerService, request.log);
        // Disclose the winning rung only when a RELAXED one actually produced the
        // releases being shown. Both halves are load-bearing:
        //
        //  - `ran.index > 0` — rung 1 is the query the user asked for, so there
        //    is nothing to tell them.
        //  - `processed.results.length > 0` — `runQueryLadder` reports the last
        //    rung it ATTEMPTED, so a ladder that exhausted, or one that aborted on
        //    a later-rung outage, also lands on an index > 0 with an empty set;
        //    and a rung that did return releases can still have every one of them
        //    removed by the blacklist/quality/language gates above. In all three
        //    the notice would sit next to "No releases found" and claim a match
        //    that never happened.
        //
        // The resulting payload invariant is what the client relies on:
        // `relaxedQuery` present implies `results` is non-empty.
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
