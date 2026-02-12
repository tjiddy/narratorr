import type { FastifyInstance } from 'fastify';
import type { BookService } from '../services';

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
}

interface UpdateBookBody {
  title?: string;
  narrator?: string;
  description?: string;
  coverUrl?: string;
  status?: 'wanted' | 'searching' | 'downloading' | 'imported' | 'missing';
}

export async function booksRoutes(app: FastifyInstance, bookService: BookService) {
  // GET /api/books
  app.get('/api/books', async (request) => {
    const { status } = request.query as { status?: string };
    return bookService.getAll(status);
  });

  // GET /api/books/:id
  app.get<{ Params: { id: string } }>('/api/books/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const book = await bookService.getById(id);

    if (!book) {
      return reply.status(404).send({ error: 'Book not found' });
    }

    return book;
  });

  // POST /api/books
  app.post<{ Body: CreateBookBody }>('/api/books', async (request, reply) => {
    const { title, authorName, authorAsin, narrator, description, coverUrl,
            asin, isbn, seriesName, seriesPosition, duration, publishedDate, genres } = request.body;

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
    });

    request.log.info({ title }, 'Book added');
    return reply.status(201).send(book);
  });

  // PUT /api/books/:id
  app.put<{ Params: { id: string }; Body: UpdateBookBody }>(
    '/api/books/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const book = await bookService.update(id, request.body);

      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      request.log.debug({ id }, 'Book updated');
      return book;
    }
  );

  // DELETE /api/books/:id
  app.delete<{ Params: { id: string } }>('/api/books/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const deleted = await bookService.delete(id);

    if (!deleted) {
      return reply.status(404).send({ error: 'Book not found' });
    }

    request.log.info({ id }, 'Book deleted');
    return { success: true };
  });
}
