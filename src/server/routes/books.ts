import type { FastifyInstance } from 'fastify';
import type { BookService, BookListService, DownloadService, SettingsService, RenameService, EventHistoryService, TaggingService, IndexerSearchService, SeriesCardService, MetadataService, IndexerService, ConnectorService } from '../services/index.js';
import { RenameError, didRenameChangeAnything, type RenameResult } from '../services/rename.service.js';
import { triggerCompanionReconcile, type CompanionBookReconcileTrigger } from '../services/companion-ebook-trigger.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { MergeService } from '../services/merge.service.js';
import type { BookRejectionService } from '../services/book-rejection.service.js';
import type { BookDeletionService } from '../services/book-deletion.service.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import type { BlacklistService } from '../services/blacklist.service.js';
export interface BookRouteDeps {
  bookService: BookService;
  bookListService: BookListService;
  downloadService: DownloadService;
  downloadOrchestrator: DownloadOrchestrator;
  settingsService: SettingsService;
  renameService: RenameService;
  mergeService: MergeService;
  taggingService: TaggingService;
  eventHistory: EventHistoryService;
  bookDeletionService: BookDeletionService;
  indexerSearchService: IndexerSearchService;
  indexerService: IndexerService;
  bookRejectionService: BookRejectionService;
  blacklistService: BlacklistService;
  eventBroadcaster: EventBroadcasterService;
  seriesCardService: SeriesCardService;
  metadataService: MetadataService;
  companionEbook: CompanionBookReconcileTrigger;
  connectorService?: ConnectorService;
}
import { searchAndGrabForBook, buildNarratorPriority, buildSearchFilterOptions } from '../services/search-pipeline.js';
import { z } from 'zod';
import { triggerImmediateSearch } from '../services/trigger-immediate-search.js';
import { addBookThroughLadder, type AddBookLadderResult } from '../services/book-add-ladder.js';
import {
  idParamSchema,
  bookListQuerySchema,
  libraryStatusFilterSchema,
  paginationParamsSchema,
  createBookBodySchema,
  updateBookBodySchema,
  deleteBookQuerySchema,
  retagBodySchema,
  retagPreviewQuerySchema,
  DEFAULT_LIMITS,
  type CreateBookBody,
  type UpdateBookBody,
  type DeleteBookQuery,
  type RetagBody,
  type RetagPreviewQuery,
} from '@shared/schemas.js';
import { registerFixMatchRoute } from './books-fix-match.js';
import { registerSeriesRoutes } from './books-series.js';
import { refreshOpfForBook } from '../utils/opf-refresh.js';
import { enqueueBookRefresh, enqueueRetagRefresh } from '../utils/enqueue-book-refresh.js';

const booksListQuerySchema = bookListQuerySchema.merge(paginationParamsSchema);
type BooksListQuery = z.infer<typeof booksListQuerySchema>;

// Library filtering accepts only bucket keys; `all` is client-only and other book statuses are invalid.
const libraryBooksListQuerySchema = booksListQuerySchema.extend({
  status: libraryStatusFilterSchema.optional(),
  collapse: z.enum(['true', 'false']).optional().transform(v => v === undefined ? undefined : v === 'true'),
});
type LibraryBooksListQuery = z.infer<typeof libraryBooksListQuerySchema>;

type IdParam = z.infer<typeof idParamSchema>;

import { refreshScanBook } from '../services/refresh-scan.service.js';


async function registerDeleteBookRoute(app: FastifyInstance, deps: Pick<BookRouteDeps, 'bookDeletionService'>) {
app.delete<{ Params: IdParam; Querystring: DeleteBookQuery }>(
  '/api/books/:id',
  { schema: { params: idParamSchema, querystring: deleteBookQuerySchema } },
  async (request, reply) => {
    const { id } = request.params;
    const { deleteFiles } = request.query;

    const result = await deps.bookDeletionService.deleteBook(id, { deleteFiles: deleteFiles === 'true' });

    switch (result.outcome) {
      case 'not_found':
        return reply.status(404).send({ error: 'Book not found' });
      case 'path_outside_library':
        return reply.status(400).send({ error: result.error });
      case 'file_deletion_failed':
        return reply.status(500).send({ error: result.error });
      case 'deleted':
        return result.fileSummary
          ? { success: true, fileSummary: result.fileSummary }
          : { success: true };
      default:
        return result satisfies never;
    }
});
}

