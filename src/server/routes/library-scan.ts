import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { LibraryScanService } from '../services/library-scan.service.js';
import { ScanInProgressError, LibraryPathError } from '../services/library-scan.service.js';
import { rescanLibraryWithCompanionSweep } from '../services/library-rescan-sweep.js';
import type { CompanionSweepTrigger } from '../services/companion-ebook-trigger.js';
import type { MatchJobService } from '../services/match-job.service.js';
import type { BookService } from '../services/book.service.js';
import type { MetadataService } from '../services/metadata.service.js';
import type { ChapterRuntimeSeconds } from '../services/match-job.helpers.js';
import { getErrorMessage } from '../utils/error-message.js';
import { parseFolderStructure, parseFolderStructureRaw, cleanNameWithTrace } from '../utils/folder-parsing.js';
import { searchWithSwapRetryTrace } from '../utils/search-helpers.js';
import { type z } from 'zod';
import {
  scanDirectoryBodySchema,
  scanResultSchema,
  matchStartBodySchema,
  jobIdParamSchema,
  scanDebugBodySchema,
  durationCorroborationBodySchema,
  type ScanDebugBody,
  type ScanDebugTrace,
  type DurationCorroborationBody,
  type DurationCorroborationResult,
} from '@shared/schemas.js';
import { withinDurationTolerance } from '@shared/duration-tolerance.js';
import { serializeError } from '../utils/serialize-error.js';
import { mintPreviewToken } from '../services/preview-token.js';


// Direct-deployment headroom only: nginx still rejects above 1 MiB, the client diverts single
// oversized items, and every other route retains Fastify's global limit.
const CONFIRM_MATCH_BODY_LIMIT = 10 * 1024 * 1024;

type ScanDirectoryBody = z.infer<typeof scanDirectoryBodySchema>;
type MatchStartBody = z.infer<typeof matchStartBodySchema>;
type JobIdParam = z.infer<typeof jobIdParamSchema>;

function toAuthorName(a: string | { name: string }): string {
  return typeof a === 'string' ? a : a.name;
}

function toSearchResultItem(r: { title: string; authors?: (string | { name: string })[] | undefined; asin?: string | undefined; providerId?: string | undefined }) {
  return {
    title: r.title,
    authors: r.authors?.map(toAuthorName) ?? [],
    asin: r.asin ?? null,
    providerId: r.providerId ?? null,
  };
}

export async function libraryScanRoutes(
  app: FastifyInstance,
  libraryScan: LibraryScanService,
  matchJobService: MatchJobService,
  bookService: BookService,
  metadataService: MetadataService,
  companionEbook?: CompanionSweepTrigger,
): Promise<void> {
  app.post('/api/library/rescan', async (request, reply) => {
    request.log.info('Starting library rescan');
    try {
      // The wrapper waits for the scanning flag to release before sweeping and preserves errors.
      const result = await rescanLibraryWithCompanionSweep({ libraryScan, companionEbook, log: request.log });
      return result;
    } catch (error: unknown) {
      if (error instanceof ScanInProgressError) {
        return reply.status(409).send({ error: error.message });
      }
      if (error instanceof LibraryPathError) {
        return reply.status(400).send({ error: error.message });
      }
      request.log.error({ error: serializeError(error) }, 'Library rescan failed');
      return reply.status(500).send({
        error: getErrorMessage(error),
      });
    }
  });

  app.post<{ Body: ScanDirectoryBody }>(
    '/api/library/import/scan',
    { schema: { body: scanDirectoryBodySchema } },
    async (request, reply) => {
      const { path } = request.body;

      request.log.info({ path }, 'Scanning directory for audiobooks');

      try {
        const result = await libraryScan.scanDirectory(path);
        const decorated = {
          ...result,
          discoveries: result.discoveries.map(d => ({
            ...d,
            previewUrl: `/api/import/preview/${mintPreviewToken(d.path, path)}`,
          })),
        };
        return scanResultSchema.parse(decorated);
      } catch (error: unknown) {
        request.log.error({ error: serializeError(error) }, 'Directory scan failed');
        return reply.status(500).send({
          error: getErrorMessage(error),
        });
      }
    },
  );

  app.post<{ Body: MatchStartBody }>(
    '/api/library/import/match',
    { schema: { body: matchStartBodySchema }, bodyLimit: CONFIRM_MATCH_BODY_LIMIT },
    async (request) => {
      const { books: candidates } = request.body;

      request.log.info({ count: candidates.length }, 'Starting match job');
      const jobId = matchJobService.createJob(candidates);
      return { jobId };
    },
  );

  app.get<{ Params: JobIdParam }>(
    '/api/library/import/match/:jobId',
    { schema: { params: jobIdParamSchema } },
    async (request, reply) => {
      const { jobId } = request.params;
      const status = matchJobService.getJob(jobId);
      if (!status) {
        return reply.status(404).send({ error: 'Job not found or expired' });
      }
      return status;
    },
  );

  app.delete<{ Params: JobIdParam }>(
    '/api/library/import/match/:jobId',
    { schema: { params: jobIdParamSchema } },
    async (request) => {
      const { jobId } = request.params;
      const cancelled = matchJobService.cancelJob(jobId);
      return { cancelled };
    },
  );

  app.post<{ Body: ScanDebugBody }>(
    '/api/library/scan-debug',
    { schema: { body: scanDebugBodySchema } },
    (request, reply) => handleScanDebug(request, reply, metadataService, bookService),
  );

  app.post<{ Body: DurationCorroborationBody }>(
    '/api/library/import/duration-corroboration',
    { schema: { body: durationCorroborationBodySchema } },
    (request) => handleDurationCorroboration(request, metadataService),
  );
}

