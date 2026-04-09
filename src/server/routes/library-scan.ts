import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { LibraryScanService } from '../services/library-scan.service.js';
import type { ImportConfirmItem } from '../services/library-scan.service.js';
import { ScanInProgressError, LibraryPathError } from '../services/library-scan.service.js';
import type { MatchJobService } from '../services/match-job.service.js';
import type { BookService } from '../services/book.service.js';
import type { MetadataService } from '../services/metadata.service.js';
import { getErrorMessage } from '../utils/error-message.js';
import { parseFolderStructure, parseFolderStructureRaw, cleanNameWithTrace } from '../utils/folder-parsing.js';
import { searchWithSwapRetryTrace } from '../utils/search-helpers.js';
import { type z } from 'zod';
import {
  scanSingleBodySchema,
  scanDirectoryBodySchema,
  scanResultSchema,
  importSingleBodySchema,
  importConfirmBodySchema,
  matchStartBodySchema,
  jobIdParamSchema,
  scanDebugBodySchema,
  type ScanDebugBody,
  type ScanDebugTrace,
} from '../../shared/schemas.js';

type ScanSingleBody = z.infer<typeof scanSingleBodySchema>;
type ScanDirectoryBody = z.infer<typeof scanDirectoryBodySchema>;
type ImportSingleBody = z.infer<typeof importSingleBodySchema>;
type ImportConfirmBody = z.infer<typeof importConfirmBodySchema>;
type MatchStartBody = z.infer<typeof matchStartBodySchema>;
type JobIdParam = z.infer<typeof jobIdParamSchema>;

/** Map a BookMetadata author ref to a plain string name. */
function toAuthorName(a: string | { name: string }): string {
  return typeof a === 'string' ? a : a.name;
}

/** Map a BookMetadata result to the scan-debug response shape. */
function toSearchResultItem(r: { title: string; authors?: (string | { name: string })[]; asin?: string; providerId?: string }) {
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
): Promise<void> {
  // Scan a single book folder — returns parsed metadata + provider match
  app.post<{ Body: ScanSingleBody }>(
    '/api/library/import/scan-single',
    { schema: { body: scanSingleBodySchema } },
    async (request, reply) => {
      const { path } = request.body;

      request.log.info({ path }, 'Scanning single book folder');

      try {
        const result = await libraryScan.scanSingleBook(path);
        return result;
      } catch (error: unknown) {
        request.log.warn({ error, path }, 'Single book scan failed');
        return reply.status(400).send({
          error: getErrorMessage(error, 'Scan failed'),
        });
      }
    },
  );

  // Import a single book with metadata
  app.post<{ Body: ImportSingleBody }>(
    '/api/library/import/single',
    { schema: { body: importSingleBodySchema } },
    async (request, reply) => {
      const { mode, metadata, ...importItem } = request.body;

      request.log.info({ title: importItem.title, path: importItem.path, mode }, 'Importing single book');

      try {
        const result = await libraryScan.importSingleBook(importItem, metadata as ImportConfirmItem['metadata'], mode);
        return result;
      } catch (error: unknown) {
        request.log.error(error, 'Single book import failed');
        return reply.status(500).send({
          error: getErrorMessage(error, 'Import failed'),
        });
      }
    },
  );

  // Rescan library — verify book paths exist on disk
  app.post('/api/library/rescan', async (request, reply) => {
    request.log.info('Starting library rescan');
    try {
      const result = await libraryScan.rescanLibrary();
      return result;
    } catch (error: unknown) {
      if (error instanceof ScanInProgressError) {
        return reply.status(409).send({ error: error.message });
      }
      if (error instanceof LibraryPathError) {
        return reply.status(400).send({ error: error.message });
      }
      request.log.error(error, 'Library rescan failed');
      return reply.status(500).send({
        error: getErrorMessage(error, 'Rescan failed'),
      });
    }
  });

  // Bulk scan directory (kept for Library Import #125)
  app.post<{ Body: ScanDirectoryBody }>(
    '/api/library/import/scan',
    { schema: { body: scanDirectoryBodySchema } },
    async (request, reply) => {
      const { path } = request.body;

      request.log.info({ path }, 'Scanning directory for audiobooks');

      try {
        const result = await libraryScan.scanDirectory(path);
        return scanResultSchema.parse(result);
      } catch (error: unknown) {
        request.log.error(error, 'Directory scan failed');
        return reply.status(500).send({
          error: getErrorMessage(error, 'Scan failed'),
        });
      }
    },
  );

  // Bulk confirm import (async — returns 202)
  app.post<{ Body: ImportConfirmBody }>(
    '/api/library/import/confirm',
    { schema: { body: importConfirmBodySchema } },
    async (request, reply) => {
      const { books: items, mode } = request.body;

      request.log.info({ count: items.length, mode }, 'Confirming library import (async)');

      try {
        const result = await libraryScan.confirmImport(items as ImportConfirmItem[], mode);
        return await reply.status(202).send(result);
      } catch (error: unknown) {
        request.log.error(error, 'Import confirmation failed');
        return reply.status(500).send({
          error: getErrorMessage(error, 'Import failed'),
        });
      }
    },
  );

  // Start a match job for discovered books
  app.post<{ Body: MatchStartBody }>(
    '/api/library/import/match',
    { schema: { body: matchStartBodySchema } },
    async (request) => {
      const { books: candidates } = request.body;

      request.log.info({ count: candidates.length }, 'Starting match job');
      const jobId = matchJobService.createJob(candidates);
      return { jobId };
    },
  );

  // Poll match job status
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

  // Cancel a match job
  app.delete<{ Params: JobIdParam }>(
    '/api/library/import/match/:jobId',
    { schema: { params: jobIdParamSchema } },
    async (request) => {
      const { jobId } = request.params;
      const cancelled = matchJobService.cancelJob(jobId);
      return { cancelled };
    },
  );

  // Scan debug — trace folder parsing and metadata matching pipeline
  app.post<{ Body: ScanDebugBody }>(
    '/api/library/scan-debug',
    { schema: { body: scanDebugBodySchema } },
    async (request, reply) => {
      const { folderName } = request.body;
      request.log.info({ folderName }, 'Scan debug trace requested');

      const { parts, parsed, pattern, cleaning, cleanedTitle, cleanedAuthor } = buildParsingTrace(folderName);
      const partialTrace = { input: folderName, parts, parsing: { pattern, raw: parsed }, cleaning, search: null, match: null, duplicate: null };

      // Search step — 502 on metadata provider failure
      let searchResult;
      try {
        searchResult = await runSearchTrace(cleanedTitle, cleanedAuthor, metadataService, request.log);
      } catch (error: unknown) {
        request.log.error(error, 'Scan debug metadata search failed');
        return reply.status(502).send({
          statusCode: 502, error: 'Bad Gateway',
          message: `Metadata search provider failed: ${getErrorMessage(error, 'unknown error')}`,
          partialTrace,
        });
      }

      // Duplicate check — 500 on database failure (not a provider issue)
      let duplicate: ScanDebugTrace['duplicate'];
      try {
        const authorList = cleanedAuthor ? [{ name: cleanedAuthor }] : undefined;
        const existing = await bookService.findDuplicate(cleanedTitle, authorList);
        duplicate = { isDuplicate: existing !== null, existingBookId: existing?.id ?? null, reason: existing ? 'library-match' : null };
      } catch (error: unknown) {
        request.log.error(error, 'Scan debug duplicate check failed');
        return reply.status(500).send({
          statusCode: 500, error: 'Internal Server Error',
          message: `Duplicate check failed: ${getErrorMessage(error, 'unknown error')}`,
          partialTrace: { ...partialTrace, search: searchResult.search, match: searchResult.match },
        });
      }

      return { input: folderName, parts, parsing: { pattern, raw: parsed }, cleaning, ...searchResult, duplicate };
    },
  );
}

