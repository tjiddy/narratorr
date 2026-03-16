import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { BookService, DownloadService, SettingsService, RenameService, EventHistoryService, TaggingService, IndexerService, RecyclingBinService } from '../services/index.js';

export interface BookRouteDeps {
  bookService: BookService;
  downloadService: DownloadService;
  settingsService: SettingsService;
  renameService: RenameService;
  taggingService: TaggingService;
  eventHistory?: EventHistoryService;
  indexerService?: IndexerService;
  recyclingBinService?: RecyclingBinService;
}
import { searchAndGrabForBook } from '../services/search-pipeline.js';
import { type z } from 'zod';
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

import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';

/** Fire-and-forget: search indexers and grab the best result for a newly added book. */
function triggerImmediateSearch(
  book: { id: number; title: string; duration?: number | null; author?: { name: string } | null },
  deps: Pick<BookRouteDeps, 'indexerService' | 'downloadService' | 'settingsService'>,
  log: FastifyBaseLogger,
) {
  deps.settingsService.get('quality')
    .then(async (qualitySettings) => {
      await searchAndGrabForBook(book, deps.indexerService!, deps.downloadService, qualitySettings, log);
    })
    .catch((err) => {
      log.warn({ error: err, bookId: book.id }, 'Search-immediately trigger failed');
    });
}

async function registerDeleteBookRoute(app: FastifyInstance, deps: Pick<BookRouteDeps, 'bookService' | 'downloadService' | 'settingsService' | 'eventHistory' | 'recyclingBinService'>) {
app.delete<{ Params: IdParam; Querystring: DeleteBookQuery }>(
  '/api/books/:id',
  { schema: { params: idParamSchema, querystring: deleteBookQuerySchema } },
  async (request, reply) => {
  try {
    const { id } = request.params;
    const { deleteFiles } = request.query;

    // Fetch book once for file deletion + event snapshot
    const book = await deps.bookService.getById(id);

    // If deleteFiles requested, move to recycling bin BEFORE cancelling downloads or removing DB record
    if (deleteFiles === 'true') {
      if (!book) {
        return await reply.status(404).send({ error: 'Book not found' });
      }

      if (deps.recyclingBinService) {
        try {
          await deps.recyclingBinService.moveToRecycleBin(book, book.path);
        } catch (error) {
          request.log.error({ bookId: id, error }, 'Failed to move book to recycling bin');
          return await reply.status(500).send({ error: 'Failed to move book files to recycling bin' });
        }
      } else if (book.path) {
        try {
          const librarySettings = await deps.settingsService.get('library');
          await deps.bookService.deleteBookFiles(book.path, librarySettings.path);
        } catch (error) {
          request.log.error({ bookId: id, error }, 'Failed to delete book files');
          return await reply.status(500).send({ error: 'Failed to delete book files from disk' });
        }
      }
    }

    // Cancel any active downloads for this book
    const activeDownloads = await deps.downloadService.getActiveByBookId(id);
    for (const download of activeDownloads) {
      try {
        await deps.downloadService.cancel(download.id);
      } catch (error) {
        request.log.warn({ downloadId: download.id, error }, 'Failed to cancel download during book deletion');
      }
    }
    if (activeDownloads.length > 0) {
      request.log.info({ bookId: id, count: activeDownloads.length }, 'Cancelled active downloads for book');
    }

    // Record deleted event before DB deletion (snapshot preserved via event fields)
    if (book && deps.eventHistory) {
      deps.eventHistory.create({
        bookId: id,
        bookTitle: book.title,
        authorName: book.author?.name,
        eventType: 'deleted',
        source: 'manual',
      }).catch((err) => request.log.warn(err, 'Failed to record deleted event'));
    }

    const deleted = await deps.bookService.delete(id);

    if (!deleted) {
      return await reply.status(404).send({ error: 'Book not found' });
    }

    request.log.info({ id, deleteFiles }, 'Book deleted');
    return { success: true };
  } catch (error) {
    request.log.error(error, 'Failed to delete book');
    return reply.status(500).send({ error: 'Internal server error' });
  }
});
}

