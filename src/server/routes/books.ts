import type { FastifyInstance } from 'fastify';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import type { BookService, BookListService, DownloadService, SettingsService, RenameService, EventHistoryService, TaggingService, IndexerSearchService, SeriesCardService, MetadataService, IndexerService, ConnectorService } from '../services/index.js';
import { RenameError } from '../services/rename.service.js';
import { OwnedRecordingError } from '../services/book.service.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { MergeService } from '../services/merge.service.js';
import type { BookRejectionService } from '../services/book-rejection.service.js';
import type { BookDeletionService } from '../services/book-deletion.service.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import { serializeError } from '../utils/serialize-error.js';
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
  connectorService?: ConnectorService;
}
import { searchAndGrabForBook, buildNarratorPriority } from '../services/search-pipeline.js';
import { z } from 'zod';
import { triggerImmediateSearch } from '../services/trigger-immediate-search.js';
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
} from '../../shared/schemas.js';
import { registerFixMatchRoute } from './books-fix-match.js';
import { registerSeriesRoutes } from './books-series.js';
import { refreshOpfForBook } from '../utils/opf-refresh.js';
import { enqueueBookRefresh, enqueueRetagRefresh } from '../utils/enqueue-book-refresh.js';

const booksListQuerySchema = bookListQuerySchema.merge(paginationParamsSchema);
type BooksListQuery = z.infer<typeof booksListQuerySchema>;

// The library list filter carries a `LibraryFilterBucket` (bucket key), distinct
// from the generic route's per-book `BookStatus`. Override `status` to the
// bucket-only schema so `?status=all` (client-only sentinel) and non-bucket
// statuses like `?status=searching` are rejected with a 400.
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
        // #1589: surface what an on-disk delete preserved ("kept N files") when present.
        return result.fileSummary
          ? { success: true, fileSummary: result.fileSummary }
          : { success: true };
      default:
        return result satisfies never;
    }
});
}

