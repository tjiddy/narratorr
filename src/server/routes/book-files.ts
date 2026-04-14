import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { serveCoverFromCache, COVER_FILE_REGEX } from '../utils/cover-cache.js';
import { config } from '../config.js';
import { MAX_COVER_SIZE } from '../../shared/constants.js';
import type { BookService } from '../services/index.js';
import { type z } from 'zod';
import { idParamSchema } from '../../shared/schemas.js';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';

type IdParam = z.infer<typeof idParamSchema>;

export async function bookFilesRoute(app: FastifyInstance, bookService: BookService) {
  // GET /api/books/:id/cover — serve embedded cover art from library
  app.get<{ Params: IdParam }>(
    '/api/books/:id/cover',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      const book = await bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      // Try book directory first (primary source)
      if (book.path) {
        const entries = await readdir(book.path);
        const coverFile = entries.find(f => COVER_FILE_REGEX.test(f));
        if (coverFile) {
          const mime = coverFile.endsWith('.png') ? 'image/png'
            : coverFile.endsWith('.webp') ? 'image/webp'
            : 'image/jpeg';
          const data = await readFile(join(book.path, coverFile));
          return reply
            .header('Content-Type', mime)
            .header('Cache-Control', 'public, max-age=86400')
            .send(data);
        }
      }

      // Fall back to cover cache (e.g. after wrong-release preserved the cover)
      if (book.coverUrl) {
        const cached = await serveCoverFromCache(id, config.configPath);
        if (cached) {
          return reply
            .header('Content-Type', cached.mime)
            .header('Cache-Control', 'public, max-age=86400')
            .send(cached.data);
        }
      }

      return reply.status(404).send({ error: 'No cover image' });
    },
  );

  // POST /api/books/:id/cover — upload custom cover art
  app.post<{ Params: IdParam }>(
    '/api/books/:id/cover',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      const data = await request.file();
      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      const buffer = await data.toBuffer();

      if (buffer.length > MAX_COVER_SIZE) {
        return reply.status(400).send({ error: 'Cover image must be under 10 MB' });
      }

      const mimeType = data.mimetype;

      const book = await bookService.uploadCover(id, buffer, mimeType);
      request.log.info({ id }, 'Cover uploaded');
      return book;
    },
  );

  app.get<{ Params: IdParam }>(
    '/api/books/:id/files',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

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
    },
  );

}
