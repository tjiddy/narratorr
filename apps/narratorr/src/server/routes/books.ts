import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { BookService, DownloadService, SettingsService, RenameService } from '../services';
import { RenameError } from '../services/rename.service.js';
import { type z } from 'zod';
import {
  idParamSchema,
  bookListQuerySchema,
  createBookBodySchema,
  updateBookBodySchema,
  deleteBookQuerySchema,
  type BookListQuery,
  type CreateBookBody,
  type UpdateBookBody,
  type DeleteBookQuery,
} from '../../shared/schemas.js';

type IdParam = z.infer<typeof idParamSchema>;

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.m4b', '.flac', '.ogg', '.opus', '.wma', '.aac']);

async function registerDeleteBookRoute(app: FastifyInstance, bookService: BookService, downloadService: DownloadService, settingsService: SettingsService) {
app.delete<{ Params: IdParam; Querystring: DeleteBookQuery }>(
  '/api/books/:id',
  { schema: { params: idParamSchema, querystring: deleteBookQuerySchema } },
  async (request, reply) => {
  try {
    const { id } = request.params;
    const { deleteFiles } = request.query;

    // If deleteFiles requested, attempt file deletion BEFORE cancelling downloads or removing DB record
    if (deleteFiles === 'true') {
      const book = await bookService.getById(id);
      if (!book) {
        return await reply.status(404).send({ error: 'Book not found' });
      }

      if (book.path) {
        try {
          const librarySettings = await settingsService.get('library');
          await bookService.deleteBookFiles(book.path, librarySettings.path);
        } catch (error) {
          request.log.error({ bookId: id, error }, 'Failed to delete book files');
          return await reply.status(500).send({ error: 'Failed to delete book files from disk' });
        }
      }
    }

    // Cancel any active downloads for this book
    const activeDownloads = await downloadService.getActiveByBookId(id);
    for (const download of activeDownloads) {
      try {
        await downloadService.cancel(download.id);
      } catch (error) {
        request.log.warn({ downloadId: download.id, error }, 'Failed to cancel download during book deletion');
      }
    }
    if (activeDownloads.length > 0) {
      request.log.info({ bookId: id, count: activeDownloads.length }, 'Cancelled active downloads for book');
    }

    const deleted = await bookService.delete(id);

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

async function registerDeleteMissingRoute(app: FastifyInstance, bookService: BookService) {
  app.delete('/api/books/missing', async (request, reply) => {
    try {
      const deleted = await bookService.deleteByStatus('missing');
      request.log.info({ deleted }, 'Batch deleted missing books');
      return { deleted };
    } catch (error) {
      request.log.error(error, 'Failed to batch delete missing books');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

export async function booksRoutes(app: FastifyInstance, bookService: BookService, downloadService: DownloadService, settingsService: SettingsService, renameService: RenameService) {
  // GET /api/books
  app.get<{ Querystring: BookListQuery }>(
    '/api/books',
    { schema: { querystring: bookListQuerySchema } },
    async (request, reply) => {
      try {
        const { status } = request.query;
        request.log.debug({ status }, 'Fetching books');
        return await bookService.getAll(status);
      } catch (error) {
        request.log.error(error, 'Failed to fetch books');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    },
  );

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

  await registerDeleteMissingRoute(app, bookService);
  await registerDeleteBookRoute(app, bookService, downloadService, settingsService);
  // POST /api/books/:id/rename
  app.post<{ Params: IdParam }>(
    '/api/books/:id/rename',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      try {
        const { id } = request.params;

        const result = await renameService.renameBook(id);
        request.log.info({ id, oldPath: result.oldPath, newPath: result.newPath }, 'Book renamed');
        return result;
      } catch (error) {
        if (error instanceof RenameError) {
          const statusCode = error.code === 'NOT_FOUND' ? 404
            : error.code === 'NO_PATH' ? 400
            : error.code === 'CONFLICT' ? 409
            : 500;
          request.log.warn({ bookId: request.params.id, code: error.code }, `Rename rejected: ${error.message}`);
          return reply.status(statusCode).send({ error: error.message });
        }
        request.log.error(error, 'Failed to rename book');
        return reply.status(500).send({ error: 'Internal server error' });
      }
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
