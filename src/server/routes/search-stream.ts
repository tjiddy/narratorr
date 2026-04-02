import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { type IndexerService } from '../services/indexer.service.js';
import { type BlacklistService } from '../services/blacklist.service.js';
import { type SettingsService } from '../services/settings.service.js';
import { type SearchSessionManager } from '../services/search-session.js';
import { isMultiPartUsenetPost } from '../../core/utils/index.js';
import { filterAndRankResults } from '../services/search-pipeline.js';
import { searchQuerySchema, type SearchQuery } from '../../shared/schemas.js';

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

      // Create session with actual indexer list so controllers are populated
      const session = sessionManager.create(enabledIndexers);

      writeSSE(reply, 'search-start', {
        sessionId: session.sessionId,
        indexers: enabledIndexers,
      });

      // Register cleanup on client disconnect
      request.raw.on('close', () => {
        sessionManager.cleanup(session.sessionId);
      });

      reply.hijack();

      // Run streaming search
      try {
        const allResults = await indexerService.searchAllStreaming(
          q,
          { limit, author, title },
          session.controllers,
          {
            onComplete: (indexerId, name, resultCount, elapsedMs) => {
              writeSSE(reply, 'indexer-complete', { indexerId, name, resultCount, elapsedMs });
            },
            onError: (indexerId, name, error, elapsedMs) => {
              writeSSE(reply, 'indexer-error', { indexerId, name, error, elapsedMs });
            },
            onCancelled: (indexerId, name) => {
              writeSSE(reply, 'indexer-cancelled', { indexerId, name });
            },
          },
        );

        // Filter multi-part Usenet posts
        const unsupportedTitles: string[] = [];
        const filtered = allResults.filter((r) => {
          if (r.protocol !== 'usenet') return true;
          const sourceTitle = r.rawTitle ?? r.title;
          const multiPart = isMultiPartUsenetPost(sourceTitle);
          if (multiPart.match && multiPart.total! > 1) {
            unsupportedTitles.push(sourceTitle);
            return false;
          }
          return true;
        });

        // Blacklist filtering
        const hashes = filtered.map(r => r.infoHash).filter((h): h is string => !!h);
        const guids = filtered.map(r => r.guid).filter((g): g is string => !!g);
        let filteredResults = filtered;
        if (hashes.length > 0 || guids.length > 0) {
          const { blacklistedHashes, blacklistedGuids } = await blacklistService.getBlacklistedIdentifiers(hashes, guids);
          filteredResults = filtered.filter(r =>
            (!r.infoHash || !blacklistedHashes.has(r.infoHash)) &&
            (!r.guid || !blacklistedGuids.has(r.guid)),
          );
        }

        // Quality filtering and ranking
        const qualitySettings = await settingsService.get('quality');
        const ranked = filterAndRankResults(
          filteredResults,
          bookDuration,
          qualitySettings.grabFloor,
          qualitySettings.minSeeders,
          qualitySettings.protocolPreference,
          qualitySettings.rejectWords,
          qualitySettings.requiredWords,
          qualitySettings.preferredLanguage,
        );

        writeSSE(reply, 'search-complete', {
          results: ranked.results,
          durationUnknown: ranked.durationUnknown,
          unsupportedResults: { count: unsupportedTitles.length, titles: unsupportedTitles },
        });
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
