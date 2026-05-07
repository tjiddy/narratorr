import type { FastifyInstance } from 'fastify';
import type { BookService } from '../services/index.js';
import { idParamSchema } from '../../shared/schemas/common.js';
import { resolvePreviewAudioFile, streamAudioFile } from '../services/audio-preview-stream.js';
import type { z } from 'zod';

type IdParam = z.infer<typeof idParamSchema>;

export async function bookPreviewRoute(app: FastifyInstance, bookService: BookService) {
  app.get<{ Params: IdParam }>(
    '/api/books/:id/preview',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      const book = await bookService.getById(id);
      if (!book || !book.path) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      const audioPath = await resolvePreviewAudioFile(book.path);
      if (!audioPath) {
        request.log.warn({ bookId: id, path: book.path }, 'Audio file not found for book preview');
        return reply.status(404).send({ error: 'Audio file not found' });
      }

      return streamAudioFile(audioPath, request, reply);
    },
  );
}