/**
 * Give client re-picks the match job's chapter-table evidence when scalar runtime is wrong.
 * Both operands are seconds and use shared tolerance. Lookup failure returns false at 200 so a
 * missing second opinion cannot break the re-pick.
 */
async function handleDurationCorroboration(
  request: { body: DurationCorroborationBody; log: FastifyBaseLogger },
  metadataService: MetadataService,
): Promise<DurationCorroborationResult> {
  const { asin, scannedSeconds } = request.body;

  let chapterRuntimes: ChapterRuntimeSeconds;
  try {
    chapterRuntimes = await metadataService.getChapterRuntimeSeconds(asin);
  } catch (error: unknown) {
    request.log.debug({ error: serializeError(error), asin }, 'Chapter corroboration failed — no second opinion available');
    return { corroborated: false };
  }

  // No usable runtime means no second opinion, so omit chapterSeconds rather than imply mismatch.
  const { fullSeconds, trimmedSeconds } = chapterRuntimes;
  if (fullSeconds === undefined && trimmedSeconds === undefined) return { corroborated: false };

  // Match against full or trimmed as the job does. chapterSeconds remains the full total;
  // expose trimmed seconds only when distinct, and never expose the diagnostic chapter count.
  const corroborated = inBand(fullSeconds, scannedSeconds) || inBand(trimmedSeconds, scannedSeconds);
  return {
    corroborated,
    ...(fullSeconds !== undefined && { chapterSeconds: fullSeconds }),
    ...(trimmedSeconds !== undefined && trimmedSeconds !== fullSeconds && { trimmedChapterSeconds: trimmedSeconds }),
  };
}

function inBand(reference: number | undefined, scannedSeconds: number): boolean {
  return reference !== undefined && withinDurationTolerance(reference, scannedSeconds);
}