/**
 * Additive by design: the incumbent row stays at the top level so the existing 409 consumers keep
 * reading `id`/`title`, and `conflict` is the only field they must opt into. `review` means the
 * resolver abstained, which is not the ownership claim a bare row reads as.
 */
function buildAddConflictBody(result: Exclude<AddBookLadderResult, { outcome: 'created' }>) {
  if (result.outcome === 'owned-race') {
    // Hydration is best-effort, so the error's identity is the floor and the body is never null.
    return { id: result.existingBookId, title: result.bookTitle, ...result.book, conflict: 'owned-race' as const };
  }
  return {
    ...result.book,
    conflict: result.verdict,
    ...(result.verdict === 'review' && result.recordingReviewReason && { recordingReviewReason: result.recordingReviewReason }),
  };
}

async function registerAddBookRoute(app: FastifyInstance, deps: BookRouteDeps) {
  app.post<{ Body: CreateBookBody }>(
    '/api/books',
    { schema: { body: createBookBodySchema } },
    async (request, reply) => {
      const body = request.body;
      const result = await addBookThroughLadder(deps, body, request.log);
      if (result.outcome !== 'created') {
        return reply.status(409).send(buildAddConflictBody(result));
      }
      const book = result.book;

      if (body.searchImmediately && book.status === 'wanted') {
        const { downloadOrchestrator, settingsService, blacklistService, eventBroadcaster, indexerSearchService, indexerService, eventHistory } = deps;
        triggerImmediateSearch(book, { indexerSearchService, indexerService, downloadOrchestrator, settingsService, blacklistService, eventBroadcaster, eventHistory }, request.log);
      }

      // Series cards hydrate lazily on first GET; do not create a second enrichment path here.

      return reply.status(201).send(book);
    },
  );
}

async function registerDeleteMissingRoute(app: FastifyInstance, deps: Pick<BookRouteDeps, 'bookService'>) {
  app.delete('/api/books/missing', async (request) => {
    const deleted = await deps.bookService.deleteByStatus('missing');
    request.log.info({ deleted }, 'Batch deleted missing books');
    return { deleted };
  });
}

function registerBookSearchRoute(app: FastifyInstance, deps: Pick<BookRouteDeps, 'bookService' | 'downloadOrchestrator' | 'settingsService' | 'indexerSearchService' | 'indexerService' | 'blacklistService' | 'eventBroadcaster' | 'eventHistory'>) {
  app.post<{ Params: IdParam }>(
    '/api/books/:id/search',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const book = await deps.bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      const qualitySettings = await deps.settingsService.get('quality');
      const metadataSettings = await deps.settingsService.get('metadata');
      const searchSettings = await deps.settingsService.get('search');
      const narratorPriority = buildNarratorPriority(searchSettings.searchPriority, book.narrators);
      const result = await searchAndGrabForBook(book, {
        indexerSearchService: deps.indexerSearchService,
        downloadOrchestrator: deps.downloadOrchestrator,
        qualitySettings: buildSearchFilterOptions(qualitySettings, metadataSettings, { narratorPriority }),
        log: request.log,
        blacklistService: deps.blacklistService,
        indexerService: deps.indexerService,
        eventHistory: deps.eventHistory,
        broadcaster: deps.eventBroadcaster,
      });
      if (result.result === 'grab_error') {
        throw result.error;
      }
      return result;
    },
  );
}

