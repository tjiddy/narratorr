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

      // DIAG: log raw results per indexer
      const byIndexer: Record<string, number> = {};
      for (const r of allResults) {
        byIndexer[r.indexer ?? 'unknown'] = (byIndexer[r.indexer ?? 'unknown'] || 0) + 1;
      }
      request.log.debug({ totalRaw: allResults.length, byIndexer }, 'DIAG: raw results from searchAll');
      for (const r of allResults) {
        request.log.debug({ indexer: r.indexer, title: r.title, rawTitle: r.rawTitle, protocol: r.protocol, seeders: r.seeders, size: r.size }, 'DIAG: raw result');
      }

      // Filter multi-part Usenet posts
      const unsupportedTitles: string[] = [];
      const results = allResults.filter((r) => {
        if (r.protocol !== 'usenet') return true;
        const sourceTitle = r.rawTitle ?? r.title;
        const multiPart = isMultiPartUsenetPost(sourceTitle);
        if (multiPart.match && multiPart.total! > 1) {
          request.log.debug({ indexer: r.indexer, title: sourceTitle, part: multiPart.part, total: multiPart.total }, 'DIAG: filtered multi-part Usenet');
          unsupportedTitles.push(sourceTitle);
          return false;
        }
        return true;
      });
      request.log.debug({ afterMultiPart: results.length, filtered: allResults.length - results.length }, 'DIAG: after multi-part filter');

      // Blacklist filtering
      const hashes = results
        .map((r: { infoHash?: string }) => r.infoHash)
        .filter((h): h is string => !!h);
      let filteredResults = results;
      if (hashes.length > 0) {
        const blacklisted = await blacklistService.getBlacklistedHashes(hashes);
        const beforeBlacklist = filteredResults.length;
        filteredResults = results.filter((r: { infoHash?: string }) => !r.infoHash || !blacklisted.has(r.infoHash));
        request.log.debug({ beforeBlacklist, afterBlacklist: filteredResults.length, blacklistedCount: blacklisted.size }, 'DIAG: after blacklist filter');
      }

      // Quality filtering and ranking
      const qualitySettings = await settingsService.get('quality');
      request.log.debug({ grabFloor: qualitySettings.grabFloor, minSeeders: qualitySettings.minSeeders, rejectWords: qualitySettings.rejectWords, requiredWords: qualitySettings.requiredWords, protocolPreference: qualitySettings.protocolPreference }, 'DIAG: quality settings');
      const ranked = filterAndRankResults(
        filteredResults,
        bookDuration,
        qualitySettings.grabFloor,
        qualitySettings.minSeeders,
        qualitySettings.protocolPreference,
        qualitySettings.rejectWords,
        qualitySettings.requiredWords,
      );
      request.log.debug({ beforeQuality: filteredResults.length, afterQuality: ranked.results.length, durationUnknown: ranked.durationUnknown }, 'DIAG: after quality filter');
      if (ranked.results.length < filteredResults.length) {
        const rankedTitles = new Set(ranked.results.map(r => r.title));
        for (const r of filteredResults) {
          if (!rankedTitles.has(r.title)) {
            request.log.debug({ indexer: r.indexer, title: r.title, seeders: r.seeders, size: r.size, protocol: r.protocol }, 'DIAG: filtered by quality gate');
          }
        }
      }

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
