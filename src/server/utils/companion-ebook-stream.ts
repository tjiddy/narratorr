import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CompanionOpenResult } from '../services/companion-ebook-open.js';
import { serializeError } from './serialize-error.js';

// Shared by owner and v1 routes; the service import must remain type-only.

export interface CompanionStreamOptions {
  /** Called once by release on end, error, or client abort. */
  onTeardown?: () => void;
}

// release owns end/error/abort teardown. Keep autoClose false and destroy the stream rather
// than closing the handle: Node 24's FileHandle-backed _destroy closes it, so doing both
// double-closes the descriptor.
export function streamCompanionEbook(
  bookId: number,
  filename: string,
  opened: Extract<CompanionOpenResult, { outcome: 'ok' }>,
  request: FastifyRequest,
  reply: FastifyReply,
  options?: CompanionStreamOptions,
): FastifyReply {
  const stream = opened.handle.createReadStream({ autoClose: false });

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (!stream.destroyed) stream.destroy();
    options?.onTeardown?.();
  };

  stream.once('end', release);
  stream.once('error', (error: unknown) => {
    request.log.debug({ bookId, error: serializeError(error) }, 'Companion ebook stream error');
    // Route-boundary warnings record bookId/outcome only, never path or filename.
    request.log.warn({ bookId, outcome: 'stream_error' }, 'Companion ebook stream failed');
    release();
    // After headers commit, destroy the socket; an error handler cannot replace the response.
    if (reply.raw.headersSent && !reply.raw.writableEnded) reply.raw.socket?.destroy();
  });
  reply.raw.once('close', release);

  // Sanitize so the stored basename cannot break out of the quoted header value.
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '-');

  return reply
    .status(200)
    .header('Content-Type', 'application/epub+zip')
    // DB size may be stale; use the opened handle to avoid truncation or hanging.
    .header('Content-Length', opened.sizeBytes)
    .header('Cache-Control', 'private, no-store')
    .header('Content-Disposition', `attachment; filename="${safeFilename}"`)
    .send(stream);
}