function registerMergeRoutes(app: FastifyInstance, mergeService: MergeService) {
  app.post<{ Params: IdParam }>(
    '/api/books/:id/merge-to-m4b',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const result = await mergeService.enqueueMerge(id);
      request.log.info({ id, status: result.status }, 'Merge request acknowledged');
      return reply.status(202).send(result);
    },
  );

  app.delete<{ Params: IdParam }>(
    '/api/books/:id/merge-to-m4b',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const result = await mergeService.cancelMerge(id);
      if (result.status === 'cancelled') {
        request.log.info({ id }, 'Merge cancelled');
        return reply.status(200).send({ success: true });
      }
      if (result.status === 'committing') {
        return reply.status(409).send({ error: 'Merge is past the point of no return' });
      }
      return reply.status(404).send({ error: 'No active merge for this book' });
    },
  );
}

/** Omit unset overrides for `exactOptionalPropertyTypes`. */
function pickRetagOverrides(
  source: { mode?: 'populate_missing' | 'overwrite' | undefined; embedCover?: boolean | undefined } | undefined,
): { mode?: 'populate_missing' | 'overwrite'; embedCover?: boolean } {
  const out: { mode?: 'populate_missing' | 'overwrite'; embedCover?: boolean } = {};
  if (source?.mode !== undefined) out.mode = source.mode;
  if (source?.embedCover !== undefined) out.embedCover = source.embedCover;
  return out;
}

/** Drop undefined query keys for `exactOptionalPropertyTypes`. */
function pickListOptions(q: BooksListQuery): {
  search?: string; author?: string; series?: string; narrator?: string;
  sortField?: NonNullable<BooksListQuery['sortField']>;
  sortDirection?: NonNullable<BooksListQuery['sortDirection']>;
} {
  const out: ReturnType<typeof pickListOptions> = {};
  if (q.search !== undefined) out.search = q.search;
  if (q.author !== undefined) out.author = q.author;
  if (q.series !== undefined) out.series = q.series;
  if (q.narrator !== undefined) out.narrator = q.narrator;
  if (q.sortField !== undefined) out.sortField = q.sortField;
  if (q.sortDirection !== undefined) out.sortDirection = q.sortDirection;
  return out;
}

function registerBookListRoutes(app: FastifyInstance, bookListService: BookRouteDeps['bookListService']) {
  app.get<{ Querystring: BooksListQuery }>('/api/books', { schema: { querystring: booksListQuerySchema } }, async (request) => {
    const { status, limit, offset } = request.query;
    request.log.debug({ ...request.query }, 'Fetching books');
    const pagination = { limit: limit ?? DEFAULT_LIMITS.books, ...(offset !== undefined && { offset }) };
    return bookListService.getAll(status, pagination, { slim: true, ...pickListOptions(request.query) });
  });

  app.get<{ Querystring: LibraryBooksListQuery }>('/api/library/books', { schema: { querystring: libraryBooksListQuerySchema } }, async (request) => {
    const { status, limit, offset, collapse } = request.query;
    request.log.debug({ ...request.query }, 'Fetching library books');
    const pagination = { limit: limit ?? DEFAULT_LIMITS.books, ...(offset !== undefined && { offset }) };
    const opts = pickListOptions(request.query);
    return bookListService.getAllForLibrary(status, pagination, { ...opts, ...(collapse !== undefined && { collapse }) });
  });
}

