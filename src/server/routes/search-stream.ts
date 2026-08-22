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
import { SEARCH_DEADLINE_MS } from '@core/utils/constants.js';


const sseFrame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

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

      // The one gate every post-hijack write passes through, heartbeat included. It has to cover
      // the SUCCESS arm too: post-processing degrades rather than rejecting under an abort, so a
      // run abandoned mid-enrichment still arrives at the terminal frame with real results in hand.
      let disconnected = false;
      const writeFrame = (frame: string): void => {
        if (disconnected) return;
        reply.raw.write(frame);
      };
      const emit = (event: string, data: unknown): void => {
        writeFrame(sseFrame(event, data));
      };

      const startEvent: SearchStartEvent = {
        sessionId: session.sessionId,
        indexers: enabledIndexers,
      };
      emit('search-start', startEvent);

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
          writeFrame(SSE_HEARTBEAT_FRAME);
        } catch {
          stopHeartbeatTimer();
        }
      });

      // Bound by ABORT, not by the `Promise.race` the registered surfaces use: those must return a
      // value, so they abandon the loser and it keeps spending paced requests. A socket writer can
      // tear the run instead — every in-flight adapter call rejects, the ABB/MAM throttle and
      // solver-slot waiters are evicted, and the ladder ends at that rung.
      // Deliberately not a member of the per-book search registry: that registry keys on a book id,
      // which this route has no usable value for (`q` is operator-editable), and a refusal costs an
      // interactive searcher a real answer where it costs a scheduled one nothing.
      const deadline = new AbortController();
      let expired = false;
      let deadlineTimer: NodeJS.Timeout | null = setTimeout(() => {
        expired = true;
        deadline.abort();
      }, SEARCH_DEADLINE_MS);
      deadlineTimer.unref();
      const clearDeadline = (): void => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        deadlineTimer = null;
      };

      request.raw.on('close', () => {
        // Flag BEFORE the abort: abort listeners run synchronously inside abort(), so anything
        // reachable from one must already see the socket as unwritable. Clearing the timer without
        // aborting would leave the run with nothing to tear it — strictly worse than an expiry.
        disconnected = true;
        deadline.abort();
        clearDeadline();
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
                emit('indexer-complete', event);
              },
              onError: (indexerId, name, error, elapsedMs) => {
                if (!policy.claimReport(indexerId)) return;
                const event: IndexerErrorEvent = { indexerId, name, error, elapsedMs };
                emit('indexer-error', event);
              },
              onCancelled: (indexerId, name) => {
                const event: IndexerCancelledEvent = { indexerId, name };
                emit('indexer-cancelled', event);
              },
            },
            deadline.signal,
            policy.runOptions,
          );
          return { results, succeeded };
        });

        // The same controller the ladder got, so the tail stops starting NZB fetches at the moment
        // the ladder is torn. It degrades rather than rejecting, which is what keeps AC7 below true.
        const processed = await postProcessSearchResults(ran.results, bookDuration, blacklistService, settingsService, indexerService, request.log, deadline.signal);
        // ran.index is the last attempted rung even after exhaustion; post-processing may remove every hit.
        // Disclose relaxation only with displayed results: relaxedQuery implies results is non-empty.
        const relaxed = ran.index > 0 && processed.results.length > 0;
        const payload: SearchResponsePayload = relaxed ? { ...processed, relaxedQuery: ran.rung.query } : processed;
        emit('search-complete', payload);
      } catch (error: unknown) {
        const fallback = { results: [], durationUnknown: true, unsupportedResults: { count: 0, titles: [] } };
        // The verdict is the closure flag, never the caught value: `abortReason` surfaces the first
        // rejected leg's reason, an ordinary adapter error indistinguishable from a real failure.
        // Attached on this arm only, so a timer that fires while post-processing runs cannot
        // falsify an answer the ladder already produced.
        if (disconnected) {
          // First arm deliberately: a run that expired AND was abandoned trades its budget warn for
          // one log line per terminated run and one place deciding the socket is unwritable.
          request.log.debug({ error: serializeError(error) }, 'Search stream abandoned by client');
        } else if (expired) {
          // `budgetMs` rides as a sibling; serializeError emits a fixed key set that would drop it.
          request.log.warn({ budgetMs: SEARCH_DEADLINE_MS, error: serializeError(error) }, 'Search stream deadline exceeded');
          emit('search-complete', { ...fallback, timedOut: true });
        } else {
          request.log.error({ error: serializeError(error) }, 'Search stream error');
          emit('search-complete', fallback);
        }
      } finally {
        clearDeadline();
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
