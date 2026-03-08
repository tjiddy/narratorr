import { type FastifyInstance } from 'fastify';
import { type IndexerService } from '../services';
import { type DownloadService } from '../services';
import { type BlacklistService } from '../services';
import { type SettingsService } from '../services';
import { isMultiPartUsenetPost, calculateQuality } from '../../core/utils/index.js';
import type { SearchResult } from '../../core/index.js';
import {
  searchQuerySchema,
  grabSchema,
  type SearchQuery,
  type GrabInput,
} from '../../shared/schemas.js';

/**
 * Canonical ranking comparator: matchScore gate → MB/hr → protocol preference → seeders.
 */
// eslint-disable-next-line complexity -- 4-tier sort with null coalescing inflates counted branches
function canonicalCompare(
  a: SearchResult,
  b: SearchResult,
  bookDuration: number | undefined,
  durationUnknown: boolean,
  protocolPreference: string,
): number {
  const scoreA = a.matchScore ?? 0;
  const scoreB = b.matchScore ?? 0;
  const scoreDiff = scoreB - scoreA;

  if (Math.abs(scoreDiff) > 0.1) return scoreDiff;

  if (!durationUnknown) {
    const qualA = (a.size && a.size > 0) ? calculateQuality(a.size, bookDuration!) : null;
    const qualB = (b.size && b.size > 0) ? calculateQuality(b.size, bookDuration!) : null;
    const mbhrA = qualA?.mbPerHour ?? -1;
    const mbhrB = qualB?.mbPerHour ?? -1;
    if (mbhrA !== mbhrB) return mbhrB - mbhrA;
  }

  if (protocolPreference !== 'none') {
    const prefA = a.protocol === protocolPreference ? 1 : 0;
    const prefB = b.protocol === protocolPreference ? 1 : 0;
    if (prefA !== prefB) return prefB - prefA;
  }

  return (b.seeders ?? 0) - (a.seeders ?? 0);
}

/** Parse a comma-separated word list into trimmed, non-empty lowercase entries. */
export function parseWordList(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
}

/**
 * Apply quality filtering and canonical ranking to search results.
 * Filters by word lists, MB/hr grab floor, and min seeders, then sorts by
 * canonical order: matchScore gate → MB/hr → protocol preference → seeders.
 */
export function filterAndRankResults(
  results: SearchResult[],
  bookDuration: number | undefined,
  grabFloor: number,
  minSeeders: number,
  protocolPreference: string,
  rejectWords?: string,
  requiredWords?: string,
): { results: SearchResult[]; durationUnknown: boolean } {
  const durationUnknown = !bookDuration || bookDuration <= 0;

  let filtered = results;

  // Apply reject word filtering (before ranking)
  const rejectList = parseWordList(rejectWords);
  if (rejectList.length > 0) {
    filtered = filtered.filter((r) => {
      const sourceTitle = (r.rawTitle ?? r.title).toLowerCase();
      return !rejectList.some((word) => sourceTitle.includes(word));
    });
  }

  // Apply required word filtering (before ranking)
  const requiredList = parseWordList(requiredWords);
  if (requiredList.length > 0) {
    filtered = filtered.filter((r) => {
      const sourceTitle = (r.rawTitle ?? r.title).toLowerCase();
      return requiredList.some((word) => sourceTitle.includes(word));
    });
  }

  // Apply min seeders filter (torrent only)
  if (minSeeders > 0) {
    filtered = filtered.filter((r) => {
      if (r.protocol !== 'torrent') return true;
      return (r.seeders ?? 0) >= minSeeders;
    });
  }

  // Apply grab floor filter (only when duration is known)
  if (!durationUnknown && grabFloor > 0) {
    filtered = filtered.filter((r) => {
      if (!r.size || r.size <= 0) return true; // can't calculate, pass through
      const quality = calculateQuality(r.size, bookDuration!);
      if (!quality) return true; // can't calculate, pass through
      return quality.mbPerHour >= grabFloor;
    });
  }

  // Canonical ranking
  filtered.sort((a, b) => canonicalCompare(a, b, bookDuration, durationUnknown, protocolPreference));

  return { results: filtered, durationUnknown };
}

export async function searchRoutes(
  app: FastifyInstance,
  indexerService: IndexerService,
  downloadService: DownloadService,
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

      // Blacklist filtering
      const hashes = results
        .map((r: { infoHash?: string }) => r.infoHash)
        .filter((h): h is string => !!h);
      let filteredResults = results;
      if (hashes.length > 0) {
        const blacklisted = await blacklistService.getBlacklistedHashes(hashes);
        filteredResults = results.filter((r: { infoHash?: string }) => !r.infoHash || !blacklisted.has(r.infoHash));
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
        const download = await downloadService.grab(data);
        request.log.debug({ downloadId: download.id, status: download.status, externalId: download.externalId }, 'Grab completed');
        return await reply.status(201).send(download);
      } catch (error) {
        request.log.error(error, 'Grab failed');
        const message = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    }
  );
}
