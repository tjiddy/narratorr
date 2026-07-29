import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CompanionOpenResult } from '../services/companion-ebook-open.js';
import { serializeError } from './serialize-error.js';

/**
 * Shared companion-ebook streaming (#1975 AC12 — extracted verbatim from
 * `routes/companion-ebook.ts`, where #1974 landed it as a module-private function).
 *
 * It lives in `utils/` because BOTH the owner route (`GET /api/books/:id/companion-epub`) and
 * the public v1 route (`GET /api/v1/books/:publicId/companion-epub`) stream through it, and the
 * v1 route cannot live in the owner module — it needs its own encapsulated plugin with
 * `v1ErrorHandler` under the `/api/v1` prefix. Copying instead of extracting would guarantee
 * the two exactly-once close paths drift, and the close shape below is the one thing in this
 * feature that cost a whole investigation (#1981) to get right.
 *
 * `import type` only from `services/` — the utils layer boundary (`eslint.config.js`) forbids
 * importing service *values*, and this module needs none.
 */

/** Options a caller can hang on the exactly-once teardown. */
export interface CompanionStreamOptions {
  /**
   * Invoked from INSIDE the idempotent `release()` closure (#1975 AC13), so it fires exactly
   * once per response on the `end`, `error`, and client-abort paths alike. #1975 uses it to
   * return a semaphore slot. (Since #1984 the slot token is itself single-use, so a duplicate
   * call is harmless at the Semaphore too — this closure's exactly-once guarantee is about the
   * stream teardown as a whole, not just the slot.)
   */
  onTeardown?: () => void;
}

/**
 * Stream an open companion handle with exactly-once cleanup (#1974 AC18-AC22).
 *
 * The stream is created with **`autoClose: false`** and ONE idempotent application-owned
 * closer is wired to stream `end`, stream `error`, and response `close` (which covers a client
 * abort). Node 24 documents `autoClose: true` as the default for
 * `filehandle.createReadStream()`, so layering close handling on top of the default is exactly
 * how a double close appears; with it off, nothing tears the stream down implicitly and
 * teardown happens if and only if `release` runs.
 *
 * **`release` destroys the stream rather than calling `handle.close()`, and that is
 * load-bearing.** Measured on Node 24.18: a FileHandle-backed `ReadStream` registers itself on
 * the handle's `close` event, so an application `handle.close()` destroys the stream, whose
 * `_destroy` then closes the handle a SECOND time — two `close()` calls on both the `end` and
 * the abort path. Destroying the stream closes the underlying handle exactly once on every
 * path. (`autoClose` only governs whether the stream self-destroys at `end`; an explicit
 * `destroy()` closes the fd either way.)
 */
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
    // The route-boundary record: `{ bookId, outcome }` and nothing else — no path, no
    // filename, no library root. These survive at default level and get pasted into bug
    // reports, and the v1 caller of this helper IS API-key reachable.
    request.log.warn({ bookId, outcome: 'stream_error' }, 'Companion ebook stream failed');
    release();
    // `error-handler.ts` ends in an unconditional `reply.status(500).send(...)` with no
    // `headersSent` check, so letting it run here would append a JSON body to a response that
    // already committed to `200` + `Content-Length` — a truncated body under a success status.
    // Contained locally: destroying the socket is the only honest signal left. (#1975 adds the
    // same guard to `v1ErrorHandler`; the two are independent — Fastify's `sendStream` never
    // routes a post-headers stream error into an error handler at all.)
    if (reply.raw.headersSent && !reply.raw.writableEnded) reply.raw.socket?.destroy();
  });
  reply.raw.once('close', release);

  // The existing sanitize idiom (`routes/system.ts`), so a comma, a space, or a non-ASCII
  // character in the stored basename cannot break out of the quoted header value.
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '-');

  return reply
    .status(200)
    .header('Content-Type', 'application/epub+zip')
    // `fstat.size` from the OPEN handle, never `companion_ebooks.size_bytes` — the stored
    // value is a stale observation and a divergence would truncate or hang the response.
    .header('Content-Length', opened.sizeBytes)
    .header('Cache-Control', 'private, no-store')
    .header('Content-Disposition', `attachment; filename="${safeFilename}"`)
    .send(stream);
}
