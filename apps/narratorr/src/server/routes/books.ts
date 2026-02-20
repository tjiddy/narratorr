import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { BookService, DownloadService } from '../services';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.m4b', '.flac', '.ogg', '.opus', '.wma', '.aac']);

interface CreateBookBody {
  title: string;
  authorName?: string;
  authorAsin?: string;
  narrator?: string;
  description?: string;
  coverUrl?: string;
  asin?: string;
  isbn?: string;
  seriesName?: string;
  seriesPosition?: number;
  duration?: number;
  publishedDate?: string;
  genres?: string[];
  providerId?: string;
}

interface UpdateBookBody {
  title?: string;
  narrator?: string;
  description?: string;
  coverUrl?: string;
  status?: 'wanted' | 'searching' | 'downloading' | 'imported' | 'missing';
}

export async function booksRoutes(app: FastifyInstance, bookService: BookService, downloadService: DownloadService) {
  // GET /api/books
  app.get('/api/books', async (request, reply) => {
    try {
      const { status } = request.query as { status?: string };
      request.log.debug({ status }, 'Fetching books');
      return bookService.getAll(status);
    } catch (error) {
      request.log.error(error, 'Failed to fetch books');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // GET /api/books/:id
  app.get<{ Params: { id: string } }>('/api/books/:id', async (request, reply) => {
    try {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) {
        return reply.status(400).send({ error: 'Invalid ID' });
      }

      const book = await bookService.getById(id);

      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      return book;
    } catch (error) {
      request.log.error(error, 'Failed to fetch book');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // POST /api/books
  app.post<{ Body: CreateBookBody }>('/api/books', async (request, reply) => {
    try {
      const { title, authorName, authorAsin, narrator, description, coverUrl,
              asin, isbn, seriesName, seriesPosition, duration, publishedDate, genres, providerId } = request.body;

      if (!title) {
        return reply.status(400).send({ error: 'Title is required' });
      }

      // Check for duplicates
      const existing = await bookService.findDuplicate(title, authorName, asin);
      if (existing) {
        request.log.info({ title, existingId: existing.id }, 'Duplicate book detected');
        return reply.status(409).send(existing);
      }

      const book = await bookService.create({
        title,
        authorName,
        authorAsin,
        narrator,
        description,
        coverUrl,
        asin,
        isbn,
        seriesName,
        seriesPosition,
        duration,
        publishedDate,
        genres,
        providerId,
      });

      request.log.info({ title }, 'Book added');
      return reply.status(201).send(book);
    } catch (error) {
      request.log.error(error, 'Failed to create book');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // PUT /api/books/:id
  app.put<{ Params: { id: string }; Body: UpdateBookBody }>(
    '/api/books/:id',
    async (request, reply) => {
      try {
        const id = parseInt(request.params.id, 10);
        if (isNaN(id)) {
          return reply.status(400).send({ error: 'Invalid ID' });
        }

        const book = await bookService.update(id, request.body);

        if (!book) {
          return reply.status(404).send({ error: 'Book not found' });
        }

        request.log.info({ id }, 'Book updated');
        return book;
      } catch (error) {
        request.log.error(error, 'Failed to update book');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // GET /api/books/:id/cover — serve embedded cover art from library
  app.get<{ Params: { id: string } }>('/api/books/:id/cover', async (request, reply) => {
    try {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) {
        return reply.status(400).send({ error: 'Invalid ID' });
      }

      const book = await bookService.getById(id);
      if (!book || !book.path) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      // Find cover file in book directory
      const entries = await readdir(book.path);
      const coverFile = entries.find(f => /^cover\.(jpg|jpeg|png|webp)$/i.test(f));
      if (!coverFile) {
        return reply.status(404).send({ error: 'No cover image' });
      }

      const mime = coverFile.endsWith('.png') ? 'image/png'
        : coverFile.endsWith('.webp') ? 'image/webp'
        : 'image/jpeg';

      const data = await readFile(join(book.path, coverFile));
      return reply
        .header('Content-Type', mime)
        .header('Cache-Control', 'public, max-age=86400')
        .send(data);
    } catch (error) {
      request.log.error(error, 'Failed to serve cover image');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // DELETE /api/books/:id
  app.delete<{ Params: { id: string } }>('/api/books/:id', async (request, reply) => {
    try {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) {
        return reply.status(400).send({ error: 'Invalid ID' });
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
        return reply.status(404).send({ error: 'Book not found' });
      }

      request.log.info({ id }, 'Book deleted');
      return { success: true };
    } catch (error) {
      request.log.error(error, 'Failed to delete book');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });
}

export async function bookFilesRoute(app: FastifyInstance, bookService: BookService) {
  app.get<{ Params: { id: string } }>('/api/books/:id/files', async (request, reply) => {
    try {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) {
        return reply.status(400).send({ error: 'Invalid ID' });
      }

      const book = await bookService.getById(id);
      if (!book || !book.path) {
        return reply.status(404).send({ error: 'Book not found' });
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
  });
}
