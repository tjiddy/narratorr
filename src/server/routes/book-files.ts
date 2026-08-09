import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { serveCoverFromCache, COVER_FILE_REGEX } from '../utils/cover-cache.js';
import { config } from '../config.js';
import { MAX_COVER_SIZE } from '@shared/constants.js';
import type { BookService, SettingsService, ConnectorService } from '../services/index.js';
import { type z } from 'zod';
import { idParamSchema } from '@shared/schemas.js';
import { collectAudioFilePaths } from '@core/utils/collect-audio-files.js';
import { refreshOpfForBook } from '../utils/opf-refresh.js';
import { enqueueBookRefresh } from '../utils/enqueue-book-refresh.js';

type IdParam = z.infer<typeof idParamSchema>;

export async function bookFilesRoute(app: FastifyInstance, bookService: BookService, settingsService: SettingsService, connectorService?: ConnectorService) {
  app.get<{ Params: IdParam }>(
    '/api/books/:id/cover',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      const book = await bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

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

  app.post<{ Params: IdParam }>(
    '/api/books/:id/cover',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;

      // Override the global 500 MB restore limit so busboy rejects covers before buffering.
      const data = await request.file({ limits: { fileSize: MAX_COVER_SIZE } });
      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      let buffer: Buffer;
      try {
        buffer = await data.toBuffer();
      } catch (error: unknown) {
        // Multipart's size error is not globally registered and would otherwise become a 500.
        if (error instanceof Error && (error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.status(400).send({ error: 'Cover image must be under 10 MB' });
        }
        throw error;
      }

      const mimeType = data.mimetype;

      // coverOutcome stays 'written' after the rename even if the later DB update fails.
      const { book, coverOutcome } = await bookService.uploadCover(id, buffer, mimeType);

      // The OPF has no cover reference; refresh only to keep the sidecar otherwise current.
      const opfOutcome = await refreshOpfForBook({
        settingsService,
        bookService,
        bookId: id,
        bookFolder: book.path ?? null,
        log: request.log,
      });

      // A post-rename DB failure still counts as a cover write for connector refresh.
      if (coverOutcome === 'written' || opfOutcome === 'written') {
        enqueueBookRefresh(connectorService, request.log, 'metadata', {
          bookId: id, title: book.title, authorName: book.authors?.[0]?.name ?? null, libraryPath: book.path!,
        });
      }

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

      let audioPaths: string[];
      try {
        audioPaths = await collectAudioFilePaths(book.path, { recursive: true, skipHidden: true });
      } catch {
        request.log.warn({ bookId: id, path: book.path }, 'Could not read book directory');
        return [];
      }

      const bookPath = book.path;
      const files = await Promise.all(
        audioPaths.map(async (fullPath) => {
          const info = await stat(fullPath);
          // Preserve disc paths and normalize Windows separators for consistent display.
          const name = relative(bookPath, fullPath).split('\\').join('/');
          return { name, size: info.size };
        })
      );

      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

      request.log.debug({ bookId: id, fileCount: files.length }, 'Listed book files');
      return files;
    },
  );

}