// ─── Scan Debug Helpers ─────────────────────────────────────────────

function buildParsingTrace(folderName: string) {
  const parts = folderName.split(/[/\\]/).filter(Boolean);
  const parsed = parseFolderStructure(parts);
  const raw = parseFolderStructureRaw(parts);
  const pattern = parts.length <= 1 ? '1-part' : parts.length === 2 ? '2-part' : '3+-part';

  // Trace cleaning from raw (pre-cleanName) values so each step shows real transformations
  const cleaning: Record<string, ReturnType<typeof cleanNameWithTrace>> = {};
  for (const [key, value] of Object.entries(raw) as [string, string | null][]) {
    if (value) cleaning[key] = cleanNameWithTrace(value);
  }

  const cleanedTitle = cleaning.title?.result ?? parsed.title;
  const cleanedAuthor = cleaning.author?.result ?? parsed.author ?? undefined;

  return { parts, parsed, pattern, cleaning, cleanedTitle, cleanedAuthor };
}

async function runSearchTrace(
  cleanedTitle: string,
  cleanedAuthor: string | undefined,
  metadataService: MetadataService,
  log: FastifyBaseLogger,
) {
  const searchResult = await searchWithSwapRetryTrace({
    searchFn: (query, options) => metadataService.searchBooks(query, options),
    title: cleanedTitle,
    author: cleanedAuthor,
    log,
  });

  const search: ScanDebugTrace['search'] = {
    initialQuery: searchResult.initialQuery,
    initialResultCount: searchResult.initialResultCount,
    swapRetry: searchResult.swapRetry,
    swapQuery: searchResult.swapQuery,
    results: searchResult.results.map(toSearchResultItem),
  };

  const match: ScanDebugTrace['match'] = searchResult.results.length > 0
    ? { status: 'matched', selected: toSearchResultItem(searchResult.results[0]) }
    : { status: 'no match', selected: null };

  return { search, match };
}
