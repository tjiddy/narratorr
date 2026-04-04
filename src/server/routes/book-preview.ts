import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';
import type { BookService } from '../services/index.js';
import { idParamSchema } from '../../shared/schemas/common.js';
import type { z } from 'zod';

type IdParam = z.infer<typeof idParamSchema>;

const AUDIO_MIME_MAP: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4b': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.aac': 'audio/aac',
};

function getAudioMimeType(ext: string): string {
  return AUDIO_MIME_MAP[ext] ?? 'application/octet-stream';
}

function parseRangeHeader(rangeHeader: string, fileSize: number): { start: number; end: number } {
  const match = /bytes=(-?\d*)-(\d*)/.exec(rangeHeader);
  if (!match) return { start: -1, end: -1 };

  const [, rawStart, rawEnd] = match;

  // Suffix range: bytes=-500 (last 500 bytes)
  if (rawStart === '') {
    const suffixLen = parseInt(rawEnd, 10);
    const start = Math.max(0, fileSize - suffixLen);
    return { start, end: fileSize - 1 };
  }

  // Negative start: bytes=-500
  if (rawStart.startsWith('-')) {
    const suffixLen = parseInt(rawStart.slice(1), 10);
    const start = Math.max(0, fileSize - suffixLen);
    return { start, end: fileSize - 1 };
  }

  const start = parseInt(rawStart, 10);
  const end = rawEnd === '' ? fileSize - 1 : parseInt(rawEnd, 10);

  // Invalid: start beyond file size or end < start
  if (start >= fileSize || end < start) {
    return { start: -1, end: -1 };
  }

  return { start, end: Math.min(end, fileSize - 1) };
}

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

      let entries: string[];
      try {
        entries = await readdir(book.path);
      } catch {
        request.log.warn({ bookId: id, path: book.path }, 'Could not read book directory for preview');
        return reply.status(404).send({ error: 'Audio file not found' });
      }

      const audioFiles = entries
        .filter(f => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

      if (audioFiles.length === 0) {
        return reply.status(404).send({ error: 'Audio file not found' });
      }

      const filename = audioFiles[0];
      const filePath = join(book.path, filename);

      let fileSize: number;
      try {
        const fileStat = await stat(filePath);
        fileSize = fileStat.size;
      } catch {
        request.log.warn({ bookId: id, path: filePath }, 'Audio file not accessible for preview');
        return reply.status(404).send({ error: 'Audio file not found' });
      }

      const mime = getAudioMimeType(extname(filename).toLowerCase());

      const rangeHeader = request.headers.range;
      if (!rangeHeader) {
        const stream = createReadStream(filePath);
        return reply
          .status(200)
          .header('Content-Type', mime)
          .header('Content-Length', fileSize)
          .header('Accept-Ranges', 'bytes')
          .send(stream);
      }

      // Multi-range not supported — fall back to full file
      if (rangeHeader.includes(',')) {
        const stream = createReadStream(filePath);
        return reply
          .status(200)
          .header('Content-Type', mime)
          .header('Content-Length', fileSize)
          .header('Accept-Ranges', 'bytes')
          .send(stream);
      }

      const { start, end } = parseRangeHeader(rangeHeader, fileSize);
      if (start === -1) {
        return reply
          .status(416)
          .header('Content-Range', `bytes */${fileSize}`)
          .send();
      }

      const contentLength = end - start + 1;
      const stream = createReadStream(filePath, { start, end });
      return reply
        .status(206)
        .header('Content-Type', mime)
        .header('Content-Length', contentLength)
        .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
        .header('Accept-Ranges', 'bytes')
        .send(stream);
    },
  );
}
