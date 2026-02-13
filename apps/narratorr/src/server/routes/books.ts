import type { FastifyInstance } from 'fastify';
import type { BookService, DownloadService, MetadataService } from '../services';

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

export async function booksRoutes(app: FastifyInstance, bookService: BookService, downloadService: DownloadService, metadataService: MetadataService) {
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

      // Enrich with ASIN from metadata provider if missing
      let enrichedAsin = asin;
      if (!enrichedAsin && providerId) {
        try {
          const detail = await metadataService.getBook(providerId);
          if (detail?.asin) {
            enrichedAsin = detail.asin;
            request.log.info({ title, providerId, asin: enrichedAsin }, 'Enriched book with ASIN from provider');
          }
        } catch (error) {
          request.log.warn({ error, providerId }, 'ASIN enrichment failed');
        }
      }

      const book = await bookService.create({
        title,
        authorName,
        authorAsin,
        narrator,
        description,
        coverUrl,
        asin: enrichedAsin,
        isbn,
        seriesName,
        seriesPosition,
        duration,
        publishedDate,
        genres,
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