export async function booksRoutes(app: FastifyInstance, deps: BookRouteDeps) {
  const { bookService, bookListService, renameService, mergeService, taggingService } = deps;
  registerBookListRoutes(app, bookListService);

  app.get('/api/books/identifiers', async () => {
    return bookListService.getIdentifiers();
  });

  app.get('/api/books/stats', async () => {
    return bookListService.getStats();
  });

  app.get<{ Params: IdParam }>(
    '/api/books/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const book = await bookService.getById(id);

      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      return book;
    },
  );

  await registerAddBookRoute(app, deps);

  app.put<{ Params: IdParam; Body: UpdateBookBody }>(
    '/api/books/:id',
    { schema: { params: idParamSchema, body: updateBookBodySchema } },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      // Only operator edits create clear-field tombstones; internal nulls retain fill-empty semantics.
      const book = await bookService.update(id, body, { userAsserted: true });

      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      // OPF refresh is independent of audio retagging and skips books without paths.
      const opfOutcome = await refreshOpfForBook({
        settingsService: deps.settingsService,
        bookService,
        bookId: id,
        bookFolder: book.path ?? null,
        log: request.log,
      });

      // Only a written OPF triggers this route's refresh; other routes aggregate their own.
      if (opfOutcome === 'written') {
        enqueueBookRefresh(deps.connectorService, request.log, 'metadata', {
          bookId: id, title: book.title, authorName: book.authors?.[0]?.name ?? null, libraryPath: book.path!,
        });
      }

      request.log.info({ id }, 'Book updated');
      return book;
    },
  );

  await registerDeleteMissingRoute(app, deps);
  await registerDeleteBookRoute(app, deps);
  app.get<{ Params: IdParam }>(
    '/api/books/:id/rename/preview',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      try {
        return await renameService.planRename(id);
      } catch (error: unknown) {
        if (error instanceof RenameError && error.code === 'CONFLICT' && error.details) {
          return reply.status(409).send({
            error: error.message,
            code: 'CONFLICT',
            conflictingBook: error.details.conflictingBook,
          });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: IdParam }>(
    '/api/books/:id/rename',
    { schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params;
      // Path persistence can precede a filesystem throw, so failures reconcile; no-op successes do not.
      let result: RenameResult;
      try {
        result = await renameService.renameBook(id);
      } catch (error: unknown) {
        triggerCompanionReconcile(deps.companionEbook, id, request.log, 'Companion ebook reconcile failed after rename');
        throw error;
      }
      if (didRenameChangeAnything(result)) {
        triggerCompanionReconcile(deps.companionEbook, id, request.log, 'Companion ebook reconcile failed after rename');
      }
      request.log.info({ id, oldPath: result.oldPath, newPath: result.newPath }, 'Book renamed');
      return result;
    },
  );

  registerBookSearchRoute(app, deps);

  app.get<{ Params: IdParam; Querystring: RetagPreviewQuery }>(
    '/api/books/:id/retag/preview',
    { schema: { params: idParamSchema, querystring: retagPreviewQuerySchema } },
    async (request) => {
      const { id } = request.params;
      return taggingService.planRetag(id, pickRetagOverrides(request.query));
    },
  );

  app.post<{ Params: IdParam; Body: RetagBody }>(
    '/api/books/:id/retag',
    { schema: { params: idParamSchema, body: retagBodySchema } },
    async (request) => {
      const { id } = request.params;
      const excludeFields = new Set(request.body?.excludeFields ?? []);
      const result = await taggingService.retagBook(id, excludeFields, pickRetagOverrides(request.body ?? undefined));

      // `refreshItem` is captured before in-place tag writes, so a reload failure cannot drop refresh.
      enqueueRetagRefresh(deps.connectorService, request.log, result);

      request.log.info({ id, tagged: result.tagged, skipped: result.skipped, failed: result.failed }, 'Book re-tagged');
      // Strip internal enqueue state so its absolute library path never reaches the API.
      const { refreshItem: _refreshItem, ...response } = result;
      return response;
    },
  );

  app.post<{ Params: IdParam }>(
    '/api/books/:id/refresh-scan',
    { schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params;
      // Force the companion observation for errors before the audio probe and bypass the fingerprint short-circuit.
      try {
        return await refreshScanBook(id, deps.bookService, deps.settingsService, request.log);
      } finally {
        triggerCompanionReconcile(deps.companionEbook, id, request.log, 'Companion ebook reconcile failed after refresh scan', true);
      }
    },
  );

  registerSeriesRoutes(app, deps);

  registerMergeRoutes(app, mergeService);

  registerFixMatchRoute(app, deps);

  const { bookRejectionService } = deps;
  app.post<{ Params: IdParam }>(
    '/api/books/:id/wrong-release',
    { schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params;
      await bookRejectionService.rejectAsWrongRelease(id);
      request.log.info({ id }, 'Book marked as wrong release');
      return { success: true };
    },
  );
}
