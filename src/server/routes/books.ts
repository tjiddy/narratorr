import type { FastifyInstance } from 'fastify';
import { cleanCoverCache } from '../utils/cover-cache.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import { config } from '../config.js';
import type { BookService, BookListService, DownloadService, SettingsService, RenameService, EventHistoryService, TaggingService, IndexerSearchService, SeriesRefreshService } from '../services/index.js';
import { PathOutsideLibraryError } from '../utils/paths.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { MergeService } from '../services/merge.service.js';
import type { BookRejectionService } from '../services/book-rejection.service.js';
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
  eventHistory?: EventHistoryService;
  indexerSearchService?: IndexerSearchService;
  bookRejectionService?: BookRejectionService;
  blacklistService?: BlacklistService;
  eventBroadcaster?: EventBroadcasterService;
  seriesRefreshService?: SeriesRefreshService;
}
import { searchAndGrabForBook, buildNarratorPriority } from '../services/search-pipeline.js';
import { type z } from 'zod';
import { triggerImmediateSearch } from './trigger-immediate-search.js';
import {
  idParamSchema,
  bookListQuerySchema,
  paginationParamsSchema,
  createBookBodySchema,
  updateBookBodySchema,
  deleteBookQuerySchema,
  DEFAULT_LIMITS,
  type CreateBookBody,
  type UpdateBookBody,
  type DeleteBookQuery,
} from '../../shared/schemas.js';

const booksListQuerySchema = bookListQuerySchema.merge(paginationParamsSchema);
type BooksListQuery = z.infer<typeof booksListQuerySchema>;

type IdParam = z.infer<typeof idParamSchema>;

import { refreshScanBook } from '../services/refresh-scan.service.js';


async function registerDeleteBookRoute(app: FastifyInstance, deps: Pick<BookRouteDeps, 'bookService' | 'downloadService' | 'downloadOrchestrator' | 'settingsService' | 'eventHistory'>) {
app.delete<{ Params: IdParam; Querystring: DeleteBookQuery }>(
  '/api/books/:id',
  { schema: { params: idParamSchema, querystring: deleteBookQuerySchema } },
  async (request, reply) => {
    const { id } = request.params;
    const { deleteFiles } = request.query;

    // Fetch book once for file deletion + event snapshot
    const book = await deps.bookService.getById(id);

    // If deleteFiles requested, delete from disk BEFORE cancelling downloads or removing DB record
    if (deleteFiles === 'true') {
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      if (book.path) {
        try {
          const librarySettings = await deps.settingsService.get('library');
          await deps.bookService.deleteBookFiles(book.path, librarySettings.path);
        } catch (error: unknown) {
          if (error instanceof PathOutsideLibraryError) {
            request.log.warn({ bookId: id, error: serializeError(error) }, 'Refused book file deletion: path outside library root');
            return reply.status(400).send({ error: error.message });
          }
          request.log.error({ bookId: id, error: serializeError(error) }, 'Failed to delete book files');
          return reply.status(500).send({ error: 'Failed to delete book files from disk' });
        }
      }
    }

    // Cancel any active downloads for this book
    const activeDownloads = await deps.downloadService.getActiveByBookId(id);
    for (const download of activeDownloads) {
      try {
        await deps.downloadOrchestrator.cancel(download.id);
      } catch (error: unknown) {
        request.log.warn({ downloadId: download.id, error: serializeError(error) }, 'Failed to cancel download during book deletion');
      }
    }
    if (activeDownloads.length > 0) {
      request.log.info({ bookId: id, count: activeDownloads.length }, 'Cancelled active downloads for book');
    }

    // Record deleted event before DB deletion (snapshot preserved via event fields)
    if (book && deps.eventHistory) {
      deps.eventHistory.create({
        bookId: id,
        ...snapshotBookForEvent(book),
        eventType: 'deleted',
        source: 'manual',
      }).catch((err) => request.log.warn({ error: serializeError(err) }, 'Failed to record deleted event'));
    }

    const deleted = await deps.bookService.delete(id);

    if (!deleted) {
      return reply.status(404).send({ error: 'Book not found' });
    }

    // Clean up cached cover after successful DB delete (best-effort)
    cleanCoverCache(id, config.configPath, request.log).catch((error: unknown) => {
      request.log.warn({ bookId: id, error: serializeError(error) }, 'Failed to clean cover cache during deletion');
    });

    request.log.info({ id, deleteFiles }, 'Book deleted');
    return { success: true };
});
}

function registerSeriesRoutes(app: FastifyInstance, bookService: BookService, seriesRefreshService: SeriesRefreshService) {
  app.get<{ Params: IdParam }>(
    '/api/books/:id/series',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const book = await bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }
      const card = await seriesRefreshService.getSeriesForBook(id);
      return { series: card };
    },
  );

  app.post<{ Params: IdParam }>(
    '/api/books/:id/series/refresh',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const book = await bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }
      if (!book.asin) {
        return reply.status(400).send({ error: 'Book has no ASIN — cannot refresh series from provider' });
      }
      const response = await seriesRefreshService.reconcileFromBookAsin(book.asin, {
        manual: true,
        bookId: book.id,
        seriesName: book.seriesName ?? null,
      });
      return response;
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