async function registerAddBookRoute(app: FastifyInstance, deps: BookRouteDeps) {
  app.post<{ Body: CreateBookBody }>(
    '/api/books',
    { schema: { body: createBookBodySchema } },
    async (request, reply) => {
      const body = request.body;
      // Three-way recording identity (#1711): only an owned (same-recording) OR
      // an uncertain (review/no-signal) verdict blocks with 409 — a genuinely
      // different recording of an owned title is allowed through (keep-both). A
      // 'different-recording' verdict returns `book: null`, so the 409 only fires
      // when there is an incumbent to surface.
      const resolution = await deps.bookService.findDuplicate({
        title: body.title,
        authors: body.authors,
        ...(body.asin !== undefined && { asin: body.asin }),
        ...(body.narrators !== undefined && { narrators: body.narrators }),
        ...(body.duration !== undefined && { duration: body.duration }),
      });
      if (resolution.verdict !== 'different-recording' && resolution.book) {
        request.log.info({ title: body.title, existingId: resolution.book.id, verdict: resolution.verdict }, 'Duplicate book detected');
        return reply.status(409).send(resolution.book);
      }

      let book;
      try {
        book = await deps.bookService.create(body);
      } catch (error: unknown) {
        // Same-ASIN create-time race (#1711) → the recording is already owned.
        if (error instanceof OwnedRecordingError) {
          request.log.info({ title: body.title, existingId: error.existingBookId }, 'Duplicate book detected (ASIN race)');
          const owner = await deps.bookService.getById(error.existingBookId);
          return reply.status(409).send(owner);
        }
        throw error;
      }

      deps.eventHistory.create({
        bookId: book.id,
        ...snapshotBookForEvent(book),
        eventType: 'book_added',
        source: 'manual',
      }).catch((err: unknown) => request.log.warn({ error: serializeError(err) }, 'Failed to record book_added event'));

      request.log.info({ title: body.title }, 'Book added');

      if (body.searchImmediately && book.status === 'wanted') {
        const { downloadOrchestrator, settingsService, blacklistService, eventBroadcaster, indexerSearchService, indexerService, eventHistory } = deps;
        triggerImmediateSearch(book, { indexerSearchService, indexerService, downloadOrchestrator, settingsService, blacklistService, eventBroadcaster, eventHistory }, request.log);
      }

      // Series card lazily populates on first GET via SeriesCardService when
      // a Hardcover key is configured; no fire-and-forget enqueue here. The
      // local series_members row from bookService.create.upsertSeriesLink is
      // enough to render the card immediately.

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
        qualitySettings: { ...qualitySettings, languages: metadataSettings.languages, narratorPriority },
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

/** Build the overrides object the tagging service expects, omitting unset fields
 *  so the resulting object satisfies `exactOptionalPropertyTypes`. */
function pickRetagOverrides(
  source: { mode?: 'populate_missing' | 'overwrite' | undefined; embedCover?: boolean | undefined } | undefined,
): { mode?: 'populate_missing' | 'overwrite'; embedCover?: boolean } {
  const out: { mode?: 'populate_missing' | 'overwrite'; embedCover?: boolean } = {};
  if (source?.mode !== undefined) out.mode = source.mode;
  if (source?.embedCover !== undefined) out.embedCover = source.embedCover;
  return out;
}

/** Project query params into the options shape both list services accept,
 *  dropping undefined keys so exactOptionalPropertyTypes stays happy. */
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

  // GET /api/library/books — slim DTO for the library list view (#1132)
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

  // GET /api/books/identifiers — lightweight list for duplicate detection (no pagination)
  app.get('/api/books/identifiers', async () => {
    return bookListService.getIdentifiers();
  });

  // GET /api/books/stats — server-side status counts and filter values
  app.get('/api/books/stats', async () => {
    return bookListService.getStats();
  });

  // GET /api/books/:id
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

  // PUT /api/books/:id
  app.put<{ Params: IdParam; Body: UpdateBookBody }>(
    '/api/books/:id',
    { schema: { params: idParamSchema, body: updateBookBodySchema } },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      const book = await bookService.update(id, body);

      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      // Keep the on-disk metadata.opf current with the edited DB state (gated on tagging.writeOpf,
      // independent of any audio-retag). Skipped for not-yet-imported books (path === null).
      const opfOutcome = await refreshOpfForBook({
        settingsService: deps.settingsService,
        bookService,
        bookId: id,
        bookFolder: book.path ?? null,
        log: request.log,
      });

      // Standalone metadata-edit route: a refresh only when the OPF actually got written
      // ('skipped'/'failed' → none). The cover-upload and Fix-Match routes aggregate their own
      // OPF write into a single refresh, so this independent OPF fire is scoped to the edit route.
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
  // GET /api/books/:id/rename/preview — dry-run plan for the rename action
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

  // POST /api/books/:id/rename
  app.post<{ Params: IdParam }>(
    '/api/books/:id/rename',
    { schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params;
      const result = await renameService.renameBook(id);
      request.log.info({ id, oldPath: result.oldPath, newPath: result.newPath }, 'Book renamed');
      return result;
    },
  );

  registerBookSearchRoute(app, deps);

  // GET /api/books/:id/retag/preview — dry-run plan for the re-tag action
  app.get<{ Params: IdParam; Querystring: RetagPreviewQuery }>(
    '/api/books/:id/retag/preview',
    { schema: { params: idParamSchema, querystring: retagPreviewQuerySchema } },
    async (request) => {
      const { id } = request.params;
      return taggingService.planRetag(id, pickRetagOverrides(request.query));
    },
  );

  // POST /api/books/:id/retag
  app.post<{ Params: IdParam; Body: RetagBody }>(
    '/api/books/:id/retag',
    { schema: { params: idParamSchema, body: retagBodySchema } },
    async (request) => {
      const { id } = request.params;
      const excludeFields = new Set(request.body?.excludeFields ?? []);
      const result = await taggingService.retagBook(id, excludeFields, pickRetagOverrides(request.body ?? undefined));

      // A re-tag rewrites embedded audio tags in place (new inode, same path) — fire a 'metadata'
      // refresh when ≥1 file was tagged so ABS/Plex re-reads the changed files. The refresh item is
      // built from `RetagResult.refreshItem` (loaded before the tag write), so a post-re-tag reload
      // failure can't drop it. Single home shared with the bulk re-tag job (bulk-operation.service.ts).
      enqueueRetagRefresh(deps.connectorService, request.log, result);

      request.log.info({ id, tagged: result.tagged, skipped: result.skipped, failed: result.failed }, 'Book re-tagged');
      // `refreshItem` is internal enqueue state (carries the absolute on-disk `libraryPath`) — strip it
      // so the public response stays the counts/warnings shape the client `RetagResult` expects and the
      // filesystem path never leaks to the API.
      const { refreshItem: _refreshItem, ...response } = result;
      return response;
    },
  );

  // POST /api/books/:id/refresh-scan
  app.post<{ Params: IdParam }>(
    '/api/books/:id/refresh-scan',
    { schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params;
      const result = await refreshScanBook(id, deps.bookService, deps.settingsService, request.log);
      return result;
    },
  );

  registerSeriesRoutes(app, deps.bookService, deps.seriesCardService);

  registerMergeRoutes(app, mergeService);

  // POST /api/books/:id/fix-match
  registerFixMatchRoute(app, deps);

  // POST /api/books/:id/wrong-release
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
