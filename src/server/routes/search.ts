import { type FastifyInstance } from 'fastify';
import { type IndexerService } from '../services';
import { type DownloadOrchestrator } from '../services/download-orchestrator.js';
import { type BlacklistService } from '../services';
import { type SettingsService } from '../services';
import { isMultiPartUsenetPost } from '../../core/utils/index.js';
import { getErrorMessage } from '../utils/error-message.js';
import { DuplicateDownloadError } from '../services/download.service.js';
import { filterAndRankResults } from '../services/search-pipeline.js';
import {
  searchQuerySchema,
  grabSchema,
  type SearchQuery,
  type GrabInput,
} from '../../shared/schemas.js';

export async function searchRoutes(
  app: FastifyInstance,
  indexerService: IndexerService,
  downloadOrchestrator: DownloadOrchestrator,
  blacklistService: BlacklistService,
  settingsService: SettingsService,
) {
  // GET /api/search
  app.get<{ Querystring: SearchQuery }>(
    '/api/search',
    {
      schema: {
        querystring: searchQuerySchema,
      },
    },
    async (request, reply) => {
      const { q, limit, author, title, bookDuration } = request.query;

      // Reject invalid bookDuration (transformed to null by schema)
      if (bookDuration === null) {
        return reply.status(400).send({ error: 'bookDuration must be a positive number' });
      }

      request.log.debug({ q, author, title, bookDuration }, 'Search request');
      const allResults = await indexerService.searchAll(q, { limit, author, title });

      // Filter multi-part Usenet posts
      const unsupportedTitles: string[] = [];
      const results = allResults.filter((r) => {
        if (r.protocol !== 'usenet') return true;
        const sourceTitle = r.rawTitle ?? r.title;
        const multiPart = isMultiPartUsenetPost(sourceTitle);
        if (multiPart.match && multiPart.total! > 1) {
          request.log.debug(`Filtered multi-part Usenet result: ${sourceTitle} (part ${multiPart.part} of ${multiPart.total})`);
          unsupportedTitles.push(sourceTitle);
          return false;
        }
        return true;
      });

      // Blacklist filtering by infoHash and/or guid
      const hashes = results.map((r: { infoHash?: string }) => r.infoHash).filter((h): h is string => !!h);
      const guids = results.map((r: { guid?: string }) => r.guid).filter((g): g is string => !!g);
      let filteredResults = results;
      if (hashes.length > 0 || guids.length > 0) {
        const { blacklistedHashes, blacklistedGuids } = await blacklistService.getBlacklistedIdentifiers(hashes, guids);
        filteredResults = results.filter((r: { infoHash?: string; guid?: string }) =>
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

      return {
        results: ranked.results,
        durationUnknown: ranked.durationUnknown,
        unsupportedResults: { count: unsupportedTitles.length, titles: unsupportedTitles },
      };
    }
  );

  // POST /api/search/grab
  app.post<{ Body: GrabInput }>(
    '/api/search/grab',
    {
      schema: {
        body: grabSchema,
      },
    },
    async (request, reply) => {
      const data = request.body;

      try {
        request.log.info({ title: data.title }, 'Grab requested');
        request.log.debug({ title: data.title, protocol: data.protocol, downloadUrl: data.downloadUrl, bookId: data.bookId }, 'Grab details');
        const download = await downloadOrchestrator.grab(data);
        request.log.debug({ downloadId: download.id, status: download.status, externalId: download.externalId }, 'Grab completed');
        return await reply.status(201).send(download);
      } catch (error: unknown) {
        if (error instanceof DuplicateDownloadError) {
          if (error.code === 'ACTIVE_DOWNLOAD_EXISTS') {
            return reply.status(409).send({ code: 'ACTIVE_DOWNLOAD_EXISTS' });
          }
          // PIPELINE_ACTIVE — propagate to error-handler plugin (returns 409 { error: message })
          throw error;
        }
        request.log.error(error, 'Grab failed');
        const message = getErrorMessage(error);
        return reply.status(500).send({ error: message });
      }
    }
  );
}