async function handleScanDebug(
  request: { body: ScanDebugBody; log: FastifyBaseLogger },
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  metadataService: MetadataService,
  bookService: BookService,
) {
  const { folderName } = request.body;
  request.log.info({ folderName }, 'Scan debug trace requested');

  const { parts, raw, pattern, cleaning, cleanedTitle, cleanedAuthor, asin } = buildParsingTrace(folderName);
  const partialTrace = { input: folderName, parts, parsing: { pattern, raw }, cleaning, search: null, match: null, duplicate: null };

  let searchResult;
  try {
    searchResult = await runSearchTrace(cleanedTitle, cleanedAuthor, metadataService, request.log, asin);
  } catch (error: unknown) {
    request.log.error({ error: serializeError(error) }, 'Scan debug metadata search failed');
    return reply.status(502).send({
      statusCode: 502, error: 'Bad Gateway',
      message: `Metadata search provider failed: ${getErrorMessage(error)}`,
      partialTrace,
    });
  }

  let duplicate: ScanDebugTrace['duplicate'];
  try {
    const authorList = cleanedAuthor ? [{ name: cleanedAuthor }] : undefined;
    // Include parsed ASIN so diagnostics use confirm-time identity; only same-recording is a hard duplicate.
    const resolution = await bookService.findDuplicate({
      title: cleanedTitle,
      ...(authorList && { authors: authorList }),
      ...(asin !== undefined && { asin }),
    });
    const existing = resolution.book;
    duplicate = {
      isDuplicate: resolution.verdict === 'same-recording',
      existingBookId: existing?.id ?? null,
      reason: existing ? resolution.verdict : null,
    };
  } catch (error: unknown) {
    request.log.error({ error: serializeError(error) }, 'Scan debug duplicate check failed');
    return reply.status(500).send({
      statusCode: 500, error: 'Internal Server Error',
      message: `Duplicate check failed: ${getErrorMessage(error)}`,
      partialTrace: { ...partialTrace, search: searchResult.search, match: searchResult.match },
    });
  }

  return { input: folderName, parts, parsing: { pattern, raw }, cleaning, ...searchResult, duplicate };
}

function buildParsingTrace(folderName: string) {
  const parts = folderName.split(/[/\\]/).filter(Boolean);
  const parsed = parseFolderStructure(parts);
  const rawParsed = parseFolderStructureRaw(parts);
  const pattern = parts.length <= 1 ? '1-part' : parts.length === 2 ? '2-part' : '3+-part';

  const raw = {
    author: rawParsed.author,
    title: rawParsed.title,
    series: rawParsed.series,
    seriesPosition: rawParsed.seriesPosition ?? null,
    asin: rawParsed.asin ?? null,
  };

  // Trace pre-clean values; the string guard keeps numeric seriesPosition out of cleanNameWithTrace.
  const cleaning: Record<string, ReturnType<typeof cleanNameWithTrace>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && key !== 'asin') cleaning[key] = cleanNameWithTrace(value);
  }

  const cleanedTitle = cleaning.title?.result ?? parsed.title;
  const cleanedAuthor = cleaning.author?.result ?? parsed.author ?? undefined;
  const asin = rawParsed.asin;

  return { parts, raw, pattern, cleaning, cleanedTitle, cleanedAuthor, asin };
}

async function runSearchTrace(
  cleanedTitle: string,
  cleanedAuthor: string | undefined,
  metadataService: MetadataService,
  log: FastifyBaseLogger,
  asin?: string,
) {
  let directLookup: { asin: string; hit: boolean } | null = null;
  if (asin) {
    try {
      const direct = await metadataService.getBook(asin);
      if (direct) {
        directLookup = { asin, hit: true };
        const results = [toSearchResultItem(direct)];
        const search: ScanDebugTrace['search'] = {
          directLookup,
          initialQuery: asin,
          initialResultCount: 1,
          swapRetry: false,
          swapQuery: null,
          results,
        };
        const match: ScanDebugTrace['match'] = { status: 'matched', selected: results[0]! };
        return { search, match };
      }
      directLookup = { asin, hit: false };
    } catch (error: unknown) {
      log.warn({ error: serializeError(error), asin }, 'Scan debug direct ASIN lookup failed — falling back to keyword search');
      directLookup = { asin, hit: false };
    }
  }

  const searchResult = await searchWithSwapRetryTrace({
    searchFn: (query, options) => metadataService.searchBooks(query, options),
    title: cleanedTitle,
    author: cleanedAuthor,
    log,
  });

  const search: ScanDebugTrace['search'] = {
    directLookup,
    initialQuery: searchResult.initialQuery,
    initialResultCount: searchResult.initialResultCount,
    swapRetry: searchResult.swapRetry,
    swapQuery: searchResult.swapQuery,
    results: searchResult.results.map(toSearchResultItem),
  };

  const match: ScanDebugTrace['match'] = searchResult.results.length > 0
    ? { status: 'matched', selected: toSearchResultItem(searchResult.results[0]!) }
    : { status: 'no match', selected: null };

  return { search, match };
}