function registerBookSearchRoute(app: FastifyInstance, deps: Pick<BookRouteDeps, 'bookService' | 'downloadOrchestrator' | 'settingsService' | 'indexerSearchService' | 'blacklistService' | 'eventBroadcaster'>) {
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
      const result = await searchAndGrabForBook(
        book,
        deps.indexerSearchService!,
        deps.downloadOrchestrator,
        { ...qualitySettings, languages: metadataSettings.languages, narratorPriority },
        request.log,
        deps.blacklistService!,
        deps.eventBroadcaster,
      );
      if (result.result === 'grab_error') {
        throw result.error;
      }
      return result;
    },
  );
}

export async function booksRoutes(app: FastifyInstance, deps: BookRouteDeps) {
  const { bookService, bookListService, renameService, mergeService, taggingService, indexerSearchService } = deps;
  // GET /api/books
  app.get<{ Querystring: BooksListQuery }>(
    '/api/books',
    { schema: { querystring: booksListQuerySchema } },
    async (request) => {
      const { status, search, sortField, sortDirection, limit, offset } = request.query;
      request.log.debug({ status, search, sortField, limit, offset }, 'Fetching books');
      const pagination = { limit: limit ?? DEFAULT_LIMITS.books, ...(offset !== undefined && { offset }) };
      return bookListService.getAll(status, pagination, { slim: true, ...(search !== undefined && { search }), ...(sortField !== undefined && { sortField }), ...(sortDirection !== undefined && { sortDirection }) });
    },
  );

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

  // POST /api/books
  app.post<{ Body: CreateBookBody }>(
    '/api/books',
    { schema: { body: createBookBodySchema } },
    async (request, reply) => {
      const body = request.body;

      // Check for duplicates
      const existing = await bookService.findDuplicate(body.title, body.authors, body.asin);
      if (existing) {
        request.log.info({ title: body.title, existingId: existing.id }, 'Duplicate book detected');
        return reply.status(409).send(existing);
      }

      const book = await bookService.create(body);

      // Record book_added event (fire-and-forget)
      if (deps.eventHistory) {
        deps.eventHistory.create({
          bookId: book.id,
          ...snapshotBookForEvent(book),
          eventType: 'book_added',
          source: 'manual',
        }).catch((err: unknown) => request.log.warn({ error: serializeError(err) }, 'Failed to record book_added event'));
      }

      request.log.info({ title: body.title }, 'Book added');

      // Fire-and-forget: trigger search if searchImmediately is set
      if (body.searchImmediately && book.status === 'wanted' && indexerSearchService && deps.blacklistService) {
        const { downloadOrchestrator, settingsService, blacklistService, eventBroadcaster } = deps;
        triggerImmediateSearch(book, { indexerSearchService, downloadOrchestrator, settingsService, blacklistService, eventBroadcaster }, request.log);
      }

      // Fire-and-forget: enqueue series refresh when the new book has the
      // identity needed to seed the cache (book ASIN + series metadata). The
      // synchronous series-row upsert happened in bookService.create — this
      // pulls same-series members asynchronously so the card populates. (F2)
      if (deps.seriesRefreshService && book.asin && book.seriesName) {
        deps.seriesRefreshService.enqueueRefresh(book.asin, {
          bookId: book.id,
          seriesName: book.seriesName,
          ...(body.seriesAsin !== undefined && { providerSeriesId: body.seriesAsin }),
        });
      }

      return reply.status(201).send(book);
    },
  );

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

      request.log.info({ id }, 'Book updated');
      return book;
    },
  );

  await registerDeleteMissingRoute(app, deps);
  await registerDeleteBookRoute(app, deps);
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

  if (indexerSearchService) {
    registerBookSearchRoute(app, deps);
  }

  // POST /api/books/:id/retag
  app.post<{ Params: IdParam }>(
    '/api/books/:id/retag',
    { schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params;
      const result = await taggingService.retagBook(id);
      request.log.info({ id, tagged: result.tagged, skipped: result.skipped, failed: result.failed }, 'Book re-tagged');
      return result;
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

  if (deps.seriesRefreshService) {
    registerSeriesRoutes(app, deps.bookService, deps.seriesRefreshService);
  }

  // POST /api/books/:id/merge-to-m4b
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

  // DELETE /api/books/:id/merge-to-m4b (cancel merge)
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

  // POST /api/books/:id/wrong-release
  if (deps.bookRejectionService) {
    const bookRejectionService = deps.bookRejectionService;
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
}