async function registerDeleteMissingRoute(app: FastifyInstance, deps: Pick<BookRouteDeps, 'bookService'>) {
  app.delete('/api/books/missing', async (request, reply) => {
    try {
      const deleted = await deps.bookService.deleteByStatus('missing');
      request.log.info({ deleted }, 'Batch deleted missing books');
      return { deleted };
    } catch (error) {
      request.log.error(error, 'Failed to batch delete missing books');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

function registerBookSearchRoute(app: FastifyInstance, deps: Pick<BookRouteDeps, 'bookService' | 'downloadService' | 'settingsService' | 'indexerService'>) {
  app.post<{ Params: IdParam }>(
    '/api/books/:id/search',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const book = await deps.bookService.getById(id);
        if (!book) {
          return await reply.status(404).send({ error: 'Book not found' });
        }

        const qualitySettings = await deps.settingsService.get('quality');
        const result = await searchAndGrabForBook(
          book,
          deps.indexerService!,
          deps.downloadService,
          qualitySettings,
          request.log,
        );
        if (result.result === 'grab_error') {
          throw result.error;
        }
        return result;
      } catch (error) {
        request.log.error(error, 'Per-book search failed');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );
}

export async function booksRoutes(app: FastifyInstance, deps: BookRouteDeps) {
  const { bookService, renameService, taggingService, indexerService } = deps;
  // GET /api/books
  app.get<{ Querystring: BooksListQuery }>(
    '/api/books',
    { schema: { querystring: booksListQuerySchema } },
    async (request, reply) => {
      try {
        const { status, search, sortField, sortDirection, limit, offset } = request.query;
        request.log.debug({ status, search, sortField, limit, offset }, 'Fetching books');
        const pagination = { limit: limit ?? DEFAULT_LIMITS.books, offset };
        return await bookService.getAll(status, pagination, { slim: true, search, sortField, sortDirection });
      } catch (error) {
        request.log.error(error, 'Failed to fetch books');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // GET /api/books/identifiers — lightweight list for duplicate detection (no pagination)
  app.get('/api/books/identifiers', async (request, reply) => {
    try {
      return await bookService.getIdentifiers();
    } catch (error) {
      request.log.error(error, 'Failed to fetch book identifiers');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /api/books/stats — server-side status counts and filter values
  app.get('/api/books/stats', async (request, reply) => {
    try {
      return await bookService.getStats();
    } catch (error) {
      request.log.error(error, 'Failed to fetch book stats');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /api/books/:id
  app.get<{ Params: IdParam }>(
    '/api/books/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const book = await bookService.getById(id);

        if (!book) {
          return await reply.status(404).send({ error: 'Book not found' });
        }

        return book;
      } catch (error) {
        request.log.error(error, 'Failed to fetch book');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // POST /api/books
  app.post<{ Body: CreateBookBody }>(
    '/api/books',
    { schema: { body: createBookBodySchema } },
    async (request, reply) => {
      try {
        const body = request.body;

        // Check for duplicates
        const existing = await bookService.findDuplicate(body.title, body.authorName, body.asin);
        if (existing) {
          request.log.info({ title: body.title, existingId: existing.id }, 'Duplicate book detected');
          return await reply.status(409).send(existing);
        }

        const book = await bookService.create(body);

        request.log.info({ title: body.title }, 'Book added');

        // Fire-and-forget: trigger search if searchImmediately is set
        if (body.searchImmediately && book.status === 'wanted' && indexerService) {
          triggerImmediateSearch(book, deps, request.log);
        }

        return await reply.status(201).send(book);
      } catch (error) {
        request.log.error(error, 'Failed to create book');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  // PUT /api/books/:id
  app.put<{ Params: IdParam; Body: UpdateBookBody }>(
    '/api/books/:id',
    { schema: { params: idParamSchema, body: updateBookBodySchema } },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const body = request.body;

        const book = await bookService.update(id, body);

        if (!book) {
          return await reply.status(404).send({ error: 'Book not found' });
        }

        request.log.info({ id }, 'Book updated');
        return book;
      } catch (error) {
        request.log.error(error, 'Failed to update book');
        return reply.status(500).send({ error: 'Internal server error' });
      }
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

  if (indexerService) {
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
}

export async function bookFilesRoute(app: FastifyInstance, bookService: BookService) {
  // GET /api/books/:id/cover — serve embedded cover art from library
  app.get<{ Params: IdParam }>(
    '/api/books/:id/cover',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      try {
        const { id } = request.params;

        const book = await bookService.getById(id);
        if (!book || !book.path) {
          return await reply.status(404).send({ error: 'Book not found' });
        }

        // Find cover file in book directory
        const entries = await readdir(book.path);
        const coverFile = entries.find(f => /^cover\.(jpg|jpeg|png|webp)$/i.test(f));
        if (!coverFile) {
          return await reply.status(404).send({ error: 'No cover image' });
        }

        const mime = coverFile.endsWith('.png') ? 'image/png'
          : coverFile.endsWith('.webp') ? 'image/webp'
          : 'image/jpeg';

        const data = await readFile(join(book.path, coverFile));
        return await reply
          .header('Content-Type', mime)
          .header('Cache-Control', 'public, max-age=86400')
          .send(data);
      } catch (error) {
        request.log.error(error, 'Failed to serve cover image');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

  app.get<{ Params: IdParam }>(
    '/api/books/:id/files',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      try {
        const { id } = request.params;

        const book = await bookService.getById(id);
        if (!book || !book.path) {
          return await reply.status(404).send({ error: 'Book not found' });
        }

        let entries: string[];
        try {
          entries = await readdir(book.path);
        } catch {
          request.log.warn({ bookId: id, path: book.path }, 'Could not read book directory');
          return [];
        }

        const audioFiles = entries.filter(f => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()));
        const files = await Promise.all(
          audioFiles.map(async (name) => {
            const info = await stat(join(book.path!, name));
            return { name, size: info.size };
          })
        );

        files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

        request.log.debug({ bookId: id, fileCount: files.length }, 'Listed book files');
        return files;
      } catch (error) {
        request.log.error(error, 'Failed to list book files');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );
}
