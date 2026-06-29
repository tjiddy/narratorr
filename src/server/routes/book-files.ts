import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { serveCoverFromCache, COVER_FILE_REGEX } from '../utils/cover-cache.js';
import { config } from '../config.js';
import { MAX_COVER_SIZE } from '../../shared/constants.js';
import type { BookService, SettingsService, ConnectorService } from '../services/index.js';
import { type z } from 'zod';
import { idParamSchema } from '../../shared/schemas.js';
import { collectAudioFilePaths } from '../../core/utils/collect-audio-files.js';
import { refreshOpfForBook } from '../utils/opf-refresh.js';
import { enqueueBookRefresh } from '../utils/enqueue-book-refresh.js';

type IdParam = z.infer<typeof idParamSchema>;

export async function bookFilesRoute(app: FastifyInstance, bookService: BookService, settingsService: SettingsService, connectorService?: ConnectorService) {
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

      // Cap the upload at MAX_COVER_SIZE via a per-request multipart limit so
      // busboy stops reading at the cap instead of inheriting the global 500MB
      // limit (set for restore uploads at index.ts). This rejects oversized
      // covers before buffering the full stream into memory.
      const data = await request.file({ limits: { fileSize: MAX_COVER_SIZE } });
      if (!data) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      let buffer: Buffer;
      try {
        buffer = await data.toBuffer();
      } catch (error: unknown) {
        // @fastify/multipart throws RequestFileTooLargeError (FST_REQ_FILE_TOO_LARGE)
        // when the per-request fileSize limit is exceeded. That class is not in
        // ERROR_REGISTRY, so letting it propagate would surface as 500; handle it here.
        if (error instanceof Error && (error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.status(400).send({ error: 'Cover image must be under 10 MB' });
        }
        throw error;
      }

      const mimeType = data.mimetype;

      // A pre-rename failure (unsupported MIME, rename error) still rejects here, keeping the
      // existing error response. `coverOutcome` is 'written' once the cover.* file committed —
      // even if the post-rename DB coverUrl update threw.
      const { book, coverOutcome } = await bookService.uploadCover(id, buffer, mimeType);

      // Refresh the OPF sidecar so it stays current with the DB after a cover change (gated on
      // tagging.writeOpf). The OPF embeds no cover reference — ABS reads the folder cover file — so
      // this keeps the sidecar generally fresh; nonfatal, never fails the upload response.
      const opfOutcome = await refreshOpfForBook({
        settingsService,
        bookService,
        bookId: id,
        bookFolder: book.path ?? null,
        log: request.log,
      });

      // Single aggregation point for this route's two possible media-visible writes (cover + OPF):
      // fire EXACTLY ONE 'metadata' refresh when either materialized, so the book is never pushed
      // twice for one upload. Fires off the cover write even with writeOpf off (OPF 'skipped'), and
      // off a post-rename cover DB failure (coverOutcome stays 'written'). Both skipped/failed → none.
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
        audioPaths = await collectAudioFilePaths(book.path, { recursive: true });
      } catch {
        request.log.warn({ bookId: id, path: book.path }, 'Could not read book directory');
        return [];
      }

      const bookPath = book.path;
      const files = await Promise.all(
        audioPaths.map(async (fullPath) => {
          const info = await stat(fullPath);
          // Display path is relative to the book folder so multi-disc rips show
          // `Disc 01/Track 03.mp3` instead of repeating `Track 03.mp3` 10 times.
          // Normalize to POSIX separators for consistent rendering — the app
          // runs in Docker, but local-Windows dev produces backslashes from
          // `path.relative()`.
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
